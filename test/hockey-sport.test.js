const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const hockey = require('../lib/sports/hockey');

describe('hockey player groups', () => {
  it('splits goalies from skaters, including multi-position skaters', () => {
    assert.equal(hockey.groupForPosition('G'), 'goalie');
    assert.equal(hockey.groupForPosition('C,LW'), 'skater');
    assert.equal(hockey.groupForPosition('LW,RW'), 'skater');
    assert.equal(hockey.groupForPosition('D'), 'skater');
  });

  it('needs roughly a full start before a goalie counts as a stream', () => {
    assert.equal(hockey.streamQualifies({ W: 1, SA: 25, SV: 25 }), true);
    assert.equal(hockey.streamQualifies({ W: 0, SA: 8, SV: 8 }), false);
    assert.equal(hockey.streamQualifies({ W: '-', SA: '-' }), false);
  });

  it('defines 9 scoring categories with GAA as the only inverted one', () => {
    assert.equal(hockey.allCats.length, 9);
    assert.deepEqual(hockey.allCats.filter(c => c.inverted).map(c => c.name), ['GAA']);
  });
});

describe('hockey bench blunders', () => {
  it('drops per-day ratio stats when summing', () => {
    const s = hockey.normalizeBenchStats({ W: 1, GAA: 2.0, 'SV%': 0.93, SV: 28, SA: 30 });
    assert.deepEqual(s, { W: 1, SV: 28, SA: 30 });
  });

  it('flags a benched skater who scored', () => {
    assert.equal(hockey.isNotableBenching({ G: 1, A: 0, P: 1, SOG: 3 }, []), true);
    assert.equal(hockey.isNotableBenching({ G: 0, A: 2, P: 2, SOG: 1 }, []), true);
  });

  it('flags a grinder who piled up hits and blocks', () => {
    assert.equal(hockey.isNotableBenching({ G: 0, A: 0, P: 0, HIT: 5, BLK: 4 }, []), true);
  });

  it('ignores a quiet benched skater', () => {
    assert.equal(hockey.isNotableBenching({ G: 0, A: 1, P: 1, SOG: 2, HIT: 1 }, []), false);
  });

  it('flags a benched goalie win or a strong benched start', () => {
    assert.equal(hockey.isNotableBenching({ W: 1, GA: 3, SV: 25, SA: 28 }, []), true);
    const day = { W: 0, GA: 1, SV: 29, SA: 30 };
    assert.equal(hockey.isNotableBenching({ W: 0, GA: 1, SV: 29, SA: 30 }, [day]), true);
  });

  it('ignores a benched goalie loss with a poor save percentage', () => {
    const day = { W: 0, GA: 5, SV: 20, SA: 25 };
    assert.equal(hockey.isNotableBenching({ W: 0, GA: 5, SV: 20, SA: 25 }, [day]), false);
  });
});

describe('hockey dead weight', () => {
  const rosters = {
    't.1': {
      teamKey: 't.1', name: 'Team One',
      players: [
        { playerKey: 'p1', name: 'Shooter', team: 'TOR', displayPosition: 'C', selectedPosition: 'C', stats: { P: 0, SOG: 15 } },
        { playerKey: 'g1', name: 'Sieve', team: 'SJ', displayPosition: 'G', selectedPosition: 'G', stats: {} },
        { playerKey: 'p2', name: 'Hurt', team: 'TOR', displayPosition: 'C', selectedPosition: 'IR', stats: { P: 0, SOG: 15 } },
      ],
    },
  };
  const week = (players) => ({ 't.1': { teamKey: 't.1', players } });
  const weekly = {
    3: week([
      { playerKey: 'p1', stats: { P: 0, SOG: 4 } },
      { playerKey: 'g1', stats: { SV: 70, SA: 82 } },
    ]),
    2: week([
      { playerKey: 'p1', stats: { P: 0, SOG: 5 } },
      { playerKey: 'g1', stats: { SV: 40, SA: 46 } },
    ]),
  };

  it('roasts a pointless shooter and a leaky goalie over recent weeks', () => {
    const roasts = hockey.findDeadWeight({ rosters, teamNames: { 't.1': 'Team One' }, week: 3, loadWeeklyRosters: w => weekly[w] || null });
    assert.deepEqual(roasts.map(r => r.playerName).sort(), ['Shooter', 'Sieve']);
    const sieve = roasts.find(r => r.playerName === 'Sieve');
    assert.match(sieve.description, /\.859 save percentage over the last 2 weeks/);
  });

  it('skips players on IR', () => {
    const roasts = hockey.findDeadWeight({ rosters, teamNames: {}, week: 3, loadWeeklyRosters: w => weekly[w] || null });
    assert.ok(!roasts.some(r => r.playerName === 'Hurt'));
  });

  it('falls back to season stats in the first week', () => {
    const roasts = hockey.findDeadWeight({ rosters, teamNames: {}, week: 1, loadWeeklyRosters: () => null });
    assert.deepEqual(roasts.map(r => r.playerName), ['Shooter']);
    assert.match(roasts[0].description, /zero points on the season despite 15 shots/);
  });
});

describe('hockey game start times', () => {
  it('maps NHL abbreviations to Yahoo and keys by schedule date', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      json: async () => ({
        gameWeek: [
          { date: '2026-10-07', games: [{ startTimeUTC: '2026-10-08T02:00:00Z', awayTeam: { abbrev: 'SJS' }, homeTeam: { abbrev: 'LAK' } }] },
          { date: '2026-10-08', games: [{ startTimeUTC: '2026-10-08T23:00:00Z', awayTeam: { abbrev: 'TBL' }, homeTeam: { abbrev: 'NJD' } }] },
          { date: '2026-10-20', games: [{ startTimeUTC: '2026-10-20T23:00:00Z', awayTeam: { abbrev: 'TOR' }, homeTeam: { abbrev: 'MTL' } }] },
        ],
        nextStartDate: '2026-10-21',
      }),
    });
    try {
      const starts = await hockey.fetchGameStartTimes('2026-10-05', '2026-10-11');
      assert.equal(starts.get('SJ|2026-10-07'), Date.parse('2026-10-08T02:00:00Z') / 1000);
      assert.equal(starts.get('LA|2026-10-07'), Date.parse('2026-10-08T02:00:00Z') / 1000);
      assert.ok(starts.has('TB|2026-10-08'));
      assert.ok(starts.has('NJ|2026-10-08'));
      assert.ok(!starts.has('TOR|2026-10-20'), 'dates outside the week are ignored');
    } finally {
      global.fetch = realFetch;
    }
  });
});
