/**
 * Daily stats collector — snapshots the scoreboard and player stats for yesterday.
 *
 * Usage: node daily-collect.js
 *
 * Run daily at 7 AM ET (after all games finish ~2 AM). Collects finalized stats
 * for the previous day and merges in roster positions from the nightly capture
 * (daily-positions.js, run at 11 PM ET when lineups are locked).
 *
 * ~11 API calls: 1 metadata + 1 scoreboard + 1 teams list + ~10 rosters ≈ 25s
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('yahoo-fantasy-api');
const { parseScoreboardResponse, parseTeamInfo, parseStatValues } = require('./yahoo-helpers');

const LEAGUE_ID = process.env.YAHOO_MLB_LEAGUE_ID || process.env.YAHOO_LEAGUE_ID;


const { auth, client } = createClient({
  tokenFile: path.resolve(__dirname, '.yahoo-token.json'),
  certsDir: path.resolve(__dirname, 'certs'),
  log: (type, msg) => console.log(`  [${type}] ${msg}`),
});


/**
 * Fetch all rosters with player positions and single-day stats.
 * Uses /players/stats;type=date;date=YYYY-MM-DD (not ;out=stats which returns cumulative).
 * Returns { teamKey: { name, players: [{ playerKey, name, selectedPosition, stats }] } }
 */
async function fetchDailyRosters(leagueKey, date) {
  const teams = await client.getLeagueTeams(leagueKey);
  const rosters = {};

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    console.log(`  Fetching roster ${i + 1}/${teams.length}: ${t.name}...`);
    const data = await client.get(`/team/${t.teamKey}/roster/players/stats;type=date;date=${date}`);

    const players = [];
    try {
      const playersData = data.fantasy_content.team[1].roster['0'].players;
      const count = playersData.count;
      for (let j = 0; j < count; j++) {
        const p = playersData[j].player;
        const info = parseTeamInfo(p[0]);
        const selectedPosition = p[1]?.selected_position?.[1]?.position || '';

        // Find stats — index varies, search for player_stats
        let stats = {};
        for (let k = 1; k < p.length; k++) {
          if (p[k]?.player_stats?.stats) {
            stats = parseStatValues(p[k].player_stats.stats);
            break;
          }
        }

        players.push({
          playerKey: info.player_key,
          name: info.name?.full || `${info.name?.first || ''} ${info.name?.last || ''}`.trim(),
          selectedPosition,
          stats,
        });
      }
    } catch (e) {
      console.log(`  Warning: failed to parse roster for ${t.name}: ${e.message}`);
    }

    rosters[t.teamKey] = {
      teamKey: t.teamKey,
      name: t.name,
      players,
    };
  }

  return rosters;
}

async function dailyCollect() {
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

  // Get current week
  const meta = await client.get(`/league/${leagueKey}/metadata`);
  let week = parseInt(meta.fantasy_content.league[0].current_week) || 1;

  // Collect yesterday's completed games (cron runs at 7 AM ET / 11:00 UTC).
  // Use ET-aware date to avoid UTC day-boundary issues.
  const now = new Date();
  const todayET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  todayET.setDate(todayET.getDate() - 1);
  const statsDate = todayET.toISOString().split('T')[0];

  // Fetch scoreboard — check if yesterday actually falls within this week.
  // On the first morning of a new week, Yahoo's current_week has already advanced,
  // but yesterday (Sunday) belongs to the previous week.
  console.log('Fetching scoreboard...');
  let rawData = await client.get(`/league/${leagueKey}/scoreboard;week=${week}`);
  const weekStart = rawData.fantasy_content.league[1].scoreboard['0'].matchups['0'].matchup.week_start;
  if (statsDate < weekStart) {
    week = week - 1;
    console.log(`  Stats date ${statsDate} is before week start ${weekStart}, using week ${week}`);
    rawData = await client.get(`/league/${leagueKey}/scoreboard;week=${week}`);
  }

  console.log(`Daily collect: Week ${week}, stats for ${statsDate}`);

  let scoreboard;
  try {
    scoreboard = parseScoreboardResponse(rawData);
  } catch (e) {
    console.error(`Failed to parse scoreboard: ${e.message}`);
    process.exit(1);
  }

  // Fetch rosters with yesterday's single-day player stats
  console.log(`Fetching rosters with ${statsDate} player stats...`);
  const rosterStats = await fetchDailyRosters(leagueKey, statsDate);

  // Save to daily directory
  const dailyDir = path.join(
    __dirname, 'snapshots',
    `week-${String(week).padStart(2, '0')}`,
    'daily'
  );
  fs.mkdirSync(dailyDir, { recursive: true });

  // Merge in accurate positions from the nightly capture (daily-positions.js).
  // The positions file was collected at 11 PM on statsDate when lineups were locked,
  // so it reflects the actual game-day positions (not next-morning positions).
  const positionsFile = path.join(dailyDir, `positions-${statsDate}.json`);
  let positionsSource = 'api';
  if (fs.existsSync(positionsFile)) {
    try {
      const posData = JSON.parse(fs.readFileSync(positionsFile, 'utf8'));
      // Build lookup: teamKey → { playerKey → selectedPosition }
      const posLookup = {};
      for (const [teamKey, team] of Object.entries(posData.positions)) {
        posLookup[teamKey] = {};
        for (const p of team.players) {
          posLookup[teamKey][p.playerKey] = p.selectedPosition;
        }
      }
      // Override positions in the stats rosters
      for (const [teamKey, team] of Object.entries(rosterStats)) {
        if (!posLookup[teamKey]) continue;
        for (const player of team.players) {
          if (posLookup[teamKey][player.playerKey] != null) {
            player.selectedPosition = posLookup[teamKey][player.playerKey];
          }
        }
      }
      positionsSource = 'nightly';
      console.log(`  Merged positions from nightly capture (${statsDate})`);
    } catch (e) {
      console.log(`  Warning: failed to read positions file, using API positions: ${e.message}`);
    }
  } else {
    console.log(`  No nightly positions file for ${statsDate} — using API positions (may be stale)`);
  }

  const snapshot = {
    date: statsDate,
    collectedAt: new Date().toISOString(),
    week: week,
    positionsSource,
    matchups: scoreboard,
    rosters: rosterStats,
  };

  const filename = `${statsDate}.json`;
  fs.writeFileSync(path.join(dailyDir, filename), JSON.stringify(snapshot, null, 2));
  console.log(`\nSaved ${filename} (${scoreboard.length} matchups, ${Object.keys(rosterStats).length} rosters)`);
}

if (require.main === module) {
  dailyCollect().catch(err => {
    console.error('Daily collect failed:', err.message);
    process.exit(1);
  });
}

module.exports = { dailyCollect };
