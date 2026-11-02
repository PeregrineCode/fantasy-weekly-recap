const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// narrate.js reads the active league at load, so run it under LEAGUE=<id>
function rankBlock(leagueId, scoreboard) {
  const script = `process.stdout.write(require(${JSON.stringify(path.join(__dirname, '..', 'narrate.js'))}).weeklyScoreRankBlock(${JSON.stringify(scoreboard)}))`;
  return execFileSync(process.execPath, ['-e', script], { env: { ...process.env, LEAGUE: leagueId, DOTENV_CONFIG_QUIET: 'true' }, encoding: 'utf8' });
}

const m = (a, ap, b, bp) => ({
  team1: { teamKey: a, name: a }, team2: { teamKey: b, name: b },
  team1Wins: ap, team2Wins: bp, winnerTeamKey: ap === bp ? null : ap > bp ? a : b,
});

describe('weeklyScoreRankBlock', () => {
  // KKUPFL week 5: Beef's 259.5 was third, behind 297.0 and 279.9
  const sb = [m('Sheeting', 297.0, 'zzz', 205.5), m('dMC', 279.85, 'Slew', 237.3), m('Beef', 259.5, 'WWW', 176.4)];

  it('ranks every team by weekly score in a points league', () => {
    const out = rankBlock('kkupfl', sb);
    const lines = out.split('\n').filter(l => /^\s+\S*\d+\./.test(l));
    assert.equal(lines.length, 6);
    assert.match(lines[0], /1\. Sheeting 297\.0 \(won\)/);
    assert.match(lines[2], /3\. Beef 259\.5 \(won\)/);
    assert.match(lines[3], /4\. Slew 237\.3 \(lost\)/);
  });

  it('marks tied scores', () => {
    const out = rankBlock('kkupfl', [m('A', 200, 'B', 150), m('C', 200, 'D', 150)]);
    assert.match(out, /T-1\. A/);
    assert.match(out, /T-3\. B/);
  });

  it('is empty in a categories league', () => {
    assert.equal(rankBlock('hockey', sb), '');
  });
});
