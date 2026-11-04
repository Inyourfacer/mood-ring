// The numbers behind the review page. Everything here runs on your device after unlocking.
//
// entries = { "YYYY-MM-DD": { answers: {...}, updated_at } }

const MIN_PATTERN_DAYS = 14; // logged days before any pattern is mentioned
const MIN_GROUP_DAYS = 4;    // days needed both with and without a habit
const MIN_PATTERN_DIFF = 1;  // points of difference worth pointing out

export const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const mondayOf = (day) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
export const weekDates = (monday) => [...Array(7)].map((_, i) => addDays(monday, i));

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const numeric = (questions) => questions.filter((q) => q.type === "scale" || q.type === "number");
export const moodQuestion = (questions) => numeric(questions).find((q) => q.id === "mood") || numeric(questions).find((q) => q.type === "scale");
const value = (entries, day, id) => {
  const v = entries[day]?.answers?.[id];
  return typeof v === "number" ? v : null;
};
const values = (entries, days, id) => days.map((d) => value(entries, d, id)).filter((v) => v !== null);
const loggedDays = (entries, upTo) => Object.keys(entries).filter((d) => !upTo || d <= upTo).sort();

function dayNote(questions, entries, day) {
  return questions.filter((q) => q.type === "text").map((q) => entries[day]?.answers?.[q.id]).filter(Boolean).join(" ");
}

function verdict(q, delta) {
  if (delta === null) return null;
  if (Math.abs(delta) < 0.05) return "same";
  return (q.lower_is_better ? delta < 0 : delta > 0) ? "better" : "worse";
}

// Highest and lowest mood days. Ties go to the most recent. Null if there's no difference to show.
function extremes(questions, entries, days) {
  const mood = moodQuestion(questions);
  if (!mood) return { best: null, hardest: null };
  const scored = days.map((day) => ({ day, score: value(entries, day, mood.id) })).filter((x) => x.score !== null);
  if (new Set(scored.map((x) => x.score)).size < 2) return { best: null, hardest: null };
  const pick = (cmp) => scored.reduce((a, b) => (cmp(b.score, a.score) || b.score === a.score ? b : a));
  const note = (x) => ({ ...x, note: dayNote(questions, entries, x.day) });
  return { best: note(pick((a, b) => a > b)), hardest: note(pick((a, b) => a < b)) };
}

// The habit with the biggest mood difference, once there's enough data for that to mean something.
export function strongestPattern(questions, entries, upTo) {
  const mood = moodQuestion(questions);
  const tags = questions.find((q) => q.type === "tags");
  if (!mood || !tags) return null;
  const days = loggedDays(entries, upTo).filter((d) => value(entries, d, mood.id) !== null);
  if (days.length < MIN_PATTERN_DAYS) return { needed: MIN_PATTERN_DAYS - days.length };
  let top = null;
  for (const habit of tags.options) {
    const has = (d) => (entries[d].answers[tags.id] || []).includes(habit);
    const withDays = days.filter(has), withoutDays = days.filter((d) => !has(d));
    if (withDays.length < MIN_GROUP_DAYS || withoutDays.length < MIN_GROUP_DAYS) continue;
    const diff = mean(values(entries, withDays, mood.id)) - mean(values(entries, withoutDays, mood.id));
    if (Math.abs(diff) >= MIN_PATTERN_DIFF && (!top || Math.abs(diff) > Math.abs(top.diff))) {
      top = { habit, diff, withCount: withDays.length, withoutCount: withoutDays.length };
    }
  }
  return top || { none: true };
}

export function weekSummary(questions, entries, monday) {
  const days = weekDates(monday), prev = weekDates(addDays(monday, -7));
  const logged = days.filter((d) => entries[d]);
  const metrics = numeric(questions).map((q) => {
    const now = values(entries, days, q.id), before = values(entries, prev, q.id);
    const avg = mean(now), prevAvg = mean(before);
    const delta = avg !== null && prevAvg !== null ? avg - prevAvg : null;
    return { q, avg, prevAvg, delta, verdict: verdict(q, delta) };
  });
  const mood = moodQuestion(questions);
  return {
    days,
    logged,
    moodByDay: days.map((day) => ({ day, score: mood ? value(entries, day, mood.id) : null, logged: !!entries[day] })),
    metrics,
    ...extremes(questions, entries, logged),
    notes: logged.map((day) => ({ day, note: dayNote(questions, entries, day) })).filter((x) => x.note),
    pattern: strongestPattern(questions, entries, days[6]),
  };
}

function streaks(days, today) {
  let longest = { length: 0 }, run = null;
  for (const day of days) {
    run = run && addDays(run.end, 1) === day ? { start: run.start, end: day, length: run.length + 1 } : { start: day, end: day, length: 1 };
    if (run.length >= longest.length) longest = run;
  }
  // Today not being logged yet doesn't break a streak.
  const current = run && run.end >= addDays(today, -1) ? run.length : 0;
  return { longest, current };
}

export function allTimeSummary(questions, entries, today) {
  const days = loggedDays(entries);
  if (!days.length) return null;
  const mood = moodQuestion(questions);
  const span = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${days[0]}T12:00:00Z`)) / 86400000) + 1;
  const metrics = numeric(questions).map((q) => {
    const vals = values(entries, days, q.id);
    return { q, count: vals.length, avg: mean(vals), total: vals.reduce((a, b) => a + b, 0) };
  });
  const byMonth = {};
  for (const d of days) (byMonth[d.slice(0, 7)] ||= []).push(d);
  const months = Object.keys(byMonth).sort().map((month) => ({
    month, count: byMonth[month].length, moodAvg: mood ? mean(values(entries, byMonth[month], mood.id)) : null,
  }));
  const tags = questions.find((q) => q.type === "tags");
  const habits = !tags ? [] : tags.options.map((habit) => {
    const has = (d) => (entries[d].answers[tags.id] || []).includes(habit);
    const withDays = days.filter(has), withoutDays = days.filter((d) => !has(d));
    const enough = mood && withDays.length >= MIN_GROUP_DAYS && withoutDays.length >= MIN_GROUP_DAYS;
    return { habit, count: withDays.length, share: withDays.length / days.length,
             diff: enough ? mean(values(entries, withDays, mood.id)) - mean(values(entries, withoutDays, mood.id)) : null };
  }).sort((a, b) => b.count - a.count);
  return {
    count: days.length, first: days[0], span, ...streaks(days, today), metrics, months, habits,
    ...extremes(questions, entries, days), pattern: strongestPattern(questions, entries),
  };
}
