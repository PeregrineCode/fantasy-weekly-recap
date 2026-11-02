/**
 * When each player joined each fantasy team, as
 * { addTimestamps: { "playerKey|teamKey": unixSeconds }, addedPlayerTeams: { same key: proTeam } }.
 *
 * Covers free-agent/waiver adds and trades. A trade that goes through between
 * the nightly lineup capture and the morning stats collect puts the player on
 * his new team in that day's snapshot with an API (bench) slot, even though
 * his game was played for the old team. The timestamp lets bench detection
 * see that the new manager could never have started him that day.
 */
function buildAcquisitionTimestamps(transactions) {
  const addTimestamps = {};
  const addedPlayerTeams = {};
  for (const tx of transactions || []) {
    const isAdd = tx.type === 'add' || tx.type === 'add/drop';
    const isTrade = tx.type === 'trade';
    if (!isAdd && !isTrade) continue;
    if (isTrade && tx.status && tx.status !== 'successful') continue;
    for (const p of tx.players || []) {
      if (!p.destTeam) continue;
      if (p.type !== (isTrade ? 'trade' : 'add')) continue;
      const key = `${p.playerKey}|${p.destTeam}`;
      // Keep the earliest arrival if a player joined the same team twice
      if (!addTimestamps[key] || tx.timestamp < addTimestamps[key]) {
        addTimestamps[key] = tx.timestamp;
        addedPlayerTeams[key] = p.team;
      }
    }
  }
  return { addTimestamps, addedPlayerTeams };
}

module.exports = { buildAcquisitionTimestamps };
