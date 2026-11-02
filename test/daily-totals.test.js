const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hasDayTotals } = require('../lib/daily-totals');
const { useFinalDayTeamStats } = require('../yahoo-helpers');

describe('hasDayTotals', () => {
  it('trusts a snapshot collected the next ET morning', () => {
    assert.equal(hasDayTotals({ date: '2026-10-21', collectedAt: '2026-10-22T11:30:00Z' }), true);
  });

  it('trusts the 9:53 AM retry and an EST-season collect', () => {
    assert.equal(hasDayTotals({ date: '2026-10-21', collectedAt: '2026-10-22T13:55:00Z' }), true);
    assert.equal(hasDayTotals({ date: '2026-12-07', collectedAt: '2026-12-08T12:30:00Z' }), true);
  });

  it('rejects a backfill collected days later', () => {
    // KKUPFL 10-19 was backfilled on 10-26 and carried the final week score
    assert.equal(hasDayTotals({ date: '2026-10-19', collectedAt: '2026-10-27T00:05:00Z' }), false);
  });

  it('keeps snapshots without a collection time', () => {
    assert.equal(hasDayTotals({ date: '2026-10-19' }), true);
  });
});

describe('useFinalDayTeamStats', () => {
  const matchup = (a, b) => ({ team1: { teamKey: 't.1', stats: a, points: 276.2 }, team2: { teamKey: 't.2', stats: b, points: 217.6 } });

  it('replaces drifted weekly stats with the final day and keeps the score', () => {
    const weekly = [matchup({ G: 23, FPTS: 285.2 }, { G: 10, FPTS: 217.6 })];
    const finalDaily = { matchups: [matchup({ G: 22, FPTS: 276.2 }, { G: 10, FPTS: 217.6 })] };
    assert.equal(useFinalDayTeamStats(weekly, finalDaily), 1);
    assert.deepEqual(weekly[0].team1.stats, { G: 22, FPTS: 276.2 });
    assert.equal(weekly[0].team1.points, 276.2);
  });

  it('leaves teams missing from the daily snapshot alone', () => {
    const weekly = [matchup({ G: 5 }, { G: 6 })];
    assert.equal(useFinalDayTeamStats(weekly, { matchups: [] }), 0);
    assert.deepEqual(weekly[0].team1.stats, { G: 5 });
  });
});
