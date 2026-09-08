/**
 * Nightly position-capture trust rules, shared by daily-positions.js (decides
 * whether to write a capture) and daily-collect.js (decides whether to trust
 * one when merging positions into the day's snapshot).
 */

/** Add `days` to a YYYY-MM-DD string (UTC math, returns YYYY-MM-DD). */
function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Is a nightly position capture trustworthy for fantasy date X?
 *
 * The capture is meant to run ~10:30 PM ET on X, after all of X's games (incl. West
 * Coast) have started — lineups are locked, so positions reflect X's actual game-day
 * roster. But GitHub Actions routinely delays scheduled runs by hours. A run that
 * slips past Yahoo's ~3 AM ET fantasy-day rollover instead reads the NEXT day's
 * not-yet-finalized lineup, producing phantom "benched" players the manager actually
 * started once they set their real lineup. Trust a capture only if it landed in X's
 * locked window: the evening of X (>= 9 PM ET) or the small hours of X+1 before the
 * 3 AM rollover. Anything else (e.g. an early-morning-of-X run) is premature.
 */
function isNightlyCaptureTrustworthy(collectedAtISO, fantasyDate) {
  if (!collectedAtISO) return false;
  const et = new Date(collectedAtISO).toLocaleString('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const [etDate, etTime] = et.split(/,?\s+/);
  const etHour = parseInt(etTime.split(':')[0], 10) % 24; // normalize a "24:00" midnight
  const nextDate = addDaysISO(fantasyDate, 1);
  if (etDate === fantasyDate && etHour >= 21) return true; // on-time evening capture
  if (etDate === nextDate && etHour < 3) return true;      // delayed but pre-rollover
  return false;
}

/**
 * Should daily-positions.js skip writing a capture for `fantasyDate`?
 * Returns a reason string to skip, or null to proceed.
 *
 * - A trusted capture already on disk wins: the nightly workflow fires several
 *   times inside the locked window to survive GitHub scheduling delays, and only
 *   the first good one should land (no overwrite, no extra commit).
 * - A run outside the locked window (e.g. delayed past Yahoo's ~3 AM ET rollover)
 *   would capture the next day's unset lineup. Never write that.
 */
function shouldSkipCapture(existingSnapshot, nowISO, fantasyDate) {
  if (existingSnapshot && isNightlyCaptureTrustworthy(existingSnapshot.collectedAt, fantasyDate)) {
    return `a trusted capture for ${fantasyDate} already exists (captured ${existingSnapshot.collectedAt})`;
  }
  if (!isNightlyCaptureTrustworthy(nowISO, fantasyDate)) {
    return `now (${nowISO}) is outside ${fantasyDate}'s locked window (9 PM ET to 2:59 AM ET); a capture now would read an unset lineup`;
  }
  return null;
}

module.exports = { addDaysISO, isNightlyCaptureTrustworthy, shouldSkipCapture };
