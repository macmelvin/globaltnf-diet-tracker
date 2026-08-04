/**
 * Billing engagement rule (one place to change it).
 *
 * A member counts as "active / billable" for a month only if they logged
 *   >= MIN_ENTRIES_PER_DAY entries on at least MIN_ACTIVE_DAYS separate days.
 * Production intent: 3+ entries on 3+ different days within the month, so a
 * single accidental scan (or one or two busy days) never bills the gym.
 *
 * DEMO gyms (gym doc field demoMode === true) ALWAYS use the DEMO_* thresholds
 * below (1-on-1), regardless of the real thresholds. That lets a single scan
 * show as "used the app" during a live pitch, while your real gyms keep the
 * production rule — so you never have to toggle the global setting again.
 *
 * Days are bucketed in Singapore time (UTC+8, no DST).
 */
const MIN_ENTRIES_PER_DAY = 3;   // REAL gyms: entries/day for an "active" day
const MIN_ACTIVE_DAYS = 3;       // REAL gyms: active days required to be billable

const DEMO_MIN_ENTRIES_PER_DAY = 1;  // DEMO gyms: always 1-on-1 so one scan shows during a live demo. Leave at 1.
const DEMO_MIN_ACTIVE_DAYS = 1;      // DEMO gyms: always 1-on-1. Leave at 1.

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * True if this member meets the engagement bar within [start, end).
 * Pass { demo: true } to use the demo (1-on-1) thresholds for a demo gym.
 */
async function isEngaged(db, uid, start, end, opts = {}) {
  const minEntries = opts.demo ? DEMO_MIN_ENTRIES_PER_DAY : MIN_ENTRIES_PER_DAY;
  const minDays = opts.demo ? DEMO_MIN_ACTIVE_DAYS : MIN_ACTIVE_DAYS;

  const snap = await db
    .collection(`users/${uid}/entries`)
    .where("timestamp", ">=", start)
    .where("timestamp", "<", end)
    .get();

  const perDay = {};
  snap.forEach((doc) => {
    const t = doc.get("timestamp");
    if (!t) return;
    const ms = t.toMillis ? t.toMillis() : new Date(t).getTime();
    const day = Math.floor((ms + SGT_OFFSET_MS) / 86400000); // SGT calendar day
    perDay[day] = (perDay[day] || 0) + 1;
  });

  let activeDays = 0;
  for (const k in perDay) if (perDay[k] >= minEntries) activeDays++;
  return activeDays >= minDays;
}

module.exports = {
  MIN_ENTRIES_PER_DAY, MIN_ACTIVE_DAYS,
  DEMO_MIN_ENTRIES_PER_DAY, DEMO_MIN_ACTIVE_DAYS,
  isEngaged,
};
