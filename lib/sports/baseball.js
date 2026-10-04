/**
 * Baseball sport profile — Yahoo stat IDs, player groups, and the
 * baseball-specific judgement calls (bench blunders, dead weight, streams).
 *
 * Stat IDs are configured for Dad's Baseball League (H2H Categories). To
 * customize, run `npx yahoo-fantasy-api league-settings <key>` and update them.
 */

// Scoring categories (12 total)
const BATTING_CATS = [
  { id: 7,  name: 'R',    abbr: 'R',     display: 'Runs' },
  { id: 12, name: 'HR',   abbr: 'HR',    display: 'Home Runs' },
  { id: 13, name: 'RBI',  abbr: 'RBI',   display: 'RBI' },
  { id: 16, name: 'SB',   abbr: 'SB',    display: 'Stolen Bases' },
  { id: 3,  name: 'AVG',  abbr: 'AVG',   display: 'Batting Average', inverted: false },
  { id: 4,  name: 'OBP',  abbr: 'OBP',   display: 'On-Base Percentage', inverted: false },
];

const PITCHING_CATS = [
  { id: 42, name: 'K',     abbr: 'K',     display: 'Strikeouts' },
  { id: 26, name: 'ERA',   abbr: 'ERA',   display: 'ERA', inverted: true },
  { id: 27, name: 'WHIP',  abbr: 'WHIP',  display: 'WHIP', inverted: true },
  { id: 56, name: 'K/BB',  abbr: 'K/BB',  display: 'K/BB Ratio' },
  { id: 83, name: 'QS',    abbr: 'QS',    display: 'Quality Starts' },
  { id: 89, name: 'SV+H',  abbr: 'SV+H',  display: 'Saves + Holds' },
];

// Display-only stats (not scored)
const DISPLAY_STATS = [
  { id: 60, name: 'H/AB',  display: 'Hits / At Bats' },
  { id: 50, name: 'IP',    display: 'Innings Pitched' },
];

const PITCHING_POSITIONS = ['SP', 'RP', 'P'];
const isPitcherPosition = pos => PITCHING_POSITIONS.some(p => (pos || '').includes(p));

/**
 * Fetch MLB game start times for a date range.
 * Returns a Map: "TEAM_ABBREV|YYYY-MM-DD" → game start timestamp (Unix seconds).
 * Uses the free MLB Stats API (no auth required).
 */
async function fetchGameStartTimes(startDate, endDate) {
  const gameStarts = new Map();
  const url = `https://statsapi.mlb.com/api/v1/schedule?startDate=${startDate}&endDate=${endDate}&sportId=1`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    // Fetch team abbreviations
    const teamsResp = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=' + startDate.substring(0, 4));
    const teamsData = await teamsResp.json();
    const idToAbbrev = {};
    for (const t of teamsData.teams) idToAbbrev[t.id] = t.abbreviation;

    for (const dateEntry of (data.dates || [])) {
      for (const game of dateEntry.games) {
        const startTs = Math.floor(new Date(game.gameDate).getTime() / 1000);
        const date = game.officialDate;
        for (const side of ['away', 'home']) {
          const abbrev = idToAbbrev[game.teams[side].team.id];
          if (abbrev) {
            const key = `${abbrev}|${date}`;
            // Keep earliest game if doubleheader
            if (!gameStarts.has(key) || startTs < gameStarts.get(key)) {
              gameStarts.set(key, startTs);
            }
          }
        }
      }
    }
  } catch (e) {
    console.log(`  Warning: could not fetch MLB schedule: ${e.message}`);
  }

  return gameStarts;
}

/**
 * Clean up stats summed across a player's benched days so they read correctly.
 */
function normalizeBenchStats(benchStats) {
  // Drop daily ratio stats (AVG, OBP, ERA, WHIP, K/BB) — they can't be summed
  delete benchStats['AVG'];
  delete benchStats['OBP'];
  delete benchStats['ERA'];
  delete benchStats['WHIP'];
  delete benchStats['K/BB'];
  // Daily H/AB parses to a bare hits count (the AB half is dropped), so the
  // sum is just hits. Label it H — "H/AB: 5" reads as a ratio and tempts
  // writers to invent an at-bat denominator.
  if (benchStats['H/AB'] != null) {
    benchStats['H'] = benchStats['H/AB'];
    delete benchStats['H/AB'];
  }
  return benchStats;
}

/**
 * Was this benching bad enough to roast? Uses counting-stat thresholds instead
 * of z-scores (which are calibrated for full-week totals and would filter out
 * every single-day bench blunder).
 */
function isNotableBenching(benchStats, benchedDayStats) {
  const isBatter = (benchStats['H'] != null || benchStats['R'] != null);
  const isPitcher = (benchStats['IP'] != null || benchStats['K'] != null);
  if (isBatter) {
    return (benchStats['HR'] >= 1 || benchStats['RBI'] >= 3 || benchStats['SB'] >= 2 || benchStats['R'] >= 3);
  }
  if (isPitcher) {
    // QS or SV+H on any benched day (SV+H caps at 1 per day).
    // For ratio check, use per-day ERA/WHIP from the raw daily stats
    // (not the summed benchStats where ratios were dropped).
    // A start with ERA < 3 and WHIP < 1.2 is always worth starting.
    if (benchStats['QS'] >= 1 || benchStats['SV+H'] >= 1) return true;
    return benchedDayStats.some(day =>
      day['IP'] > 0 && day['ERA'] != null && day['WHIP'] != null
      && day['ERA'] < 3 && day['WHIP'] < 1.2
    );
  }
  return false;
}

/**
 * Rank bench blunders by simple fantasy points (z-scores are calibrated for
 * weekly totals and produce nonsensical rankings for daily counting stats).
 */
function benchScore(benchStats) {
  return (benchStats['R'] || 0) * 1 + (benchStats['HR'] || 0) * 4
    + (benchStats['RBI'] || 0) * 1 + (benchStats['SB'] || 0) * 2
    + (benchStats['K'] || 0) * 1 + (benchStats['QS'] || 0) * 5
    + (benchStats['SV+H'] || 0) * 3;
}

/**
 * Compute rolling batting stats from recent weekly roster snapshots.
 * Looks back up to ROLLING_WEEKS weeks and sums H/AB to compute rolling AVG/OBP.
 * Returns { playerKey: { hits, ab, avg, obp, weeks } }
 */
const ROLLING_WEEKS = 3;

function computeRecentPlayerStats(currentWeek, loadWeeklyRosters) {
  const playerTotals = {};
  let weeksFound = 0;

  for (let w = currentWeek; w >= 1 && w > currentWeek - ROLLING_WEEKS; w--) {
    const weeklyRosters = loadWeeklyRosters(w);
    if (!weeklyRosters) continue;
    weeksFound++;

    for (const roster of Object.values(weeklyRosters)) {
      for (const player of roster.players) {
        const hab = player.stats?.['H/AB'];
        if (hab == null) continue;
        // H/AB can be a number (from parseYahooStats) or string "5/20"
        let hits = 0, ab = 0;
        if (typeof hab === 'string' && hab.includes('/')) {
          const parts = hab.split('/');
          hits = parseInt(parts[0]) || 0;
          ab = parseInt(parts[1]) || 0;
        }
        if (ab === 0) continue;

        if (!playerTotals[player.playerKey]) {
          playerTotals[player.playerKey] = { hits: 0, ab: 0, obpNumer: 0, obpDenom: 0 };
        }
        playerTotals[player.playerKey].hits += hits;
        playerTotals[player.playerKey].ab += ab;

        // For OBP: use weekly OBP × PA as a rough weighted average
        const obp = player.stats?.OBP;
        if (obp != null && !isNaN(obp)) {
          // Approximate PA ≈ AB * 1.1 (rough)
          const pa = Math.round(ab * 1.1);
          playerTotals[player.playerKey].obpNumer += obp * pa;
          playerTotals[player.playerKey].obpDenom += pa;
        }
      }
    }
  }

  // Compute rolling averages
  const result = {};
  for (const [key, totals] of Object.entries(playerTotals)) {
    if (totals.ab < 1) continue;
    result[key] = {
      hits: totals.hits,
      ab: totals.ab,
      avg: totals.hits / totals.ab,
      obp: totals.obpDenom > 0 ? totals.obpNumer / totals.obpDenom : 0,
      weeks: weeksFound,
    };
  }
  return result;
}

/**
 * Roster dead weight — rostered hitters with terrible rolling stats.
 * Uses recent weekly snapshots (last 3 weeks) to compute rolling averages.
 * Falls back to season stats if not enough weekly data.
 */
function findDeadWeight({ rosters, teamNames, week, loadWeeklyRosters }) {
  const roasts = [];
  if (!rosters) return roasts;
  const recentPlayerStats = computeRecentPlayerStats(week, loadWeeklyRosters);

  for (const roster of Object.values(rosters)) {
    for (const player of roster.players) {
      const rolling = recentPlayerStats?.[player.playerKey];
      if (rolling && rolling.ab >= 20 && rolling.avg < 0.150) {
        roasts.push({
          type: 'dead_weight',
          playerName: player.name,
          playerTeam: player.team,
          position: player.displayPosition,
          fantasyTeam: teamNames[roster.teamKey] || roster.name,
          stats: { AVG: rolling.avg, OBP: rolling.obp, AB: rolling.ab, weeks: rolling.weeks },
          score: 0,
          description: `Still rostering ${player.name} who is hitting ${rolling.avg.toFixed(3)} over the last ${rolling.weeks} week${rolling.weeks > 1 ? 's' : ''}`,
        });
      } else if (!rolling && player.stats?.AVG != null && player.stats.AVG < 0.150 && player.stats['H/AB']) {
        // Fallback to season stats if no weekly data
        const hab = String(player.stats['H/AB']);
        const parts = hab.split('/');
        const ab = parts.length === 2 ? parseInt(parts[1]) : 0;
        if (ab >= 30) {
          roasts.push({
            type: 'dead_weight',
            playerName: player.name,
            playerTeam: player.team,
            position: player.displayPosition,
            fantasyTeam: teamNames[roster.teamKey] || roster.name,
            stats: { AVG: player.stats.AVG, OBP: player.stats.OBP, AB: ab },
            score: 0,
            description: `Still rostering ${player.name} who is hitting ${player.stats.AVG.toFixed(3)} on the season`,
          });
        }
      }
    }
  }
  return roasts;
}

module.exports = {
  key: 'baseball',
  proLeague: 'MLB',
  BATTING_CATS,
  PITCHING_CATS,
  DISPLAY_STATS,
  categoryGroups: [
    { key: 'batting', label: 'Batting', cats: BATTING_CATS },
    { key: 'pitching', label: 'Pitching', cats: PITCHING_CATS },
  ],
  allCats: [...BATTING_CATS, ...PITCHING_CATS],
  displayStats: DISPLAY_STATS,
  // Stats kept as raw strings (contain non-numeric data like "5/20")
  rawStringStats: new Set(['H/AB']),
  // Yahoo sometimes emits a bare numeric `H/AB` at the team level (the hits
  // count with the at-bats half dropped), which writers read as a phantom
  // "hits" category — hide it from team stat lines.
  hiddenTeamStats: new Set(['H/AB']),

  // Player groups for Players of the Week. `group` decides which of a
  // player's stats count toward his z-score.
  playerGroups: [
    { key: 'batter', label: 'batter', title: 'BATTER OF THE WEEK', cats: BATTING_CATS, matches: pos => !isPitcherPosition(pos) },
    { key: 'pitcher', label: 'pitcher', title: 'PITCHER OF THE WEEK', cats: PITCHING_CATS, matches: isPitcherPosition },
  ],
  groupForPosition: pos => (isPitcherPosition(pos) ? 'pitcher' : 'batter'),
  pickupGroup: 'batter',
  streamGroup: 'pitcher',
  // A stream implies a starting pitcher: require 5+ IP so tiny relief
  // lines (2 IP, ERA 0.00) can't dominate the z-score ranking.
  streamQualifies: stats => Number(stats.IP) >= 5,

  benchSlot: 'BN',
  inactiveSlots: ['BN', 'IL', 'IL+'],
  injuredSlots: ['IL', 'IL+'],
  injuredHoardThreshold: 3,
  blowoutWins: 8,
  defaultMinIP: 30,

  fetchGameStartTimes,
  normalizeBenchStats,
  isNotableBenching,
  benchScore,
  findDeadWeight,

  narrative: {
    sport: 'baseball',
    potwInstruction: 'Crown one batter and one pitcher as the week\'s standout stars, then give brief nods to the runners-up. Focus on what made these performances special — historic stat lines, clutch timing, or absurd dominance. Use your baseball knowledge to add context about the players.',
    streamFocus: 'about the best pitcher streaming decision. Focus on the pitching line.',
    streamListLabel: 'Top pitcher streams',
    weeklyTotalsExample: '"Then Sunday happened — 14 HR, 45 RBI" reads as if all of that came from one day, which is wrong',
    rankingsExample: '**#4 Big Bats** — 88-63-5 (.580) — W, 7-5-0',
    rumourPlaceholder: 'e.g., Jarren Duran is on the trade block. His manager is looking for pitching help...',
  },
};
