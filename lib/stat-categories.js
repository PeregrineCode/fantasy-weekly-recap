/**
 * Yahoo Fantasy stat_id → category name mapping.
 *
 * These are configured for a standard Yahoo H2H Categories baseball league.
 * To customize for your league, run `npx yahoo-fantasy-api league-settings <key>`
 * and update the stat IDs below to match your league's scoring categories.
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

// Flat lookup: stat_id → name
const STAT_ID_MAP = {};
for (const cat of [...BATTING_CATS, ...PITCHING_CATS, ...DISPLAY_STATS]) {
  STAT_ID_MAP[cat.id] = cat.name;
}

/**
 * Parse Yahoo's stat array format into a flat { statName: value } object.
 * Yahoo returns stats as: [{ stat: { stat_id: "7", value: "45" } }, ...]
 */
// Stats that should be kept as raw strings (contain non-numeric data like "5/20")
const RAW_STRING_STATS = new Set(['H/AB']);

function parseYahooStats(statArray) {
  const stats = {};
  if (!Array.isArray(statArray)) return stats;

  for (const item of statArray) {
    const s = item?.stat;
    if (!s) continue;
    const name = STAT_ID_MAP[parseInt(s.stat_id)];
    if (name) {
      if (RAW_STRING_STATS.has(name)) {
        stats[name] = s.value;
      } else {
        const val = parseFloat(s.value);
        stats[name] = isNaN(val) ? s.value : val;
      }
    }
  }
  return stats;
}

/**
 * Normalize a player name for matching across data sources.
 * Strips accents, suffixes (Jr, Sr, III), and punctuation.
 */
function normalizeName(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bjr\.?\b/g, '').replace(/\bsr\.?\b/g, '')
    .replace(/\biii\b/g, '').replace(/\bii\b/g, '')
    .replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ');
}

module.exports = {
  BATTING_CATS,
  PITCHING_CATS,
  DISPLAY_STATS,
  STAT_ID_MAP,
  parseYahooStats,
  normalizeName,
};
