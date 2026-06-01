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
 * Which fantasy week does an ET date fall in? Mirrors collect.js's Mon-Sun
 * boundary logic, derived from the season start date. Anchored at 04:00 UTC
 * (= midnight ET) so the UTC calendar date equals the ET date and boundaries
 * are timezone-independent. Used instead of the live current_week so a delayed
 * Sunday-night capture isn't misfiled when Yahoo rolls the week over early Monday.
 */
function weekForDate(dateStr, seasonStartStr) {
  const date = new Date(dateStr + 'T04:00:00Z');
  const start = new Date(seasonStartStr + 'T04:00:00Z');
  // End of week 1 = first Sunday on/after the season start.
  const firstSunday = new Date(start);
  const dow = firstSunday.getUTCDay(); // 0 = Sunday
  firstSunday.setUTCDate(firstSunday.getUTCDate() + (dow === 0 ? 0 : 7 - dow));
  if (date <= firstSunday) return 1;
  // Week 2 begins the Monday after week 1's Sunday; every week after is 7 days.
  const mondayWeek2 = new Date(firstSunday);
  mondayWeek2.setUTCDate(mondayWeek2.getUTCDate() + 1);
  const days = Math.floor((date - mondayWeek2) / 86400000);
  return 2 + Math.floor(days / 7);
}

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

  // Get league metadata (season start drives the week-from-date math below).
  const meta = await client.get(`/league/${leagueKey}/metadata`);
  const seasonStart = meta.fantasy_content.league[0].start_date;

  // Capture the just-completed day's positions (lineups are locked by 11 PM ET).
  // Cron fires at 03:00 UTC (11 PM ET prev day in EDT) — the intended moment —
  // but GitHub Actions delays scheduled runs unpredictably, pushing actual run
  // time anywhere from ~03:30 UTC to several hours later (observed up to 08:17
  // UTC). A fixed "subtract N hours" buffer is fragile: a 3h buffer caught the
  // routine ~3.5h slip but a ~5.3h delay once blew past it, misdating the file
  // a day forward (see week 10 / 2026-05-31).
  //
  // Robust rule: the target ET day is always one calendar day before the run's
  // UTC date. The cron fires at 03:00 UTC, which is already the UTC day AFTER
  // the ET day whose games just finished; any same-night delay (up to ~20h)
  // stays within that same UTC day, so "(UTC date of now) − 1 day" is stable
  // across the full plausible delay window.
  const nowUtc = new Date();
  const target = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() - 1));
  const today = target.toISOString().slice(0, 10);

  // Derive the week from the captured date, NOT the live current_week. Yahoo
  // rolls current_week over sometime in the early hours of Monday ET; a Sunday
  // capture delayed past that rollover would otherwise read the NEXT week and
  // be filed into the wrong week folder (see week 10 / 2026-05-31).
  const week = weekForDate(today, seasonStart);

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

module.exports = { dailyPositions, weekForDate };
