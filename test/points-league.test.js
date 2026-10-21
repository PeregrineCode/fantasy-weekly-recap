const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { categoryScoring, pointsScoring } = require('../lib/scoring');
const kkupfl = require('../lib/sports/hockey-points');

describe('scoring formats', () => {
  it('formats category scores as W-L-T and blowouts by categories won', () => {
    const s = categoryScoring({ blowoutWins: 7 });
    assert.equal(s.formatScore(6, 3, 0), '6-3-0');
    assert.equal(s.isBlowout(7, 2), true);
    assert.equal(s.isBlowout(6, 3), false);
  });

  it('formats points scores to one decimal and blowouts by margin', () => {
    const s = pointsScoring({ modifiers: { G: 4.5 }, blowoutMargin: 60 });
    assert.equal(s.formatScore(222.8, 198.65), '222.8-198.7');
    assert.equal(s.formatScore(200, 150), '200.0-150.0');
    // Float noise must not flip the tenths digit
    assert.equal(s.formatScore(640.65, 605.95), '640.7-606.0');
    assert.equal(s.isBlowout(278.1, 217.0), true);
    assert.equal(s.isBlowout(250.1, 214.7), false);
  });
});

describe('KKUPFL hockey points profile', () => {
  it('scores a skater line with the league modifiers', () => {
    // Brady Tkachuk, week 3 2026: 6 G, 4 A, 20 SOG, 11 HIT
    const stats = kkupfl.deriveStats({ G: 6, A: 4, SHP: 0, SOG: 20, HIT: 11, BLK: 0 });
    assert.equal(stats.FPTS, 51.75);
    assert.equal(stats.P, 10);
  });

  it('scores a goalie line and derives shots against and save percentage', () => {
    const stats = kkupfl.deriveStats({ W: 2, GA: 4, SV: 74, SHO: 0 });
    assert.equal(stats.FPTS, 22.2);
    assert.equal(stats.SA, 78);
    assert.ok(Math.abs(stats['SV%'] - 74 / 78) < 1e-9);
  });

  it('leaves a did-not-play line without points', () => {
    const stats = kkupfl.deriveStats({ G: '-', A: '-', SOG: '-' });
    assert.equal(stats.FPTS, undefined);
    assert.equal(stats.P, undefined);
  });

  it('flags a bench blunder by points left on the bench', () => {
    assert.equal(kkupfl.isNotableBenching({ FPTS: 9.5 }), true);
    assert.equal(kkupfl.isNotableBenching({ FPTS: 4 }), false);
    assert.equal(kkupfl.benchScore({ FPTS: 9.5 }), 9.5);
  });

  it('only crowns goalies with a real workload', () => {
    const goalie = kkupfl.playerGroups.find(g => g.key === 'goalie');
    assert.equal(goalie.qualifies(kkupfl.deriveStats({ W: 1, GA: 0, SV: 8, SHO: 0 })), false);
    assert.equal(goalie.qualifies(kkupfl.deriveStats({ W: 1, GA: 2, SV: 30, SHO: 0 })), true);
  });
});
