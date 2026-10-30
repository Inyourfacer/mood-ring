// Sends the check-in reminder to every subscribed device. Run by .github/workflows/remind.yml.
//
// Each reminder time has two cron lines (daylight saving + standard time). This script works out
// which local time the triggering cron line stands for and only sends when that matches a reminder
// in config.json, so exactly one of the pair fires, even if GitHub starts the job late.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import webpush from "web-push";

const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
const readOr = (path, fallback) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : fallback);
const event = process.env.EVENT || "workflow_dispatch";
const dryRun = !!process.env.DRY_RUN;
const now = process.env.NOW ? new Date(process.env.NOW) : new Date();

function local(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hour: Number(p.hour) };
}

// The check-in "day" rolls over at day_rollover_hour, matching the app.
function logicalToday() {
  const l = local(now);
  return l.hour < (cfg.day_rollover_hour ?? 4) ? local(new Date(now - 86400000)).date : l.date;
}

function checkedInToday() {
  const subjects = execFileSync("git", ["log", "-200", "--format=%s", "--", "data/log.enc.json"], { encoding: "utf8" });
  return subjects.split("\n").includes(`Check-in for ${logicalToday()}`);
}

let message;
if (event === "schedule") {
  const [min, hour] = (process.env.SCHEDULE || "").split(" ").map(Number);
  let slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min);
  if (slot > now.getTime()) slot -= 86400000; // the job started after midnight UTC
  const slotLocal = local(new Date(slot)).time;
  const index = cfg.reminders.indexOf(slotLocal);
  if (index === -1) {
    console.log(`Cron "${process.env.SCHEDULE}" is ${slotLocal} in ${cfg.timezone}: not a reminder time today (other half of the DST pair). Skipping.`);
    process.exit(0);
  }
  if (checkedInToday()) {
    console.log(`Already checked in for ${logicalToday()}. Skipping the ${slotLocal} reminder.`);
    process.exit(0);
  }
  message = index === 0
    ? { title: "Daily health check-in", body: "How was today? Tap to log it." }
    : { title: "Still time to check in", body: "You haven't logged today yet. Takes a minute." };
} else {
  message = { title: "Test notification", body: "Reminders are working. Tap to open your check-in." };
}

const subs = JSON.parse(readOr("push/subscriptions.json", "[]"));
const publicKey = readOr("push/vapid-public.txt", "").trim();
if (!subs.length || !publicKey) {
  console.log("No devices subscribed yet. Finish the Setup page on your phone.");
  process.exit(0);
}
if (!process.env.VAPID_PRIVATE_KEY) {
  console.error("Missing the VAPID_PRIVATE_KEY repository secret. See step 3 on the Setup page.");
  process.exit(1);
}

const [owner, repo] = (process.env.GITHUB_REPOSITORY || "owner/repo").split("/");
const appUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`;
webpush.setVapidDetails(appUrl, publicKey, process.env.VAPID_PRIVATE_KEY);

const payload = JSON.stringify({ ...message, url: appUrl });
let ok = 0;
for (const sub of subs) {
  const host = new URL(sub.endpoint).host;
  if (dryRun) { console.log(`[dry run] would send "${message.title}" to ${host}`); ok++; continue; }
  try {
    await webpush.sendNotification(sub, payload, { TTL: 3 * 3600, urgency: "normal" });
    console.log(`Sent "${message.title}" to ${host}`);
    ok++;
  } catch (e) {
    const gone = e.statusCode === 404 || e.statusCode === 410;
    console.error(`Failed for ${host}: ${e.statusCode || ""} ${e.body || e.message}` +
      (gone ? " (this device's registration expired; re-run step 4 on the Setup page)" : ""));
  }
}
if (!ok) process.exit(1);
