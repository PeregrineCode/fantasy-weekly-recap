const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isNightlyCaptureTrustworthy, addDaysISO } = require('../daily-collect');

/**
 * The nightly position capture is meant to run ~10:30 PM ET on date X, after all of
 * X's games are locked. GitHub Actions delays push it later; a run that slips past
 * Yahoo's ~3 AM ET rollover reads the NEXT day's not-yet-finalized lineup, producing
 * phantom bench blunders. isNightlyCaptureTrustworthy must accept captures in date X's
 * locked window (evening of X >= 9 PM ET, or small hours of X+1 before 3 AM ET) and
 * reject premature / post-rollover ones. All ISO times below are UTC; June = EDT (UTC-4).
 */
describe('isNightlyCaptureTrustworthy', () => {
  const X = '2026-06-10';

  it('trusts an on-time 10:30 PM ET capture (02:30 UTC next day)', () => {
    // 2026-06-11T02:30Z = 2026-06-10 22:30 ET → date X, hour 22
    assert.equal(isNightlyCaptureTrustworthy('2026-06-11T02:30:00Z', X), true);
  });

  it('trusts a delayed capture in the small hours of X+1 before the 3 AM rollover', () => {
    // 2026-06-05T06:50Z = 2026-06-05 02:50 ET → date X+1, hour 2 (the real 06-04 case)
    assert.equal(isNightlyCaptureTrustworthy('2026-06-05T06:50:00Z', '2026-06-04'), true);
  });

  it('rejects a premature early-morning-of-X capture past the rollover', () => {
    // 2026-06-02T07:10Z = 2026-06-02 03:10 ET → date X, hour 3 (the real false-flag case)
    assert.equal(isNightlyCaptureTrustworthy('2026-06-02T07:10:00Z', '2026-06-02'), false);
  });

  it('rejects a 4 AM-of-X capture', () => {
    // 2026-06-01T08:17Z = 2026-06-01 04:17 ET → date X, hour 4
    assert.equal(isNightlyCaptureTrustworthy('2026-06-01T08:17:00Z', '2026-06-01'), false);
  });

  it('trusts the 9 PM ET floor on date X', () => {
    // 2026-06-11T01:00Z = 2026-06-10 21:00 ET → hour 21
    assert.equal(isNightlyCaptureTrustworthy('2026-06-11T01:00:00Z', X), true);
  });

  it('rejects 8:59 PM ET on X (before the evening floor — games not all locked)', () => {
    // 2026-06-11T00:59Z = 2026-06-10 20:59 ET → hour 20
    assert.equal(isNightlyCaptureTrustworthy('2026-06-11T00:59:00Z', X), false);
  });

  it('trusts 2:59 AM ET on X+1 (just before rollover)', () => {
    // 2026-06-11T06:59Z = 2026-06-11 02:59 ET → date X+1, hour 2
    assert.equal(isNightlyCaptureTrustworthy('2026-06-11T06:59:00Z', X), true);
  });

  it('rejects 3:01 AM ET on X+1 (just past rollover — next day captured)', () => {
    // 2026-06-11T07:01Z = 2026-06-11 03:01 ET → date X+1, hour 3
    assert.equal(isNightlyCaptureTrustworthy('2026-06-11T07:01:00Z', X), false);
  });

  it('rejects a null/missing capture time', () => {
    assert.equal(isNightlyCaptureTrustworthy(null, X), false);
    assert.equal(isNightlyCaptureTrustworthy(undefined, X), false);
  });
});

describe('addDaysISO', () => {
  it('adds a day within a month', () => {
    assert.equal(addDaysISO('2026-06-04', 1), '2026-06-05');
  });
  it('rolls over month boundaries', () => {
    assert.equal(addDaysISO('2026-06-30', 1), '2026-07-01');
  });
  it('rolls over year boundaries', () => {
    assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  });
});
