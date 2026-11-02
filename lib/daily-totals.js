const { etDate } = require('./et');

/**
 * A daily snapshot's matchup totals are Yahoo's week-to-date score at collection
 * time, so they only describe the snapshot's day when collected the next ET
 * morning. A --date backfill run days later carries a later (often final) score
 * under an early date, which would invent leads and lead changes.
 */
function hasDayTotals(snap) {
  if (!snap.collectedAt || !snap.date) return true;
  const collected = Date.parse(snap.collectedAt);
  if (isNaN(collected)) return true;
  const nextDay = new Date(Date.parse(`${snap.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return etDate(collected) <= nextDay;
}

module.exports = { hasDayTotals };
