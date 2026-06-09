/**
 * Daily stats collector — snapshots the scoreboard and player stats for yesterday.
 *
 * Usage:
 *   node daily-collect.js                    # default: yesterday (ET)
 *   node daily-collect.js --date 2026-04-13  # backfill a specific date
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

/** Add `days` to a YYYY-MM-DD string (UTC math, returns YYYY-MM-DD). */
function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Is a nightly position capture trustworthy for fantasy date X?
 *
 * The capture is meant to run ~10:30 PM ET on X, after all of X's games (incl. West
 * Coast) have started — lineups are locked, so positions reflect X's actual game-day
 * roster. But GitHub Actions routinely delays scheduled runs by hours. A run that
 * slips past Yahoo's ~3 AM ET fantasy-day rollover instead reads the NEXT day's
 * not-yet-finalized lineup, producing phantom "benched" players the manager actually
 * started once they set their real lineup. Trust a capture only if it landed in X's
 * locked window: the evening of X (>= 9 PM ET) or the small hours of X+1 before the
 * 3 AM rollover. Anything else (e.g. an early-morning-of-X run) is premature.
 */
function isNightlyCaptureTrustworthy(collectedAtISO, fantasyDate) {
  if (!collectedAtISO) return false;
  const et = new Date(collectedAtISO).toLocaleString('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const [etDate, etTime] = et.split(/,?\s+/);
  const etHour = parseInt(etTime.split(':')[0], 10) % 24; // normalize a "24:00" midnight
  const nextDate = addDaysISO(fantasyDate, 1);
  if (etDate === fantasyDate && etHour >= 21) return true; // on-time evening capture
  if (etDate === nextDate && etHour < 3) return true;      // delayed but pre-rollover
  return false;
}


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
  // Override with --date YYYY-MM-DD for backfills.
  const dateArgIdx = process.argv.indexOf('--date');
  let statsDate;
  if (dateArgIdx !== -1 && process.argv[dateArgIdx + 1]) {
    statsDate = process.argv[dateArgIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(statsDate)) {
      console.error(`Invalid --date value: ${statsDate} (expected YYYY-MM-DD)`);
      process.exit(1);
    }
  } else {
    const now = new Date();
    const todayET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    todayET.setDate(todayET.getDate() - 1);
    statsDate = todayET.toISOString().split('T')[0];
  }

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
  let positionsCapturedAt = null;
  if (fs.existsSync(positionsFile)) {
    try {
      const posData = JSON.parse(fs.readFileSync(positionsFile, 'utf8'));
      positionsCapturedAt = posData.collectedAt || null;
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
      // Only label the capture "nightly" (trusted by bench detection) if it actually
      // landed in the locked window. A delayed run that slipped past Yahoo's 3 AM
      // rollover captured the next day's premature lineup — mark it so analyze skips it.
      if (isNightlyCaptureTrustworthy(positionsCapturedAt, statsDate)) {
        positionsSource = 'nightly';
        console.log(`  Merged positions from nightly capture (${statsDate}, captured ${positionsCapturedAt})`);
      } else {
        positionsSource = 'nightly-premature';
        console.log(`  WARNING: nightly capture for ${statsDate} landed outside the locked window (captured ${positionsCapturedAt}) — likely a post-rollover/premature lineup. Marking 'nightly-premature' so bench detection skips it.`);
      }
    } catch (e) {
      console.log(`  Warning: failed to read positions file, using API positions: ${e.message}`);
    }
  } else {
    console.log(`  No nightly positions file for ${statsDate} — using API positions (may be stale)`);
  }

  // NOTE: do not re-run this for a past date to "repair" a snapshot. Yahoo only serves
  // *current* cumulative stats and the *current* roster composition, so a re-collection
  // overwrites the matchups (end-of-week totals instead of cumulative-as-of-day) and the
  // roster membership (today's roster, not who was rostered that day). To re-evaluate
  // positionsSource on existing snapshots without re-fetching, use revalidate-positions.js.
  const snapshot = {
    date: statsDate,
    collectedAt: new Date().toISOString(),
    week: week,
    positionsSource,
    positionsCapturedAt,
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

module.exports = { dailyCollect, isNightlyCaptureTrustworthy, addDaysISO };
