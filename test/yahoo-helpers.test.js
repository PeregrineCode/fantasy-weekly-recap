const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseTeamInfo, parseStatValues, parseScoreboardResponse } = require('../yahoo-helpers');

describe('parseTeamInfo', () => {
  it('extracts flat fields from Yahoo nested array', () => {
    const input = [
      { team_key: '469.l.75479.t.1' },
      { team_id: '1' },
      { name: 'Professor McGonigle' },
      [1, 2, 3], // arrays should be skipped
    ];
    const result = parseTeamInfo(input);
    assert.equal(result.team_key, '469.l.75479.t.1');
    assert.equal(result.name, 'Professor McGonigle');
    assert.equal(result.team_id, '1');
  });

  it('returns empty object for non-array input', () => {
    assert.deepEqual(parseTeamInfo(null), {});
    assert.deepEqual(parseTeamInfo(undefined), {});
    assert.deepEqual(parseTeamInfo('string'), {});
  });

  it('returns empty object for empty array', () => {
    assert.deepEqual(parseTeamInfo([]), {});
  });

  it('merges multiple objects', () => {
    const input = [{ a: 1 }, { b: 2 }];
    assert.deepEqual(parseTeamInfo(input), { a: 1, b: 2 });
  });
});

describe('parseStatValues', () => {
  it('parses Yahoo stat array into named values', () => {
    const input = [
      { stat: { stat_id: '7', value: '15' } },   // R
      { stat: { stat_id: '12', value: '3' } },    // HR
      { stat: { stat_id: '26', value: '2.45' } }, // ERA
    ];
    const result = parseStatValues(input);
    assert.equal(result.R, 15);
    assert.equal(result.HR, 3);
    assert.equal(result.ERA, 2.45);
  });

  it('skips non-numeric values like dashes', () => {
    const input = [
      { stat: { stat_id: '7', value: '-' } },
      { stat: { stat_id: '12', value: '5' } },
    ];
    const result = parseStatValues(input);
    assert.equal(result.R, undefined);
    assert.equal(result.HR, 5);
  });

  it('skips Infinity values', () => {
    const input = [
      { stat: { stat_id: '7', value: 'Infinity' } },
    ];
    const result = parseStatValues(input);
    assert.equal(result.R, undefined);
  });

  it('skips unknown stat IDs', () => {
    const input = [
      { stat: { stat_id: '99999', value: '10' } },
    ];
    const result = parseStatValues(input);
    assert.deepEqual(result, {});
  });

  it('handles null/undefined input', () => {
    assert.deepEqual(parseStatValues(null), {});
    assert.deepEqual(parseStatValues(undefined), {});
  });

  it('handles empty array', () => {
    assert.deepEqual(parseStatValues([]), {});
  });

  it('skips entries without stat property', () => {
    const input = [null, undefined, {}, { stat: null }];
    assert.deepEqual(parseStatValues(input), {});
  });
});

describe('parseScoreboardResponse', () => {
  function makeScoreboardResponse(matchups) {
    return {
      fantasy_content: {
        league: [
          {},
          {
            scoreboard: {
              '0': {
                matchups: {
                  count: matchups.length,
                  ...Object.fromEntries(matchups.map((m, i) => [i, { matchup: m }])),
                },
              },
            },
          },
        ],
      },
    };
  }

  function makeMatchup({ t1Key, t1Name, t1Stats, t2Key, t2Name, t2Stats, statWinners, winnerKey }) {
    return {
      '0': {
        teams: [
          {
            team: [
              [{ team_key: t1Key }, { name: t1Name }],
              { team_stats: { stats: t1Stats || [] } },
            ],
          },
          {
            team: [
              [{ team_key: t2Key }, { name: t2Name }],
              { team_stats: { stats: t2Stats || [] } },
            ],
          },
        ],
      },
      stat_winners: statWinners || [],
      winner_team_key: winnerKey || null,
    };
  }

  it('parses a single matchup', () => {
    const response = makeScoreboardResponse([
      makeMatchup({
        t1Key: 't.1', t1Name: 'Team A',
        t2Key: 't.2', t2Name: 'Team B',
        t1Stats: [{ stat: { stat_id: '7', value: '10' } }],
        t2Stats: [{ stat: { stat_id: '7', value: '5' } }],
        statWinners: [
          { stat_winner: { stat_id: '7', winner_team_key: 't.1', is_tied: '0' } },
        ],
      }),
    ]);

    const result = parseScoreboardResponse(response);
    assert.equal(result.length, 1);
    assert.equal(result[0].team1.teamKey, 't.1');
    assert.equal(result[0].team2.teamKey, 't.2');
    assert.equal(result[0].team1.stats.R, 10);
    assert.equal(result[0].team2.stats.R, 5);
    assert.equal(result[0].team1Wins, 1);
    assert.equal(result[0].team2Wins, 0);
    assert.equal(result[0].ties, 0);
  });

  it('counts ties correctly', () => {
    const response = makeScoreboardResponse([
      makeMatchup({
        t1Key: 't.1', t1Name: 'A',
        t2Key: 't.2', t2Name: 'B',
        statWinners: [
          { stat_winner: { stat_id: '7', is_tied: '1' } },
          { stat_winner: { stat_id: '12', winner_team_key: 't.1', is_tied: '0' } },
        ],
      }),
    ]);

    const result = parseScoreboardResponse(response);
    assert.equal(result[0].team1Wins, 1);
    assert.equal(result[0].team2Wins, 0);
    assert.equal(result[0].ties, 1);
  });

  it('handles multiple matchups', () => {
    const response = makeScoreboardResponse([
      makeMatchup({ t1Key: 't.1', t1Name: 'A', t2Key: 't.2', t2Name: 'B' }),
      makeMatchup({ t1Key: 't.3', t1Name: 'C', t2Key: 't.4', t2Name: 'D' }),
    ]);
    assert.equal(parseScoreboardResponse(response).length, 2);
  });

  it('handles matchup with no stat winners', () => {
    const response = makeScoreboardResponse([
      makeMatchup({ t1Key: 't.1', t1Name: 'A', t2Key: 't.2', t2Name: 'B' }),
    ]);
    const result = parseScoreboardResponse(response);
    assert.equal(result[0].team1Wins, 0);
    assert.equal(result[0].team2Wins, 0);
    assert.equal(result[0].ties, 0);
  });
});
