/**
 * Nightly position capture — snapshots roster positions at lineup lock.
 *
 * Usage: node daily-positions.js
 *
 * Run nightly at 11 PM ET when all lineups are locked for the day.
 * Captures TODAY's positions (not yesterday's), since games are still in progress.
 * The companion daily-collect.js (7 AM next morning) merges these positions
 * with finalized stats to produce accurate daily snapshots.
 *
 * ~11 API calls: 1 metadata + 1 teams list + ~10 rosters ≈ 20s
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('yahoo-fantasy-api');

const LEAGUE_ID = process.env.YAHOO_MLB_LEAGUE_ID || process.env.YAHOO_LEAGUE_ID;


const { auth, client } = createClient({
  tokenFile: path.resolve(__dirname, '.yahoo-token.json'),
  certsDir: path.resolve(__dirname, 'certs'),
  log: (type, msg) => console.log(`  [${type}] ${msg}`),
});

/**
 * Fetch all rosters with positions only (no stats).
 * Returns { teamKey: { name, players: [{ playerKey, name, selectedPosition }] } }
 */
async function fetchRosterPositions(leagueKey) {
  const teams = await client.getLeagueTeams(leagueKey);
  const rosters = {};

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    console.log(`  Fetching roster ${i + 1}/${teams.length}: ${t.name}...`);
    const data = await client.get(`/team/${t.teamKey}/roster`);

    const players = [];
    try {
      const playersData = data.fantasy_content.team[1].roster['0'].players;
      const count = playersData.count;
      for (let j = 0; j < count; j++) {
        const p = playersData[j].player;
        const info = {};
        for (const item of p[0]) {
          if (typeof item === 'object' && !Array.isArray(item)) {
            Object.assign(info, item);
          }
        }
        const selectedPosition = p[1]?.selected_position?.[1]?.position || '';

        players.push({
          playerKey: info.player_key,
          name: info.name?.full || `${info.name?.first || ''} ${info.name?.last || ''}`.trim(),
          selectedPosition,
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

async function dailyPositions() {
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
  const week = parseInt(meta.fantasy_content.league[0].current_week) || 1;

  // Capture TODAY's positions (lineups are locked by 11 PM ET).
  // Use ET-aware date since the cron runs at 03:00 UTC (11 PM ET) —
  // toISOString() would give the wrong (next) date in UTC.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  console.log(`Position capture: Week ${week}, date ${today}`);

  console.log('Fetching roster positions...');
  const positions = await fetchRosterPositions(leagueKey);

  // Save to daily directory as positions-YYYY-MM-DD.json
  const dailyDir = path.join(
    __dirname, 'snapshots',
    `week-${String(week).padStart(2, '0')}`,
    'daily'
  );
  fs.mkdirSync(dailyDir, { recursive: true });

  const snapshot = {
    date: today,
    collectedAt: new Date().toISOString(),
    week: week,
    positions,
  };

  const filename = `positions-${today}.json`;
  fs.writeFileSync(path.join(dailyDir, filename), JSON.stringify(snapshot, null, 2));
  console.log(`\nSaved ${filename} (${Object.keys(positions).length} rosters)`);
}

if (require.main === module) {
  dailyPositions().catch(err => {
    console.error('Position capture failed:', err.message);
    process.exit(1);
  });
}

module.exports = { dailyPositions };
