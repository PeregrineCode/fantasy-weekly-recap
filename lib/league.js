/**
 * League registry. Every pipeline script serves one league per run, picked by
 * `--league <id>` on the command line or the LEAGUE env var (default: baseball).
 *
 * Baseball predates multi-league support, so it keeps its data, prompts, and
 * env var names at the repo root. Every other league lives under
 * leagues/<id>/ and reads env vars with its prefix (e.g. HOCKEY_DEPLOY_REPO).
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const LEAGUES = {
  baseball: {
    id: 'baseball',
    sport: 'baseball',
    gameCode: 'mlb',
    dir: ROOT,
    envPrefix: '',
    leagueIdEnv: ['YAHOO_MLB_LEAGUE_ID', 'YAHOO_LEAGUE_ID'],
    defaultLeagueId: null,
    defaultName: 'Fantasy Baseball League',
    defaultFaabBudget: 200,
    // Nate left the league in July 2026; his team (t.7, Risky Bettiness) is
    // unmanaged. It stays in league-wide segments (matchups, standings, power
    // rankings, movers) but is excluded from editorial features (players of the
    // week, pickups, streams, bench blunders) — there's no manager to credit or roast.
    abandonedTeamSuffixes: ['.t.7'],
  },
  hockey: {
    id: 'hockey',
    sport: 'hockey',
    gameCode: 'nhl',
    dir: path.join(ROOT, 'leagues', 'hockey'),
    envPrefix: 'HOCKEY_',
    leagueIdEnv: ['YAHOO_NHL_LEAGUE_ID'],
    defaultLeagueId: '48642', // Dad's Hockey League 10.0 (477.l.48642)
    defaultName: 'Fantasy Hockey League',
    defaultFaabBudget: 100,
    abandonedTeamSuffixes: [],
  },
};

function resolveLeagueId(argv = process.argv, env = process.env) {
  const idx = argv.indexOf('--league');
  const id = idx !== -1 ? argv[idx + 1] : (env.LEAGUE || 'baseball');
  if (!LEAGUES[id]) {
    throw new Error(`Unknown league "${id}". Valid leagues: ${Object.keys(LEAGUES).join(', ')}`);
  }
  return id;
}

function getLeague(id, env = process.env) {
  const cfg = LEAGUES[id];
  if (!cfg) throw new Error(`Unknown league "${id}". Valid leagues: ${Object.keys(LEAGUES).join(', ')}`);

  // League-scoped setting: FAAB_BUDGET for baseball, HOCKEY_FAAB_BUDGET for hockey
  const setting = name => env[cfg.envPrefix + name];

  return {
    ...cfg,
    sportProfile: require(`./sports/${cfg.sport}`),
    paths: {
      snapshots: path.join(cfg.dir, 'snapshots'),
      articles: path.join(cfg.dir, 'articles'),
      site: path.join(cfg.dir, 'site'),
      deploy: path.join(cfg.dir, '.deploy'),
      prompts: path.join(cfg.dir, 'prompts'),
      data: path.join(cfg.dir, 'data'),
    },
    setting,
    yahooLeagueId: () => cfg.leagueIdEnv.map(k => env[k]).find(Boolean) || cfg.defaultLeagueId,
    deployRepo: () => setting('DEPLOY_REPO'),
    leagueName: () => setting('LEAGUE_NAME'),
    faabBudget: () => parseInt(setting('FAAB_BUDGET')) || cfg.defaultFaabBudget,
    isAbandonedTeam: key =>
      typeof key === 'string' && cfg.abandonedTeamSuffixes.some(s => key.endsWith(s)),
    weekDir: week => path.join(cfg.dir, 'snapshots', `week-${String(week).padStart(2, '0')}`),
  };
}

let active = null;

/** The league this process is serving (memoized from argv/env). */
function activeLeague() {
  if (!active) active = getLeague(resolveLeagueId());
  return active;
}

module.exports = { LEAGUES, resolveLeagueId, getLeague, activeLeague };
