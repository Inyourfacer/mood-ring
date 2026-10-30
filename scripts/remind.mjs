// Check-in reminders, run by .github/workflows/remind.yml every half hour.
//
//   node scripts/remind.mjs check   decides whether this run should notify (fast, no dependencies)
//   node scripts/remind.mjs send    sends the notification chosen by "check" to every device
//
// The workflow fires at :00 and :30 UTC. "check" works out which half-hour slot triggered it
// (even if GitHub started the job late), converts that to your time zone, and only sends when
// it matches a reminder time in config.json. Reminder times must therefore end in :00 or :30.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
const readOr = (path, fallback) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : fallback);
const mode = process.argv[2] || "check";
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

// The most recent UTC time at or before now whose minute matches the cron line ("0 * * * *" or "30 * * * *").
function slotFor(schedule) {
  const minute = Number(schedule.split(" ")[0]);
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(minute);
  if (slot > now) slot.setUTCHours(slot.getUTCHours() - 1);
  return slot;
}

function decide() {
  if ((process.env.EVENT || "workflow_dispatch") !== "schedule") {
    return { title: "Test notification", body: "Reminders are working. Tap to open your check-in." };
  }
  if (!cfg.timezone) return console.log("No time zone set yet. Open the Setup page, step 3."), null;
  const slotLocal = local(slotFor(process.env.SCHEDULE || "0 * * * *")).time;
  const index = cfg.reminders.indexOf(slotLocal);
  if (index === -1) return console.log(`${slotLocal} in ${cfg.timezone} isn't a reminder time.`), null;
  if (checkedInToday()) return console.log(`Already checked in for ${logicalToday()}. Skipping the ${slotLocal} reminder.`), null;
  return index === 0
    ? { title: "Daily health check-in", body: "How was today? Tap to log it." }
    : { title: "Still time to check in", body: "You haven't logged today yet. Takes a minute." };
}

if (mode === "check") {
  const message = decide();
  const out = process.env.GITHUB_OUTPUT;
  if (message) console.log(`Will send: ${message.title}`);
  if (out) fs.appendFileSync(out, `send=${!!message}\nmessage=${JSON.stringify(message)}\n`);
  process.exit(0);
}

// ---- send
const message = JSON.parse(process.env.MESSAGE || "null") || decide();
if (!message) process.exit(0);
const subs = JSON.parse(readOr("push/subscriptions.json", "[]"));
const publicKey = readOr("push/vapid-public.txt", "").trim();
if (!subs.length || !publicKey) {
  console.log("No devices have notifications turned on yet. Finish the Setup page on your phone.");
  process.exit(0);
}
if (!process.env.VAPID_PRIVATE_KEY) {
  console.error("Missing the VAPID_PRIVATE_KEY repository secret. See step 4 on the Setup page.");
  process.exit(1);
}

const { default: webpush } = await import("web-push");
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "owner/repo").split("/");
const appUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`;
webpush.setVapidDetails(appUrl, publicKey, process.env.VAPID_PRIVATE_KEY);

const payload = JSON.stringify({ ...message, url: appUrl });
let ok = 0;
for (const sub of subs) {
  const host = new URL(sub.endpoint).host;
  if (process.env.DRY_RUN) { console.log(`[dry run] would send "${message.title}" to ${host}`); ok++; continue; }
  try {
    await webpush.sendNotification(sub, payload, { TTL: 3 * 3600, urgency: "normal" });
    console.log(`Sent "${message.title}" to ${host}`);
    ok++;
  } catch (e) {
    const gone = e.statusCode === 404 || e.statusCode === 410;
    console.error(`Failed for ${host}: ${e.statusCode || ""} ${e.body || e.message}` +
      (gone ? " (this device's registration expired; redo step 5 on the Setup page)" : ""));
  }
}
if (!ok) process.exit(1);
