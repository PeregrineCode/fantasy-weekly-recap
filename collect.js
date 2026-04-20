/**
 * Weekly data collector — fetches scoreboard, transactions, standings, rosters
 * from Yahoo Fantasy API and saves weekly snapshots.
 *
 * Usage: node collect.js [--week N]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('yahoo-fantasy-api');
const { fetchStandings, fetchAllRosters } = require('./lib/yahoo-fetch');
const { parseYahooStats } = require('./lib/stat-categories');
const { parseScoreboardResponse } = require('./yahoo-helpers');

const LEAGUE_ID = process.env.YAHOO_MLB_LEAGUE_ID || process.env.YAHOO_LEAGUE_ID;


const { auth, client } = createClient({
  tokenFile: path.resolve(__dirname, '.yahoo-token.json'),
  certsDir: path.resolve(__dirname, 'certs'),
  log: (type, msg) => console.log(`  [${type}] ${msg}`),
});

// --- Yahoo API parsers for new endpoints ---

/**
 * Fetch weekly scoreboard — matchup results with per-category breakdowns.
 */
async function fetchScoreboard(leagueKey, week) {
  const data = await client.get(`/league/${leagueKey}/scoreboard;week=${week}`);
  try {
    return parseScoreboardResponse(data);
  } catch (e) {
    throw new Error(`Failed to parse scoreboard: ${e.message}`);
  }
}

/**
 * Fetch league transactions (adds, drops, trades).
 */
async function fetchTransactions(leagueKey) {
  const data = await client.get(`/league/${leagueKey}/transactions`);

  const transactions = [];
  try {
    const txData = data.fantasy_content.league[1].transactions;
    if (!txData || txData.count === 0) return transactions;

    const count = txData.count;
    for (let i = 0; i < count; i++) {
      const tx = txData[i].transaction;
      const txInfo = tx[0];
      const players = [];

      // Parse players involved
      if (tx[1]?.players) {
        const playerCount = tx[1].players.count;
        for (let p = 0; p < playerCount; p++) {
          const playerEntry = tx[1].players[p].player;
          const pInfo = {};
          for (const item of playerEntry[0]) {
            if (typeof item === 'object' && !Array.isArray(item)) {
              Object.assign(pInfo, item);
            }
          }

          const transactionData = playerEntry[1]?.transaction_data?.[0] || playerEntry[1]?.transaction_data || {};
          players.push({
            playerKey: pInfo.player_key,
            name: pInfo.name?.full || `${pInfo.name?.first || ''} ${pInfo.name?.last || ''}`.trim(),
            team: pInfo.editorial_team_abbr || '',
            position: pInfo.display_position || '',
            type: transactionData.type || '',
            sourceType: transactionData.source_type || '',
            sourceTeam: transactionData.source_team_key || '',
            destType: transactionData.destination_type || '',
            destTeam: transactionData.destination_team_key || '',
          });
        }
      }

      const entry = {
        transactionId: txInfo.transaction_id,
        type: txInfo.type,
        status: txInfo.status,
        timestamp: parseInt(txInfo.timestamp) || 0,
        players,
      };
      if (txInfo.faab_bid !== undefined) {
        entry.faabBid = parseInt(txInfo.faab_bid) || 0;
      }
      transactions.push(entry);
    }
  } catch (e) {
    throw new Error(`Failed to parse transactions: ${e.message}`);
  }

  return transactions;
}

/**
 * Fetch all team rosters with WEEKLY stats and lineup positions.
 * Returns { teamKey: { name, players: [{ playerKey, name, stats, selectedPosition, ... }] } }
 * The selectedPosition field shows BN (bench), IL (injured), or the starting slot.
 */
async function fetchAllRostersWeekly(leagueKey, week) {
  const teams = await client.getLeagueTeams(leagueKey);
  const rosters = {};

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    console.log(`  Fetching weekly roster ${i + 1}/${teams.length}: ${t.name}...`);
    const data = await client.get(
      `/team/${t.teamKey}/roster/players;out=percent_owned/stats;type=week;week=${week}`
    );

    const players = [];
    try {
      const playersData = data.fantasy_content.team[1].roster['0'].players;
      const count = playersData.count;
      for (let j = 0; j < count; j++) {
        const p = playersData[j].player;

        // Player info is at p[0]
        const info = {};
        for (const item of p[0]) {
          if (typeof item === 'object' && !Array.isArray(item)) {
            Object.assign(info, item);
          }
        }

        // Selected position (BN, IL, or starting slot) is at p[1]
        const selectedPosition = p[1]?.selected_position?.[1]?.position || '';

        // Weekly stats, percent_owned — index varies, scan all
        let stats = {};
        let ownership = 0;
        for (let k = 1; k < p.length; k++) {
          if (p[k]?.player_stats?.stats && Object.keys(stats).length === 0) {
            stats = parseYahooStats(p[k].player_stats.stats);
          }
          if (Array.isArray(p[k]?.percent_owned) && ownership === 0) {
            const valObj = p[k].percent_owned.find(x => x?.value !== undefined);
            ownership = parseFloat(valObj?.value) || 0;
          }
        }

        const positions = [];
        if (info.eligible_positions) {
          for (const pos of info.eligible_positions) {
            if (pos.position) positions.push(pos.position);
          }
        }

        players.push({
          playerKey: info.player_key,
          name: info.name?.full || `${info.name?.first || ''} ${info.name?.last || ''}`.trim(),
          team: info.editorial_team_abbr || '',
          positions,
          displayPosition: info.display_position || '',
          selectedPosition,
          status: info.status || '',
          ownership,
          stats,
        });
      }
    } catch (e) {
      console.log(`  Warning: failed to parse weekly roster for ${t.name}: ${e.message}`);
    }

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
 * Get league metadata including current week.
 */
async function fetchLeagueMeta(leagueKey) {
  const data = await client.get(`/league/${leagueKey}/metadata`);
  const meta = data.fantasy_content.league[0];
  return {
    name: meta.name,
    currentWeek: parseInt(meta.current_week) || 1,
    startDate: meta.start_date,
    endDate: meta.end_date,
    season: meta.season,
  };
}

// --- Main collection logic ---

async function collect(targetWeek) {
  if (!auth.token) {
    console.error('No Yahoo token. Run: npx yahoo-fantasy-api authenticate');
    process.exit(1);
  }

  if (!LEAGUE_ID) {
    console.error('Set YAHOO_MLB_LEAGUE_ID or YAHOO_LEAGUE_ID in .env');
    process.exit(1);
  }
  const gameKey = await client.resolveGameKey('mlb');
  const leagueKey = client.leagueKey(gameKey, LEAGUE_ID);

  console.log('Fetching league metadata...');
  const meta = await fetchLeagueMeta(leagueKey);
  const week = targetWeek || Math.max(1, meta.currentWeek - 1);
  console.log(`\nCollecting data for Week ${week} (current week: ${meta.currentWeek})`);

  // Compute week date range (Yahoo weeks are Mon-Sun, week 1 can be a partial week)
  // Use start of day ET (04:00 UTC) for consistent boundaries regardless of server timezone
  const startDate = new Date(meta.startDate + 'T04:00:00Z');
  let weekStart, weekEnd;
  if (week === 1) {
    // Week 1 starts on the season start date and ends on the first Sunday
    weekStart = new Date(startDate);
    weekEnd = new Date(startDate);
    const dayOfWeek = weekEnd.getDay(); // 0=Sun, 1=Mon, ...
    const daysToSun = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    weekEnd.setDate(weekEnd.getDate() + daysToSun);
  } else {
    // Week 2+ are full Mon-Sun weeks
    // First, find the Monday after week 1's Sunday
    const firstSunday = new Date(startDate);
    const dayOfWeek = firstSunday.getDay();
    firstSunday.setDate(firstSunday.getDate() + (dayOfWeek === 0 ? 0 : 7 - dayOfWeek));
    weekStart = new Date(firstSunday);
    weekStart.setDate(weekStart.getDate() + 1 + (week - 2) * 7); // Monday of week N
    weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6); // Sunday
  }

  const snapshotDir = path.join(__dirname, 'snapshots', `week-${String(week).padStart(2, '0')}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  // Save meta
  const metaFile = {
    week,
    leagueKey,
    leagueName: meta.name,
    season: meta.season,
    currentWeek: meta.currentWeek,
    weekStart: weekStart.toISOString().split('T')[0],
    weekEnd: weekEnd.toISOString().split('T')[0],
    collectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(snapshotDir, 'meta.json'), JSON.stringify(metaFile, null, 2));
  console.log(`  Saved meta.json`);

  // Fetch scoreboard
  console.log('\nFetching scoreboard...');
  const scoreboard = await fetchScoreboard(leagueKey, week);
  fs.writeFileSync(path.join(snapshotDir, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));
  console.log(`  Saved scoreboard.json (${scoreboard.length} matchups)`);

  // Fetch standings
  console.log('\nFetching standings...');
  const standings = await fetchStandings(client, leagueKey);
  fs.writeFileSync(path.join(snapshotDir, 'standings.json'), JSON.stringify(standings, null, 2));
  console.log(`  Saved standings.json (${standings.length} teams)`);

  // Fetch transactions
  console.log('\nFetching transactions...');
  const allTransactions = await fetchTransactions(leagueKey);
  // Filter to this week's transactions by timestamp
  const weekStartTs = Math.floor(weekStart.getTime() / 1000);
  const weekEndTs = Math.floor(weekEnd.getTime() / 1000) + 86400; // include end day
  const weekTransactions = allTransactions.filter(
    tx => tx.timestamp >= weekStartTs && tx.timestamp < weekEndTs
  );
  fs.writeFileSync(path.join(snapshotDir, 'transactions.json'), JSON.stringify(weekTransactions, null, 2));
  console.log(`  Saved transactions.json (${weekTransactions.length} this week, ${allTransactions.length} total)`);

  // Fetch season rosters (for ownership, season stats)
  console.log('\nFetching season rosters...');
  const rosters = await fetchAllRosters(client, leagueKey, {
    onProgress: msg => console.log(`  ${msg}`),
  });
  fs.writeFileSync(path.join(snapshotDir, 'rosters.json'), JSON.stringify(rosters, null, 2));
  console.log(`  Saved rosters.json (${Object.keys(rosters).length} teams)`);

  // Fetch weekly rosters (positions + weekly stats for bench/starter detection)
  console.log('\nFetching weekly rosters...');
  const weeklyRosters = await fetchAllRostersWeekly(leagueKey, week);
  fs.writeFileSync(path.join(snapshotDir, 'weekly-rosters.json'), JSON.stringify(weeklyRosters, null, 2));
  console.log(`  Saved weekly-rosters.json (${Object.keys(weeklyRosters).length} teams)`);

  // Build weekly-stats.json (keyed by playerKey) for backward compat with analyze.js
  const weeklyStats = {};
  for (const team of Object.values(weeklyRosters)) {
    for (const p of team.players) {
      weeklyStats[p.playerKey] = {
        name: p.name,
        team: p.team,
        position: p.displayPosition,
        stats: p.stats,
      };
    }
  }
  // Note: Yahoo's league-level players endpoint ignores type=week and returns season
  // stats, so we don't batch-fetch transaction players. Only rostered players (from
  // weekly-rosters above) have accurate weekly stats.

  fs.writeFileSync(path.join(snapshotDir, 'weekly-stats.json'), JSON.stringify(weeklyStats, null, 2));
  console.log(`  Saved weekly-stats.json (${Object.keys(weeklyStats).length} players)`);

  console.log(`\nCollection complete → ${snapshotDir}`);
  return { week, snapshotDir };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const weekIdx = args.indexOf('--week');
  const targetWeek = weekIdx !== -1 ? parseInt(args[weekIdx + 1]) : null;

  collect(targetWeek).catch(err => {
    console.error('Collection failed:', err.message);
    process.exit(1);
  });
}

module.exports = { collect };
