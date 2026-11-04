// Check-in reminders, run by .github/workflows/remind.yml.
//
//   node scripts/remind.mjs check   decides whether this run should notify (fast, no dependencies)
//   node scripts/remind.mjs send    sends the notification chosen by "check" to every device
//
// GitHub starts scheduled jobs irregularly, so reminders aren't tied to an exact time. The first
// run inside reminder_window (config.json, your time zone) sends one reminder, unless you've
// already checked in. push/last-reminder.txt records the day so later runs don't send it again.
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

function decide() {
  if ((process.env.EVENT || "workflow_dispatch") !== "schedule") {
    return { title: "Test notification", body: "Reminders are working. Tap to open your check-in." };
  }
  if (!cfg.timezone) return console.log("No time zone set yet. Open the Setup page, step 3."), null;
  const { start, end } = cfg.reminder_window || { start: "17:00", end: "22:00" };
  const time = local(now).time, day = logicalToday();
  if (time < start || time >= end) return console.log(`${time} in ${cfg.timezone} is outside the ${start}-${end} window.`), null;
  if (readOr("push/last-reminder.txt", "").trim() === day) return console.log(`Already reminded for ${day}.`), null;
  if (checkedInToday()) return console.log(`Already checked in for ${day}.`), null;
  return { title: "Daily health check-in", body: "How was today? Tap to log it.", day };
}

if (mode === "check") {
  const message = decide();
  const out = process.env.GITHUB_OUTPUT;
  if (message) console.log(`Will send: ${message.title}`);
  if (out) fs.appendFileSync(out, `send=${!!message}\nday=${message?.day || ""}\nmessage=${JSON.stringify(message)}\n`);
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

const payload = JSON.stringify({ title: message.title, body: message.body, url: appUrl });
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
