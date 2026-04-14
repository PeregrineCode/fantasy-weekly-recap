/**
 * Shared Yahoo Fantasy API helpers for the weekly recap pipeline.
 * Used by both collect.js and daily-collect.js.
 */

const { STAT_ID_MAP } = require('./lib/stat-categories');

/**
 * Parse team info from Yahoo's nested array format.
 */
function parseTeamInfo(teamArray) {
  const info = {};
  if (!Array.isArray(teamArray)) return info;
  for (const item of teamArray) {
    if (typeof item === 'object' && !Array.isArray(item)) {
      Object.assign(info, item);
    }
  }
  return info;
}

/**
 * Parse stat values from Yahoo's stat array into a flat { statName: number } object.
 * Skips stats not in STAT_ID_MAP and non-numeric values (e.g., "-" for no data).
 */
function parseStatValues(statsArray) {
  const stats = {};
  if (!Array.isArray(statsArray)) return stats;

  for (const s of statsArray) {
    const stat = s?.stat;
    if (!stat) continue;
    const name = STAT_ID_MAP[parseInt(stat.stat_id)];
    if (!name) continue;
    const val = parseFloat(stat.value);
    if (!isNaN(val) && isFinite(val)) {
      stats[name] = val;
    }
  }
  return stats;
}

/**
 * Parse a scoreboard API response into a flat array of matchup objects.
 * Used by both weekly collect and daily collect.
 *
 * @param {Object} data - Raw Yahoo API response from /league/{key}/scoreboard
 * @returns {Array} matchups
 */
function parseScoreboardResponse(data) {
  const matchups = [];
  const matchupData = data.fantasy_content.league[1].scoreboard['0'].matchups;
  const count = matchupData.count;

  for (let i = 0; i < count; i++) {
    const matchup = matchupData[i].matchup;
    const teams = [];

    for (let t = 0; t < 2; t++) {
      const teamEntry = matchup['0'].teams[t].team;
      const teamInfo = parseTeamInfo(teamEntry[0]);
      const stats = parseStatValues(teamEntry[1]?.team_stats?.stats);

      teams.push({
        teamKey: teamInfo.team_key,
        name: teamInfo.name,
        stats,
      });
    }

    // Parse stat winners (which team won each category)
    const statWinners = [];
    if (matchup.stat_winners) {
      for (const sw of matchup.stat_winners) {
        const winner = sw?.stat_winner;
        if (winner) {
          const name = STAT_ID_MAP[parseInt(winner.stat_id)];
          statWinners.push({
            stat: name || `stat_${winner.stat_id}`,
            winnerTeamKey: winner.winner_team_key || null,
            isTied: winner.is_tied === '1',
          });
        }
      }
    }

    // Compute overall score
    let team1Wins = 0, team2Wins = 0, ties = 0;
    for (const sw of statWinners) {
      if (sw.isTied) ties++;
      else if (sw.winnerTeamKey === teams[0].teamKey) team1Wins++;
      else if (sw.winnerTeamKey === teams[1].teamKey) team2Wins++;
    }

    matchups.push({
      team1: teams[0],
      team2: teams[1],
      team1Wins,
      team2Wins,
      ties,
      statWinners,
      winnerTeamKey: matchup.winner_team_key || null,
    });
  }

  return matchups;
}

module.exports = { parseTeamInfo, parseStatValues, parseScoreboardResponse };
