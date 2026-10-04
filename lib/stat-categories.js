/**
 * Yahoo Fantasy stat_id → category name mapping for the active league.
 *
 * Stat IDs are sport-specific (26 is ERA in baseball, SV% in hockey), so the
 * map comes from the active league's sport profile (lib/sports/*.js), chosen
 * by --league / LEAGUE (see lib/league.js).
 */

const { activeLeague } = require('./league');
const baseball = require('./sports/baseball');

const sport = activeLeague().sportProfile;

// Flat lookup: stat_id → name
const STAT_ID_MAP = {};
for (const cat of [...sport.allCats, ...sport.displayStats]) {
  STAT_ID_MAP[cat.id] = cat.name;
}

/**
 * Parse Yahoo's stat array format into a flat { statName: value } object.
 * Yahoo returns stats as: [{ stat: { stat_id: "7", value: "45" } }, ...]
 */
function parseYahooStats(statArray) {
  const stats = {};
  if (!Array.isArray(statArray)) return stats;

  for (const item of statArray) {
    const s = item?.stat;
    if (!s) continue;
    const name = STAT_ID_MAP[parseInt(s.stat_id)];
    if (name) {
      if (sport.rawStringStats.has(name)) {
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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\bjr\.?\b/g, '').replace(/\bsr\.?\b/g, '')
    .replace(/\biii\b/g, '').replace(/\bii\b/g, '')
    .replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ');
}

module.exports = {
  // Baseball category lists, kept for existing callers and tests
  BATTING_CATS: baseball.BATTING_CATS,
  PITCHING_CATS: baseball.PITCHING_CATS,
  DISPLAY_STATS: baseball.DISPLAY_STATS,
  STAT_ID_MAP,
  parseYahooStats,
  normalizeName,
};
