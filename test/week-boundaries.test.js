const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Week boundary calculation — Yahoo fantasy weeks are Mon-Sun,
 * with week 1 being a partial week starting on the season start date.
 */
function weekRange(seasonStart, week) {
  const startDate = new Date(seasonStart + 'T12:00:00');
  let weekStart, weekEnd;
  if (week === 1) {
    weekStart = new Date(startDate);
    weekEnd = new Date(startDate);
    const dayOfWeek = weekEnd.getDay();
    const daysToSun = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    weekEnd.setDate(weekEnd.getDate() + daysToSun);
  } else {
    const firstSunday = new Date(startDate);
    const dayOfWeek = firstSunday.getDay();
    firstSunday.setDate(firstSunday.getDate() + (dayOfWeek === 0 ? 0 : 7 - dayOfWeek));
    weekStart = new Date(firstSunday);
    weekStart.setDate(weekStart.getDate() + 1 + (week - 2) * 7);
    weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
  }
  return {
    start: weekStart.toISOString().split('T')[0],
    end: weekEnd.toISOString().split('T')[0],
  };
}

describe('week boundary calculation', () => {
  // 2026 MLB season starts Wednesday March 25
  const SEASON_START = '2026-03-25';

  it('week 1 starts on season start date', () => {
    const w = weekRange(SEASON_START, 1);
    assert.equal(w.start, '2026-03-25');
  });

  it('week 1 ends on first Sunday', () => {
    const w = weekRange(SEASON_START, 1);
    assert.equal(w.end, '2026-03-29');
    assert.equal(new Date(w.end + 'T12:00:00').getDay(), 0); // Sunday
  });

  it('week 2 starts on Monday after week 1', () => {
    const w = weekRange(SEASON_START, 2);
    assert.equal(w.start, '2026-03-30');
    assert.equal(new Date(w.start + 'T12:00:00').getDay(), 1); // Monday
  });

  it('week 2 ends on Sunday', () => {
    const w = weekRange(SEASON_START, 2);
    assert.equal(w.end, '2026-04-05');
    assert.equal(new Date(w.end + 'T12:00:00').getDay(), 0); // Sunday
  });

  it('week 3+ are full Mon-Sun weeks', () => {
    const w3 = weekRange(SEASON_START, 3);
    assert.equal(w3.start, '2026-04-06');
    assert.equal(w3.end, '2026-04-12');
    assert.equal(new Date(w3.start + 'T12:00:00').getDay(), 1);
    assert.equal(new Date(w3.end + 'T12:00:00').getDay(), 0);
  });

  it('Jack Leiter (added Mar 31) falls in week 2, not week 1', () => {
    const leiterDate = '2026-03-31';
    const w1 = weekRange(SEASON_START, 1);
    const w2 = weekRange(SEASON_START, 2);
    assert.ok(leiterDate > w1.end, 'should be after week 1');
    assert.ok(leiterDate >= w2.start && leiterDate <= w2.end, 'should be in week 2');
  });

  it('handles season starting on Monday (full first week)', () => {
    const w = weekRange('2025-03-24', 1); // Monday
    assert.equal(w.start, '2025-03-24');
    assert.equal(w.end, '2025-03-30');
    assert.equal(new Date(w.end + 'T12:00:00').getDay(), 0);
  });

  it('handles season starting on Sunday (1-day first week)', () => {
    const w1 = weekRange('2025-03-30', 1); // Sunday
    assert.equal(w1.start, '2025-03-30');
    assert.equal(w1.end, '2025-03-30'); // same day
    const w2 = weekRange('2025-03-30', 2);
    assert.equal(w2.start, '2025-03-31'); // Monday
  });
});
