const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScoreboardResponse, labelPlayoffRounds, FINALS_ROUNDS } = require('../yahoo-helpers');
const { restrictToFinalists } = require('../analyze');

const T = n => `469.l.1.t.${n}`;
const m = (a, b, extra = {}) => ({
  team1: { teamKey: T(a), name: `Team ${a}`, stats: {} },
  team2: { teamKey: T(b), name: `Team ${b}`, stats: {} },
  team1Wins: 0, team2Wins: 0, ties: 0, statWinners: [],
  winnerTeamKey: null, isPlayoffs: true, isConsolation: false,
  ...extra,
});

describe('parseScoreboardResponse playoff flags', () => {
  function rawMatchup(extra) {
    return {
      '0': { teams: [
        { team: [[{ team_key: T(1) }, { name: 'A' }], { team_stats: { stats: [] } }] },
        { team: [[{ team_key: T(2) }, { name: 'B' }], { team_stats: { stats: [] } }] },
      ] },
      stat_winners: [],
      ...extra,
    };
  }
  const wrap = matchups => ({ fantasy_content: { league: [{}, { scoreboard: { '0': { matchups: {
    count: matchups.length, ...Object.fromEntries(matchups.map((x, i) => [i, { matchup: x }])),
  } } } }] } });

  it('reads is_playoffs / is_consolation / week bounds', () => {
    const [reg, po, con] = parseScoreboardResponse(wrap([
      rawMatchup({ week_start: '2026-08-17', week_end: '2026-08-23' }),
      rawMatchup({ is_playoffs: 1, is_consolation: 0 }),
      rawMatchup({ is_playoffs: 1, is_consolation: 1 }),
    ]));
    assert.equal(reg.isPlayoffs, false);
    assert.equal(reg.isConsolation, false);
    assert.equal(reg.weekStart, '2026-08-17');
    assert.equal(reg.weekEnd, '2026-08-23');
    assert.equal(po.isPlayoffs, true);
    assert.equal(po.isConsolation, false);
    assert.equal(con.isConsolation, true);
  });

  it('accepts Yahoo string "1" flags too', () => {
    const [x] = parseScoreboardResponse(wrap([rawMatchup({ is_playoffs: '1', is_consolation: '1' })]));
    assert.equal(x.isPlayoffs, true);
    assert.equal(x.isConsolation, true);
  });
});

describe('labelPlayoffRounds', () => {
  // Mirrors Dad's League 2026: 6-team bracket, byes for seeds 1-2, finals in end_week.
  const semis = [
    m(1, 10, { winnerTeamKey: T(1) }),   // seed 1 (bye) beat wildcard winner
    m(3, 4, { winnerTeamKey: T(4) }),
    m(5, 9, { winnerTeamKey: T(5) }),    // wildcard losers: 5th-place game, Yahoo says consolation=0
    m(2, 7, { isConsolation: true, winnerTeamKey: T(2) }),
    m(6, 8, { isConsolation: true, winnerTeamKey: T(6) }),
  ];
  const finals = [
    m(1, 4), m(3, 10), m(2, 6, { isConsolation: true }), m(7, 8, { isConsolation: true }),
  ];

  it('labels the finals week: winners bracket → Championship, losers → Third Place', () => {
    const labeled = labelPlayoffRounds(finals, semis, 0);
    assert.deepEqual(labeled.map(x => x.round), ['Championship', 'Third Place', 'Consolation', 'Consolation']);
  });

  it('labels the semifinal week; a bye team with no prior result stays in the winners bracket', () => {
    const wildcards = [m(4, 5, { winnerTeamKey: T(4) }), m(9, 10, { winnerTeamKey: T(10) })];
    const labeled = labelPlayoffRounds(semis, wildcards, 1);
    assert.deepEqual(labeled.map(x => x.round), ['Semifinal', 'Semifinal', 'Consolation', 'Consolation', 'Consolation']);
  });

  it('first playoff round with no prior week is a bracket round, not consolation', () => {
    const labeled = labelPlayoffRounds([m(4, 5), m(9, 10)], [], 2);
    assert.deepEqual(labeled.map(x => x.round), ['Quarterfinal', 'Quarterfinal']);
  });

  it('leaves regular-season matchups unlabeled and does not mutate input', () => {
    const reg = [m(1, 2, { isPlayoffs: false })];
    const labeled = labelPlayoffRounds(reg, [], 5);
    assert.equal(labeled[0].round, null);
    assert.equal('round' in reg[0], false);
  });

  it('FINALS_ROUNDS names exactly the two recap-worthy games', () => {
    assert.deepEqual([...FINALS_ROUNDS].sort(), ['Championship', 'Third Place']);
  });
});

describe('restrictToFinalists', () => {
  const scoreboard = [
    m(1, 4, { round: 'Championship' }),
    m(3, 10, { round: 'Third Place' }),
    m(2, 6, { round: 'Consolation', isConsolation: true }),
  ];
  const roster = players => ({ players: players.map(k => ({ playerKey: k, name: k, stats: {} })) });
  const weeklyRosters = { [T(1)]: roster(['p1']), [T(4)]: roster(['p4']), [T(3)]: roster(['p3']), [T(10)]: roster(['p10']), [T(2)]: roster(['p2']) };
  const weeklyStats = Object.fromEntries(['p1', 'p4', 'p3', 'p10', 'p2'].map(k => [k, { name: k, stats: {} }]));
  const rosters = Object.fromEntries(Object.keys(weeklyRosters).map(k => [k, { players: [] }]));
  const tx = (src, dst) => ({ players: [{ sourceTeam: src, destTeam: dst }] });
  const transactions = [tx('', T(1)), tx(T(2), ''), tx('', T(10))];
  const dailySnapshots = [{ date: 'd1', matchups: scoreboard, rosters: { [T(1)]: {}, [T(2)]: {} } }];

  const out = restrictToFinalists({ scoreboard, rosters, weeklyRosters, weeklyStats, transactions, dailySnapshots });

  it('keeps only championship and third-place matchups', () => {
    assert.deepEqual(out.scoreboard.map(x => x.round), ['Championship', 'Third Place']);
    assert.deepEqual([...out.finalistKeys].sort(), [T(1), T(10), T(3), T(4)].sort());
  });

  it('narrows rosters, weekly stats, transactions, and daily snapshots to finalists', () => {
    assert.deepEqual(Object.keys(out.rosters).sort(), [T(1), T(10), T(3), T(4)].sort());
    assert.deepEqual(Object.keys(out.weeklyRosters).sort(), [T(1), T(10), T(3), T(4)].sort());
    assert.deepEqual(Object.keys(out.weeklyStats).sort(), ['p1', 'p10', 'p3', 'p4']);
    assert.equal(out.transactions.length, 2);
    assert.equal(out.dailySnapshots[0].matchups.length, 2);
    assert.deepEqual(Object.keys(out.dailySnapshots[0].rosters), [T(1)]);
  });

  it('tolerates a missing weekly-rosters file', () => {
    const r = restrictToFinalists({ scoreboard, rosters, weeklyRosters: null, weeklyStats, transactions: [], dailySnapshots: [] });
    assert.equal(r.weeklyRosters, null);
    assert.deepEqual(r.weeklyStats, {});
  });
});
