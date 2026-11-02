/**
 * Games played from the daily snapshots.
 *
 * A daily stat line with any numeric value (even all zeros) means the player
 * played that day; a did-not-play day comes back from Yahoo as "-" for every
 * stat, which parses to no numbers at all. That is what tells a zero-stat
 * game apart from a night off.
 */

const { etDate } = require('./et');

function playedDay(stats) {
  return !!stats && Object.values(stats).some(v => typeof v === 'number');
}

/**
 * How many games a player played while on one fantasy team this week, and how
 * many of those he was in the active lineup for.
 *
 * Returns { games, lineupGames } or null when no daily snapshot has the player
 * on that team. lineupGames is null when any game day lacks a trusted
 * (nightly) lineup, since the slot on those days is the next morning's.
 *
 * joined ({ at: unixSeconds, proTeam, gameStarts }) drops a game that started
 * before the player joined the team: the day's snapshot lists him on his new
 * roster, but that game never counted for anyone there. gameStarts maps
 * "proTeam|YYYY-MM-DD" to the start time in Unix seconds; without a start time
 * a game on the day he joined is dropped.
 */
function joinedBeforeGame(joined, date) {
  if (!joined?.at) return true;
  const start = joined.proTeam && joined.gameStarts?.get(`${joined.proTeam}|${date}`);
  if (start) return joined.at < start;
  return etDate(joined.at * 1000) < date;
}

function gamesOnTeam(dailySnapshots, playerKey, teamKey, inactiveSlots, joined = null) {
  let seen = false;
  let games = 0;
  let lineupGames = 0;
  let allTrusted = true;
  for (const snap of dailySnapshots || []) {
    const player = snap.rosters?.[teamKey]?.players?.find(p => p.playerKey === playerKey);
    if (!player) continue;
    seen = true;
    if (!playedDay(player.stats)) continue;
    if (!joinedBeforeGame(joined, snap.date)) continue;
    games++;
    if (snap.positionsSource !== 'nightly') allTrusted = false;
    if (!inactiveSlots.includes(player.selectedPosition)) lineupGames++;
  }
  if (!seen) return null;
  return { games, lineupGames: allTrusted ? lineupGames : null };
}

/**
 * Prompt text for a player's games, or '' when unknown. Weekly roster stats
 * only count lineup games, so say so when he also played from the bench.
 */
function describeGames(gp) {
  if (!gp) return '';
  const g = n => `${n} game${n === 1 ? '' : 's'}`;
  if (gp.lineupGames == null) return `Games: played ${g(gp.games)} for this team (lineup slots unknown for some of them)`;
  if (gp.lineupGames === gp.games) return `Games: played ${g(gp.games)} for this team, ${gp.games === 1 ? 'in' : 'all in'} the active lineup`;
  return `Games: played ${g(gp.games)} for this team, ${gp.lineupGames} in the active lineup (the stats above count only the lineup games)`;
}

module.exports = { playedDay, gamesOnTeam, describeGames };
