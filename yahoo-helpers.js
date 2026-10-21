/**
 * Shared Yahoo Fantasy API helpers for the weekly recap pipeline.
 * Used by both collect.js and daily-collect.js.
 */

const { STAT_ID_MAP, deriveStats } = require('./lib/stat-categories');
const { activeLeague } = require('./lib/league');

const scoring = activeLeague().sportProfile.scoring;

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
  return deriveStats(stats);
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

      const points = parseFloat(teamEntry[1]?.team_points?.total);
      teams.push({
        teamKey: teamInfo.team_key,
        name: teamInfo.name,
        stats,
        points: isNaN(points) ? null : points,
      });
    }

    // Parse stat winners (which team won each category). A points league
    // still lists per-stat winners, but they decide nothing.
    const isPoints = scoring?.type === 'points';
    const statWinners = [];
    if (matchup.stat_winners && !isPoints) {
      for (const sw of matchup.stat_winners) {
        const winner = sw?.stat_winner;
        if (winner) {
          const name = STAT_ID_MAP[parseInt(winner.stat_id)];
          statWinners.push({
            stat: name || `stat_${winner.stat_id}`,
            winnerTeamKey: winner.winner_team_key || null,
            isTied: winner.is_tied == 1, // Yahoo returns is_tied as number 1, not string '1'
          });
        }
      }
    }

    // Compute overall score: categories won, or fantasy points in a points
    // league (see lib/scoring.js for why the fields keep the "Wins" names)
    let team1Wins = 0, team2Wins = 0, ties = 0;
    if (isPoints) {
      team1Wins = teams[0].points ?? 0;
      team2Wins = teams[1].points ?? 0;
    }
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
      isPlayoffs: matchup.is_playoffs == 1,
      isConsolation: matchup.is_consolation == 1,
      weekStart: matchup.week_start || null,
      weekEnd: matchup.week_end || null,
    });
  }

  return matchups;
}

/**
 * Label each playoff matchup with its bracket round.
 *
 * Yahoo only flags `is_playoffs` and `is_consolation`; it does not say which
 * matchup is the championship. We infer the bracket from the previous week's
 * playoff results: a team that lost a playoff matchup last week is in the
 * losers' bracket. Teams that won (or had a bye and didn't play) stay in the
 * winners' bracket. `weeksRemaining` is endWeek - week (0 in the finals week).
 *
 * Returns a new array; each matchup gains a `round` string or null for
 * regular-season matchups.
 */
function labelPlayoffRounds(matchups, prevMatchups, weeksRemaining) {
  const prevLosers = new Set();
  for (const pm of prevMatchups || []) {
    if (!pm.isPlayoffs || !pm.winnerTeamKey) continue;
    const loser = pm.winnerTeamKey === pm.team1.teamKey ? pm.team2.teamKey : pm.team1.teamKey;
    prevLosers.add(loser);
  }

  const winnersRound = weeksRemaining === 0 ? 'Championship'
    : weeksRemaining === 1 ? 'Semifinal'
    : weeksRemaining === 2 ? 'Quarterfinal'
    : 'Playoff';
  const losersRound = weeksRemaining === 0 ? 'Third Place' : 'Consolation';

  return matchups.map(m => {
    if (!m.isPlayoffs) return { ...m, round: null };
    if (m.isConsolation) return { ...m, round: 'Consolation' };
    const inLosersBracket = prevLosers.has(m.team1.teamKey) || prevLosers.has(m.team2.teamKey);
    return { ...m, round: inLosersBracket ? losersRound : winnersRound };
  });
}

const FINALS_ROUNDS = new Set(['Championship', 'Third Place']);

module.exports = { parseTeamInfo, parseStatValues, parseScoreboardResponse, labelPlayoffRounds, FINALS_ROUNDS };
