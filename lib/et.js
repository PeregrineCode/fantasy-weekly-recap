/**
 * Eastern-time helpers. Yahoo's fantasy days and week boundaries follow ET, and
 * the hockey season spans both EDT and EST, so offsets must not be hardcoded.
 */

const TZ = 'America/New_York';

/** Hour (0-23) in ET at the given epoch ms. */
function etHour(ms) {
  return parseInt(new Date(ms).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }), 10) % 24;
}

/** YYYY-MM-DD date in ET at the given epoch ms. */
function etDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Epoch ms of 00:00 ET on a YYYY-MM-DD date (DST-aware). */
function etMidnightUTC(dateStr) {
  // 05:00Z is midnight EST, or 01:00 EDT — back off by whatever hour ET reads
  const guess = Date.parse(`${dateStr}T05:00:00Z`);
  return guess - etHour(guess) * 3600 * 1000;
}

module.exports = { etHour, etDate, etMidnightUTC };
