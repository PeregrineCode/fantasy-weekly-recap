/**
 * Hockey sport profile — Yahoo stat IDs, player groups, and the
 * hockey-specific judgement calls (bench blunders, dead weight, goalie streams).
 *
 * Stat IDs are configured for Dad's Hockey League (H2H Categories, 9 cats).
 * To customize, run `npx yahoo-fantasy-api league-settings <key>`.
 */

// Scoring categories (9 total)
const SKATER_CATS = [
  { id: 1,  name: 'G',   abbr: 'G',   display: 'Goals' },
  { id: 2,  name: 'A',   abbr: 'A',   display: 'Assists' },
  { id: 3,  name: 'P',   abbr: 'P',   display: 'Points' },
  { id: 14, name: 'SOG', abbr: 'SOG', display: 'Shots on Goal' },
  { id: 31, name: 'HIT', abbr: 'HIT', display: 'Hits' },
  { id: 32, name: 'BLK', abbr: 'BLK', display: 'Blocked Shots' },
];

const GOALIE_CATS = [
  { id: 19, name: 'W',   abbr: 'W',   display: 'Wins' },
  { id: 23, name: 'GAA', abbr: 'GAA', display: 'Goals Against Average', inverted: true },
  { id: 26, name: 'SV%', abbr: 'SV%', display: 'Save Percentage' },
];

// Display-only stats (not scored)
const DISPLAY_STATS = [
  { id: 22, name: 'GA', display: 'Goals Against' },
  { id: 25, name: 'SV', display: 'Saves' },
  { id: 24, name: 'SA', display: 'Shots Against' },
];

const isGoaliePosition = pos => (pos || '').split(',').map(s => s.trim()).includes('G');

// Roughly one full start. Keeps a 10-minute relief cameo (0.00 GAA, 1.000 SV%)
// from topping goalie rankings on ratio stats alone.
const MIN_GOALIE_SHOTS_AGAINST = 20;

// NHL API abbreviations that differ from Yahoo's editorial_team_abbr
const NHL_TO_YAHOO_ABBR = { LAK: 'LA', NJD: 'NJ', SJS: 'SJ', TBL: 'TB' };

/**
 * Fetch NHL game start times for a date range.
 * Returns a Map: "TEAM_ABBREV|YYYY-MM-DD" → game start timestamp (Unix seconds),
 * keyed by Yahoo team abbreviations. Uses the free NHL web API (no auth).
 * The schedule endpoint returns one week per call starting at the given date.
 */
async function fetchGameStartTimes(startDate, endDate) {
  const gameStarts = new Map();
  let cursor = startDate;

  try {
    for (let page = 0; cursor && cursor <= endDate && page < 4; page++) {
      const resp = await fetch(`https://api-web.nhle.com/v1/schedule/${cursor}`);
      const data = await resp.json();
      for (const day of data.gameWeek || []) {
        if (day.date < startDate || day.date > endDate) continue;
        for (const game of day.games || []) {
          const startTs = Math.floor(new Date(game.startTimeUTC).getTime() / 1000);
          for (const side of ['awayTeam', 'homeTeam']) {
            const nhlAbbr = game[side]?.abbrev;
            if (!nhlAbbr) continue;
            const key = `${NHL_TO_YAHOO_ABBR[nhlAbbr] || nhlAbbr}|${day.date}`;
            if (!gameStarts.has(key) || startTs < gameStarts.get(key)) {
              gameStarts.set(key, startTs);
            }
          }
        }
      }
      cursor = data.nextStartDate;
    }
  } catch (e) {
    console.log(`  Warning: could not fetch NHL schedule: ${e.message}`);
  }

  return gameStarts;
}

/**
 * Clean up stats summed across a player's benched days so they read correctly.
 */
function normalizeBenchStats(benchStats) {
  // GAA and SV% are per-day ratios — summing them is meaningless
  delete benchStats['GAA'];
  delete benchStats['SV%'];
  return benchStats;
}

/**
 * Was this benching bad enough to roast? Counting-stat thresholds, since
 * z-scores are calibrated for full-week totals.
 */
function isNotableBenching(benchStats, benchedDayStats) {
  const isGoalie = benchStats['W'] != null || benchStats['SA'] != null;
  if (isGoalie) {
    // A win on the bench, or any benched start at .920+ on a real workload
    if (benchStats['W'] >= 1) return true;
    return benchedDayStats.some(day =>
      day['SA'] >= MIN_GOALIE_SHOTS_AGAINST && day['SV'] != null && day['SV'] / day['SA'] >= 0.920
    );
  }
  return (benchStats['G'] >= 1 || benchStats['P'] >= 2 || benchStats['SOG'] >= 8
    || ((benchStats['HIT'] || 0) + (benchStats['BLK'] || 0)) >= 8);
}

/**
 * Rank bench blunders by simple fantasy points.
 */
function benchScore(benchStats) {
  return (benchStats['G'] || 0) * 3 + (benchStats['A'] || 0) * 2
    + (benchStats['SOG'] || 0) * 0.5 + (benchStats['HIT'] || 0) * 0.3
    + (benchStats['BLK'] || 0) * 0.5 + (benchStats['W'] || 0) * 5
    + (benchStats['SV'] || 0) * 0.1;
}

const ROLLING_WEEKS = 3;
const num = v => (typeof v === 'number' && !isNaN(v) ? v : 0);

/**
 * Sum skater points/shots and goalie saves/shots-against over the last
 * ROLLING_WEEKS weekly roster snapshots.
 * Returns { playerKey: { P, SOG, SV, SA, weeks } } where weeks counts the
 * weeks the player actually recorded stats.
 */
function computeRecentPlayerStats(currentWeek, loadWeeklyRosters) {
  const totals = {};
  for (let w = currentWeek; w >= 1 && w > currentWeek - ROLLING_WEEKS; w--) {
    const weeklyRosters = loadWeeklyRosters(w);
    if (!weeklyRosters) continue;
    const seen = new Set();
    for (const roster of Object.values(weeklyRosters)) {
      for (const player of roster.players) {
        if (seen.has(player.playerKey)) continue;
        const s = player.stats || {};
        const played = Object.values(s).some(v => typeof v === 'number' && !isNaN(v));
        if (!played) continue;
        seen.add(player.playerKey);
        const t = totals[player.playerKey] || (totals[player.playerKey] = { P: 0, SOG: 0, SV: 0, SA: 0, weeks: 0 });
        t.P += num(s.P);
        t.SOG += num(s.SOG);
        t.SV += num(s.SV);
        t.SA += num(s.SA);
        t.weeks++;
      }
    }
  }
  return totals;
}

const fmtSvPct = v => v.toFixed(3).replace(/^0/, '');

/**
 * Roster dead weight — skaters who keep shooting without ever scoring a point,
 * and goalies leaking goals. Uses the last few weekly snapshots; falls back to
 * season stats before there are two weeks of data.
 */
function findDeadWeight({ rosters, teamNames, week, loadWeeklyRosters }) {
  const roasts = [];
  if (!rosters) return roasts;
  const recent = computeRecentPlayerStats(week, loadWeeklyRosters);

  for (const roster of Object.values(rosters)) {
    for (const player of roster.players) {
      if (['IR', 'IR+'].includes(player.selectedPosition)) continue;
      const base = {
        type: 'dead_weight',
        playerName: player.name,
        playerTeam: player.team,
        position: player.displayPosition,
        fantasyTeam: teamNames[roster.teamKey] || roster.name,
        score: 0,
      };
      const goalie = isGoaliePosition(player.displayPosition);
      const r = recent[player.playerKey];

      if (r && r.weeks >= 2) {
        const span = `the last ${r.weeks} weeks`;
        if (!goalie && r.P === 0 && r.SOG >= 6) {
          roasts.push({ ...base, stats: { P: 0, SOG: r.SOG, weeks: r.weeks },
            description: `Still rostering ${player.name}, who has zero points over ${span} despite ${r.SOG} shots` });
        } else if (goalie && r.SA >= 75 && r.SV / r.SA < 0.870) {
          roasts.push({ ...base, stats: { 'SV%': r.SV / r.SA, SA: r.SA, weeks: r.weeks },
            description: `Still rostering ${player.name}, who has a ${fmtSvPct(r.SV / r.SA)} save percentage over ${span}` });
        }
      } else {
        // Not enough weekly history yet — use season totals
        const s = player.stats || {};
        if (!goalie && s.P === 0 && num(s.SOG) >= 10) {
          roasts.push({ ...base, stats: { P: 0, SOG: s.SOG },
            description: `Still rostering ${player.name}, who has zero points on the season despite ${s.SOG} shots` });
        } else if (goalie && num(s.SA) >= 100 && num(s['SV%']) > 0 && s['SV%'] < 0.870) {
          roasts.push({ ...base, stats: { 'SV%': s['SV%'], SA: s.SA },
            description: `Still rostering ${player.name}, who has a ${fmtSvPct(s['SV%'])} save percentage on the season` });
        }
      }
    }
  }
  return roasts;
}

module.exports = {
  key: 'hockey',
  proLeague: 'NHL',
  SKATER_CATS,
  GOALIE_CATS,
  DISPLAY_STATS,
  categoryGroups: [
    { key: 'skating', label: 'Skater', cats: SKATER_CATS },
    { key: 'goaltending', label: 'Goalie', cats: GOALIE_CATS },
  ],
  allCats: [...SKATER_CATS, ...GOALIE_CATS],
  displayStats: DISPLAY_STATS,
  rawStringStats: new Set(),
  // Goalie volume stats aren't categories; showing them in team lines invites
  // writers to count them as one.
  hiddenTeamStats: new Set(['GA', 'SV', 'SA']),

  playerGroups: [
    { key: 'skater', label: 'skater', title: 'SKATER OF THE WEEK', cats: SKATER_CATS, matches: pos => !isGoaliePosition(pos) },
    { key: 'goalie', label: 'goalie', title: 'GOALIE OF THE WEEK', cats: GOALIE_CATS, matches: isGoaliePosition,
      qualifies: stats => num(stats.SA) >= MIN_GOALIE_SHOTS_AGAINST },
  ],
  groupForPosition: pos => (isGoaliePosition(pos) ? 'goalie' : 'skater'),
  pickupGroup: 'skater',
  streamGroup: 'goalie',
  streamQualifies: stats => num(stats.SA) >= MIN_GOALIE_SHOTS_AGAINST,

  benchSlot: 'BN',
  inactiveSlots: ['BN', 'IR', 'IR+'],
  injuredSlots: ['IR', 'IR+'],
  // The league has three IR slots, so filling them isn't hoarding
  injuredHoardThreshold: null,
  blowoutWins: 7,
  defaultMinIP: null,

  fetchGameStartTimes,
  normalizeBenchStats,
  isNotableBenching,
  benchScore,
  findDeadWeight,

  narrative: {
    sport: 'hockey',
    potwInstruction: 'Crown one skater and one goalie as the week\'s standout stars, then give brief nods to the runners-up. Focus on what made these performances special — multi-goal nights, a defenceman who did everything, a goalie who stood on his head. Use your hockey knowledge to add context about the players.',
    streamFocus: 'about the best goalie pickup — a netminder grabbed off waivers for a start or two. Focus on the goaltending line (wins, GAA, save percentage, saves).',
    streamListLabel: 'Top goalie streams',
    weeklyTotalsExample: '"Then Sunday happened — 9 goals, 40 hits" reads as if all of that came from one day, which is wrong',
    rankingsExample: '**#4 Top Shelf** — 61-40-9 (.595) — W, 6-3-0',
    rumourPlaceholder: 'e.g., Connor Bedard is on the trade block. His manager is looking for help on defence...',
  },
};
