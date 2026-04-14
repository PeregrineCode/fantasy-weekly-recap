/**
 * Yahoo Fantasy API data fetching helpers for the weekly recap pipeline.
 * Handles: roster fetching, standings, player info parsing.
 */

const { parseYahooStats } = require('./stat-categories');

/**
 * Parse a Yahoo player object from roster/FA endpoints into a flat object.
 */
function parsePlayerInfo(playerArray) {
  const info = {};
  for (const item of playerArray[0]) {
    if (typeof item === 'object' && !Array.isArray(item)) {
      Object.assign(info, item);
    }
  }

  const positions = [];
  if (info.eligible_positions) {
    for (const pos of info.eligible_positions) {
      if (pos.position) positions.push(pos.position);
    }
  }

  // player_stats and selected_position live at varying indices depending on the
  // endpoint (roster puts selected_position at [1] and stats at [2]; league players
  // puts stats at [1] with no selected_position). Scan all indices to be safe.
  let stats = {};
  let selectedPosition = '';
  for (let i = 1; i < playerArray.length; i++) {
    if (playerArray[i]?.player_stats && Object.keys(stats).length === 0) {
      stats = parseYahooStats(playerArray[i].player_stats.stats);
    }
    if (Array.isArray(playerArray[i]?.selected_position) && !selectedPosition) {
      const sp = playerArray[i].selected_position.find(s => s?.position);
      selectedPosition = sp?.position || '';
    }
  }

  return {
    playerKey: info.player_key,
    name: info.name?.full || `${info.name?.first || ''} ${info.name?.last || ''}`.trim(),
    team: info.editorial_team_abbr || '',
    positions,
    displayPosition: info.display_position || '',
    selectedPosition,
    status: info.status || '',
    ownership: parseFloat(info.ownership?.value) || 0,
    stats,
  };
}

/**
 * Fetch a single team's roster with season stats.
 */
async function fetchTeamRoster(client, teamKey) {
  const data = await client.get(`/team/${teamKey}/roster/players;out=stats`);

  const players = [];
  try {
    const playersData = data.fantasy_content.team[1].roster['0'].players;
    const count = playersData.count;
    for (let i = 0; i < count; i++) {
      players.push(parsePlayerInfo(playersData[i].player));
    }
  } catch (e) {
    throw new Error(`Failed to parse roster for ${teamKey}: ${e.message}`);
  }

  return players;
}

/**
 * Fetch all teams' rosters in the league.
 * Returns { teamKey: { name, teamKey, players: [...] } }
 */
async function fetchAllRosters(client, leagueKey, { onProgress } = {}) {
  const teams = await client.getLeagueTeams(leagueKey);
  const rosters = {};

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    if (onProgress) onProgress(`Fetching roster ${i + 1}/${teams.length}: ${t.name}...`);
    const players = await fetchTeamRoster(client, t.teamKey);
    rosters[t.teamKey] = {
      teamKey: t.teamKey,
      teamId: t.teamId,
      name: t.name,
      managerName: t.managerName,
      players,
    };
  }

  return rosters;
}

/**
 * Fetch league standings with per-team stat totals.
 */
async function fetchStandings(client, leagueKey) {
  const data = await client.get(`/league/${leagueKey}/standings`);

  const teams = [];
  try {
    const standingsData = data.fantasy_content.league[1].standings[0].teams;
    const count = standingsData.count;

    for (let i = 0; i < count; i++) {
      const t = standingsData[i].team;
      const info = {};
      for (const item of t[0]) {
        if (typeof item === 'object' && !Array.isArray(item)) {
          Object.assign(info, item);
        }
      }

      // team_standings may be at t[1] or t[2] depending on what Yahoo includes
      const standings = t[1]?.team_standings || t[2]?.team_standings || {};
      const stats = {};
      const statsSource = t[1]?.team_stats?.stats || t[2]?.team_stats?.stats;
      if (statsSource) {
        for (const s of statsSource) {
          const stat = s?.stat;
          if (stat) {
            stats[stat.stat_id] = parseFloat(stat.value) || 0;
          }
        }
      }

      teams.push({
        teamKey: info.team_key,
        teamId: info.team_id,
        name: info.name,
        rank: parseInt(standings.rank) || 0,
        wins: parseInt(standings.outcome_totals?.wins) || 0,
        losses: parseInt(standings.outcome_totals?.losses) || 0,
        ties: parseInt(standings.outcome_totals?.ties) || 0,
        pct: parseFloat(standings.outcome_totals?.percentage) || 0,
        faabBalance: info.faab_balance != null ? parseInt(info.faab_balance) : null,
        stats,
      });
    }
  } catch (e) {
    throw new Error(`Failed to parse standings: ${e.message}`);
  }

  return teams;
}

module.exports = {
  fetchTeamRoster,
  fetchAllRosters,
  fetchStandings,
  parsePlayerInfo,
};
