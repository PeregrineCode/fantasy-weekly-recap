const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveLeagueId, getLeague } = require('../lib/league');
const { etMidnightUTC } = require('../lib/et');

const ROOT = path.resolve(__dirname, '..');

describe('resolveLeagueId', () => {
  it('defaults to baseball', () => {
    assert.equal(resolveLeagueId(['node', 'x.js'], {}), 'baseball');
  });

  it('reads --league from argv', () => {
    assert.equal(resolveLeagueId(['node', 'x.js', '--week', '3', '--league', 'hockey'], {}), 'hockey');
  });

  it('falls back to the LEAGUE env var', () => {
    assert.equal(resolveLeagueId(['node', 'x.js'], { LEAGUE: 'hockey' }), 'hockey');
  });

  it('argv wins over env', () => {
    assert.equal(resolveLeagueId(['node', 'x.js', '--league', 'baseball'], { LEAGUE: 'hockey' }), 'baseball');
  });

  it('rejects unknown leagues', () => {
    assert.throws(() => resolveLeagueId(['node', 'x.js', '--league', 'curling'], {}), /Unknown league "curling"/);
  });
});

describe('getLeague', () => {
  it('keeps baseball data at the repo root', () => {
    const lg = getLeague('baseball', {});
    assert.equal(lg.paths.snapshots, path.join(ROOT, 'snapshots'));
    assert.equal(lg.paths.prompts, path.join(ROOT, 'prompts'));
    assert.equal(lg.weekDir(3), path.join(ROOT, 'snapshots', 'week-03'));
  });

  it('puts hockey under leagues/hockey', () => {
    const lg = getLeague('hockey', {});
    assert.equal(lg.paths.snapshots, path.join(ROOT, 'leagues', 'hockey', 'snapshots'));
    assert.equal(lg.paths.site, path.join(ROOT, 'leagues', 'hockey', 'site'));
    assert.equal(lg.gameCode, 'nhl');
  });

  it('reads league-prefixed env settings', () => {
    const env = { DEPLOY_REPO: 'me/baseball', HOCKEY_DEPLOY_REPO: 'me/hockey', HOCKEY_FAAB_BUDGET: '150' };
    assert.equal(getLeague('baseball', env).deployRepo(), 'me/baseball');
    assert.equal(getLeague('hockey', env).deployRepo(), 'me/hockey');
    assert.equal(getLeague('hockey', env).faabBudget(), 150);
    assert.equal(getLeague('baseball', env).faabBudget(), 200);
    assert.equal(getLeague('hockey', {}).faabBudget(), 100);
  });

  it('resolves league IDs from env with a hockey default', () => {
    assert.equal(getLeague('baseball', { YAHOO_MLB_LEAGUE_ID: '75479' }).yahooLeagueId(), '75479');
    assert.equal(getLeague('hockey', {}).yahooLeagueId(), '48642');
    assert.equal(getLeague('hockey', { YAHOO_NHL_LEAGUE_ID: '1' }).yahooLeagueId(), '1');
  });

  it('only treats baseball t.7 as abandoned (t.7 is an active hockey team)', () => {
    assert.equal(getLeague('baseball', {}).isAbandonedTeam('469.l.75479.t.7'), true);
    assert.equal(getLeague('hockey', {}).isAbandonedTeam('477.l.48642.t.7'), false);
  });

  it('every league has its prompts and writers', () => {
    for (const id of ['baseball', 'hockey']) {
      const lg = getLeague(id, {});
      const writers = require(path.join(lg.paths.prompts, 'writers.json')).writers;
      assert.deepEqual(Object.keys(writers).sort(), ['analytics', 'hottakes', 'insider', 'lead']);
      for (const f of ['system.txt', 'reference.md']) {
        assert.ok(require('fs').existsSync(path.join(lg.paths.prompts, f)), `${id} missing ${f}`);
      }
    }
  });
});

describe('stat ID map follows the active league', () => {
  const statFor = (league, id) => spawnSync(process.execPath, [
    '-e', `console.log(require('./lib/stat-categories').STAT_ID_MAP[${id}])`, '--', '--league', league,
  ], { cwd: ROOT, encoding: 'utf-8' }).stdout.trim();

  it('maps stat 26 to ERA in baseball and SV% in hockey', () => {
    assert.equal(statFor('baseball', 26), 'ERA');
    assert.equal(statFor('hockey', 26), 'SV%');
  });
});

describe('etMidnightUTC', () => {
  it('is 04:00Z during EDT', () => {
    assert.equal(new Date(etMidnightUTC('2026-10-05')).toISOString(), '2026-10-05T04:00:00.000Z');
  });

  it('is 05:00Z during EST', () => {
    assert.equal(new Date(etMidnightUTC('2026-12-14')).toISOString(), '2026-12-14T05:00:00.000Z');
  });

  it('handles the DST change days', () => {
    assert.equal(new Date(etMidnightUTC('2026-11-01')).toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(new Date(etMidnightUTC('2027-03-14')).toISOString(), '2027-03-14T05:00:00.000Z');
  });
});
