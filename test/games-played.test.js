const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { playedDay, gamesOnTeam, describeGames } = require('../lib/games-played');

const INACTIVE = ['BN', 'IR', 'IR+'];
const snap = (date, players, positionsSource = 'nightly') => ({
  date, positionsSource,
  rosters: { 't.1': { teamKey: 't.1', players } },
});
const zeros = { G: 0, A: 0, SOG: 0, HIT: 0, BLK: 0 };

describe('playedDay', () => {
  it('treats an all-zero line as a game and an empty line as a night off', () => {
    assert.equal(playedDay(zeros), true);
    assert.equal(playedDay({}), false);
    assert.equal(playedDay({ G: '-', A: '-' }), false);
  });
});

describe('gamesOnTeam', () => {
  // Byfield, Dad's Hockey week 5: rostered two days, played one, all zeros
  it('counts a zero-stat game but not a did-not-play day', () => {
    const snaps = [
      snap('2026-10-31', [{ playerKey: 'p.1', selectedPosition: 'C', stats: zeros }]),
      snap('2026-11-01', [{ playerKey: 'p.1', selectedPosition: 'BN', stats: {} }]),
    ];
    assert.deepEqual(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE), { games: 1, lineupGames: 1 });
  });

  it('separates bench games from lineup games', () => {
    const snaps = [
      snap('2026-10-30', [{ playerKey: 'p.1', selectedPosition: 'BN', stats: { G: 1, A: 3 } }]),
      snap('2026-10-31', [{ playerKey: 'p.1', selectedPosition: 'RW', stats: { G: 0, SOG: 2 } }]),
    ];
    assert.deepEqual(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE), { games: 2, lineupGames: 1 });
  });

  it('withholds the lineup count when a game day has no trusted lineup', () => {
    const snaps = [snap('2026-10-31', [{ playerKey: 'p.1', selectedPosition: 'RW', stats: zeros }], 'api')];
    assert.deepEqual(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE), { games: 1, lineupGames: null });
  });

  it('returns null when the player never appears on that team', () => {
    const snaps = [snap('2026-10-31', [{ playerKey: 'p.2', selectedPosition: 'C', stats: zeros }])];
    assert.equal(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE), null);
  });
});

describe('describeGames', () => {
  it('words each case for the writer', () => {
    assert.equal(describeGames(null), '');
    assert.equal(describeGames({ games: 1, lineupGames: 1 }), 'Games: played 1 game for this team, in the active lineup');
    assert.equal(describeGames({ games: 4, lineupGames: 4 }), 'Games: played 4 games for this team, all in the active lineup');
    assert.match(describeGames({ games: 2, lineupGames: 1 }), /1 in the active lineup \(the stats above count only the lineup games\)/);
    assert.match(describeGames({ games: 3, lineupGames: null }), /lineup slots unknown/);
  });
});

describe('gamesOnTeam — games before the player joined', () => {
  // Coronato, Dad's Hockey week 5: added 9:56 PM ET Friday, after CGY's game
  // started. His four points that night sit on the new roster but never counted.
  const OCT30_9PM_ET = Math.floor(Date.parse('2026-10-31T01:00:00Z') / 1000);
  const ADDED = Math.floor(Date.parse('2026-10-31T01:56:44Z') / 1000);
  const snaps = [
    snap('2026-10-30', [{ playerKey: 'p.1', selectedPosition: 'BN', stats: { G: 1, A: 3 } }]),
    snap('2026-10-31', [{ playerKey: 'p.1', selectedPosition: 'RW', stats: { G: 0, SOG: 2 } }]),
  ];

  it('drops a game that started before he joined', () => {
    const joined = { at: ADDED, proTeam: 'CGY', gameStarts: new Map([['CGY|2026-10-30', OCT30_9PM_ET]]) };
    assert.deepEqual(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE, joined), { games: 1, lineupGames: 1 });
  });

  it('keeps a same-day game he joined before', () => {
    const joined = { at: OCT30_9PM_ET - 3600 * 8, proTeam: 'CGY', gameStarts: new Map([['CGY|2026-10-30', OCT30_9PM_ET]]) };
    assert.deepEqual(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE, joined), { games: 2, lineupGames: 1 });
  });

  it('drops a game on the day he joined when the start time is unknown', () => {
    const joined = { at: ADDED, proTeam: 'CGY', gameStarts: new Map() };
    assert.deepEqual(gamesOnTeam(snaps, 'p.1', 't.1', INACTIVE, joined), { games: 1, lineupGames: 1 });
  });
});
