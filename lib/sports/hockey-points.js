/**
 * Hockey H2H Points profile — the KKUPFL scoring system. Shares the NHL
 * schedule and roster logic with the hockey (categories) profile, but players
 * and matchups are measured in fantasy points.
 *
 * Point values come from the league settings (stat_modifiers):
 *   Skaters: G 4.5, A 3, SHP 2, SOG 0.5, HIT 0.25, BLK 0.5
 *   Goalies: W 3, GA -1.5, SV 0.3, SHO 3
 */

const hockey = require('./hockey');
const { pointsScoring } = require('../scoring');

const SKATER_CATS = [
  { id: 1,  name: 'G',   abbr: 'G',   display: 'Goals' },
  { id: 2,  name: 'A',   abbr: 'A',   display: 'Assists' },
  { id: 11, name: 'SHP', abbr: 'SHP', display: 'Shorthanded Points' },
  { id: 14, name: 'SOG', abbr: 'SOG', display: 'Shots on Goal' },
  { id: 31, name: 'HIT', abbr: 'HIT', display: 'Hits' },
  { id: 32, name: 'BLK', abbr: 'BLK', display: 'Blocked Shots' },
];

const GOALIE_CATS = [
  { id: 19, name: 'W',   abbr: 'W',   display: 'Wins' },
  { id: 22, name: 'GA',  abbr: 'GA',  display: 'Goals Against', inverted: true },
  { id: 25, name: 'SV',  abbr: 'SV',  display: 'Saves' },
  { id: 27, name: 'SHO', abbr: 'SHO', display: 'Shutouts' },
];

// Not scored and not in the league's stat list; derived from scored stats
const DISPLAY_STATS = [];

const MODIFIERS = { G: 4.5, A: 3, SHP: 2, SOG: 0.5, HIT: 0.25, BLK: 0.5, W: 3, GA: -1.5, SV: 0.3, SHO: 3 };

// A goalie start usually swings 15-25 points; a 60-point margin is a rout
const scoring = pointsScoring({ modifiers: MODIFIERS, blowoutMargin: 60 });

const isNum = v => typeof v === 'number' && !isNaN(v);
const MIN_GOALIE_SHOTS_AGAINST = 20;

/**
 * Add the stats the hockey logic leans on (P, SA, SV%) plus fantasy points
 * (FPTS). Only derives from numeric values, so a "-" (did not play) line
 * stays empty.
 */
function deriveStats(stats) {
  if (isNum(stats.G) && isNum(stats.A)) stats.P = stats.G + stats.A;
  if (isNum(stats.SV) && isNum(stats.GA)) {
    stats.SA = stats.SV + stats.GA;
    if (stats.SA > 0) stats['SV%'] = stats.SV / stats.SA;
  }
  if (Object.keys(MODIFIERS).some(k => isNum(stats[k]))) stats.FPTS = scoring.fantasyPoints(stats);
  return stats;
}

function normalizeBenchStats(benchStats) {
  // SV% is a per-day ratio; summing it is meaningless. FPTS, P and SA add up.
  delete benchStats['SV%'];
  return benchStats;
}

// Roughly a goal and a couple of shots, or a goalie win on a normal workload
const NOTABLE_BENCH_POINTS = 8;

module.exports = {
  ...hockey,
  key: 'hockey-points',
  SKATER_CATS,
  GOALIE_CATS,
  DISPLAY_STATS,
  categoryGroups: [
    { key: 'skating', label: 'Skater', cats: SKATER_CATS },
    { key: 'goaltending', label: 'Goalie', cats: GOALIE_CATS },
  ],
  allCats: [...SKATER_CATS, ...GOALIE_CATS],
  displayStats: DISPLAY_STATS,
  // Derived helpers the writers shouldn't read as scored stats
  hiddenTeamStats: new Set(['SA', 'SV%']),
  scoring,
  deriveStats,

  playerGroups: [
    { key: 'skater', label: 'skater', title: 'SKATER OF THE WEEK', cats: SKATER_CATS, matches: pos => !hockey.isGoaliePosition(pos) },
    { key: 'goalie', label: 'goalie', title: 'GOALIE OF THE WEEK', cats: GOALIE_CATS, matches: hockey.isGoaliePosition,
      qualifies: stats => isNum(stats.SA) && stats.SA >= MIN_GOALIE_SHOTS_AGAINST },
  ],
  streamQualifies: stats => isNum(stats.SA) && stats.SA >= MIN_GOALIE_SHOTS_AGAINST,

  // Four IR+ slots, so a full IR isn't hoarding
  injuredHoardThreshold: null,
  blowoutWins: null,

  normalizeBenchStats,
  isNotableBenching: benchStats => (benchStats.FPTS || 0) >= NOTABLE_BENCH_POINTS,
  // In a points league every benched point is simply lost; no ratio to protect
  isDefensibleBenching: () => false,
  benchScore: benchStats => benchStats.FPTS || 0,

  narrative: {
    ...hockey.narrative,
    potwInstruction: 'Crown one skater and one goalie as the week\'s top fantasy point producers, then give brief nods to the runners-up. FPTS is each player\'s fantasy point total for the week. Focus on what made these performances special — multi-goal nights, a defenceman who piled up hits and blocks, a goalie who stood on his head. Use your hockey knowledge to add context about the players.',
    streamFocus: 'about the best goalie pickup — a netminder grabbed off waivers for a start or two. Focus on his fantasy points and the line behind them (wins, saves, goals against, shutouts).',
    weeklyTotalsExample: '"Then Sunday happened — 9 goals and 80 points" reads as if all of that came from one day, which is wrong',
    rankingsExample: '**#4 Top Shelf** — 3-1-0 (.750) — W, 231.4-198.6',
  },
};
