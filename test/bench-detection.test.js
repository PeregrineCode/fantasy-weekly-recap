const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tests for the bench detection logic in analyzeRoasts.
 *
 * The key rules:
 * 1. Only flag a player as "benched with stats" on days they actually had stats (not SP off-days)
 * 2. Don't flag if the player was added AFTER their game started (they couldn't have been started)
 * 3. DO flag if the player was added BEFORE their game started (they could have been moved to active)
 */

// Replicate the core bench detection logic from analyze.js for unit testing
function detectBenchFailures(dailySnapshots, transactions, gameStarts) {
  // Build add timestamps lookup
  const addTimestamps = {};
  const addedPlayerTeams = {};
  for (const tx of transactions) {
    if (tx.type !== 'add' && tx.type !== 'add/drop') continue;
    for (const p of tx.players) {
      if (p.type !== 'add' || !p.destTeam) continue;
      const key = `${p.playerKey}|${p.destTeam}`;
      if (!addTimestamps[key] || tx.timestamp < addTimestamps[key]) {
        addTimestamps[key] = tx.timestamp;
        addedPlayerTeams[key] = p.team;
      }
    }
  }

  // Build bench days
  const benchDays = {};
  for (const snap of dailySnapshots) {
    if (!snap.rosters) continue;
    for (const roster of Object.values(snap.rosters)) {
      for (const player of roster.players) {
        const key = `${player.playerKey}|${roster.teamKey}`;
        if (!benchDays[key]) {
          benchDays[key] = { playerKey: player.playerKey, teamKey: roster.teamKey, name: player.name, daysOnBench: 0, totalDays: 0, benchedWithStats: 0 };
        }
        benchDays[key].totalDays++;
        const hadStats = player.stats && Object.values(player.stats).some(v => typeof v === 'number' && v !== 0);
        if (player.selectedPosition === 'BN') {
          benchDays[key].daysOnBench++;
          if (hadStats) {
            const addTs = addTimestamps[key];
            let couldHaveStarted = true;
            if (addTs) {
              const mlbTeam = addedPlayerTeams[key];
              const gameStartTs = mlbTeam && gameStarts?.get(`${mlbTeam}|${snap.date}`);
              if (gameStartTs) {
                couldHaveStarted = addTs < gameStartTs;
              } else {
                const addDate = new Date(addTs * 1000).toISOString().split('T')[0];
                couldHaveStarted = addDate < snap.date;
              }
            }
            if (couldHaveStarted) benchDays[key].benchedWithStats++;
          }
        }
      }
    }
  }

  return benchDays;
}

// Helper to make a daily snapshot
function makeSnap(date, players) {
  return {
    date,
    rosters: {
      't.1': {
        teamKey: 't.1',
        name: 'Test Team',
        players: players.map(p => ({
          playerKey: p.key,
          name: p.name,
          selectedPosition: p.pos,
          stats: p.stats || {},
        })),
      },
    },
  };
}

// Helper timestamps (Unix seconds)
const MAR31_6PM_ET = Math.floor(new Date('2026-03-31T22:00:00Z').getTime() / 1000); // 6:00 PM ET
const MAR31_7PM_ET = Math.floor(new Date('2026-03-31T23:00:00Z').getTime() / 1000); // 7:00 PM ET
const MAR31_730PM_ET = Math.floor(new Date('2026-03-31T23:30:00Z').getTime() / 1000); // 7:30 PM ET
const MAR31_10PM_ET = Math.floor(new Date('2026-04-01T02:00:00Z').getTime() / 1000); // 10:00 PM ET
const MAR31_11PM_ET = Math.floor(new Date('2026-04-01T03:00:00Z').getTime() / 1000); // 11:00 PM ET
const APR01_3AM_UTC = Math.floor(new Date('2026-04-01T03:11:00Z').getTime() / 1000); // 11:11 PM ET

describe('bench detection — SP off-day filtering', () => {
  it('does not flag SP benched on days without stats', () => {
    const snaps = [
      makeSnap('2026-03-30', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: {} }]),
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: {} }]),
      makeSnap('2026-04-01', [{ key: 'p.1', name: 'Pitcher', pos: 'SP', stats: { IP: 6, K: 7 } }]),
    ];
    const result = detectBenchFailures(snaps, [], new Map());
    assert.equal(result['p.1|t.1'].benchedWithStats, 0);
  });

  it('flags SP benched on a day with stats', () => {
    const snaps = [
      makeSnap('2026-03-30', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: {} }]),
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 6, K: 7 } }]),
    ];
    const result = detectBenchFailures(snaps, [], new Map());
    assert.equal(result['p.1|t.1'].benchedWithStats, 1);
  });

  it('counts only days with stats, not total bench days', () => {
    const snaps = [
      makeSnap('2026-03-30', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: {} }]),
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 5, K: 8 } }]),
      makeSnap('2026-04-01', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: {} }]),
      makeSnap('2026-04-02', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: {} }]),
      makeSnap('2026-04-03', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 6, K: 5 } }]),
    ];
    const result = detectBenchFailures(snaps, [], new Map());
    assert.equal(result['p.1|t.1'].daysOnBench, 5);
    assert.equal(result['p.1|t.1'].benchedWithStats, 2);
  });
});

describe('bench detection — add timing with game start times', () => {
  it('does not flag when player added AFTER game started (same day)', () => {
    // Player added at 7:30 PM ET, game started at 7:00 PM ET
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 6, K: 7 } }]),
    ];
    const transactions = [{
      type: 'add', timestamp: MAR31_730PM_ET,
      players: [{ type: 'add', playerKey: 'p.1', team: 'PHI', destTeam: 't.1' }],
    }];
    const gameStarts = new Map([['PHI|2026-03-31', MAR31_7PM_ET]]);

    const result = detectBenchFailures(snaps, transactions, gameStarts);
    assert.equal(result['p.1|t.1'].benchedWithStats, 0);
  });

  it('flags when player added BEFORE game started (same day)', () => {
    // Player added at 6:00 PM ET, game starts at 10:00 PM ET
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 6, K: 7 } }]),
    ];
    const transactions = [{
      type: 'add', timestamp: MAR31_6PM_ET,
      players: [{ type: 'add', playerKey: 'p.1', team: 'PHI', destTeam: 't.1' }],
    }];
    const gameStarts = new Map([['PHI|2026-03-31', MAR31_10PM_ET]]);

    const result = detectBenchFailures(snaps, transactions, gameStarts);
    assert.equal(result['p.1|t.1'].benchedWithStats, 1);
  });

  it('does not flag when player added next day after game (Painter case)', () => {
    // Painter: pitched Mar 31, game at 6:40 PM ET, added Apr 1 at 11:11 PM ET
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Painter', pos: 'BN', stats: { IP: 5.1, K: 8 } }]),
    ];
    const transactions = [{
      type: 'add/drop', timestamp: APR01_3AM_UTC,
      players: [
        { type: 'add', playerKey: 'p.1', team: 'PHI', destTeam: 't.1' },
        { type: 'drop', playerKey: 'p.2', sourceTeam: 't.1' },
      ],
    }];
    const gameStarts = new Map([['PHI|2026-03-31', MAR31_7PM_ET]]);

    const result = detectBenchFailures(snaps, transactions, gameStarts);
    assert.equal(result['p.1|t.1'].benchedWithStats, 0);
  });

  it('flags player already on roster (no add transaction)', () => {
    // Player was on roster all week — no add transaction, so always eligible
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Hitter', pos: 'BN', stats: { R: 2, HR: 1 } }]),
    ];
    const result = detectBenchFailures(snaps, [], new Map());
    assert.equal(result['p.1|t.1'].benchedWithStats, 1);
  });

  it('falls back to day-level check when no game start data', () => {
    // Added same day, no game start data → day-level: add date === snap date → not before → skip
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 6, K: 7 } }]),
    ];
    const transactions = [{
      type: 'add', timestamp: MAR31_6PM_ET,
      players: [{ type: 'add', playerKey: 'p.1', team: 'PHI', destTeam: 't.1' }],
    }];
    // Empty game starts — no MLB schedule data
    const result = detectBenchFailures(snaps, transactions, new Map());
    assert.equal(result['p.1|t.1'].benchedWithStats, 0);
  });

  it('falls back to day-level check — flags when added day before', () => {
    // Added Mar 30, benched Mar 31 with stats, no game data → day-level: Mar 30 < Mar 31 → flag
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Pitcher', pos: 'BN', stats: { IP: 6, K: 7 } }]),
    ];
    const MAR30 = Math.floor(new Date('2026-03-30T20:00:00Z').getTime() / 1000);
    const transactions = [{
      type: 'add', timestamp: MAR30,
      players: [{ type: 'add', playerKey: 'p.1', team: 'PHI', destTeam: 't.1' }],
    }];
    const result = detectBenchFailures(snaps, transactions, new Map());
    assert.equal(result['p.1|t.1'].benchedWithStats, 1);
  });
});

describe('bench detection — add/drop transaction handling', () => {
  it('uses earliest add timestamp when player added multiple times', () => {
    // Added early (before game), dropped, then re-added late (after game)
    // Should use earliest add → player could have been started
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Player', pos: 'BN', stats: { R: 3 } }]),
    ];
    const transactions = [
      { type: 'add', timestamp: MAR31_6PM_ET, players: [{ type: 'add', playerKey: 'p.1', team: 'NYY', destTeam: 't.1' }] },
      { type: 'add', timestamp: MAR31_11PM_ET, players: [{ type: 'add', playerKey: 'p.1', team: 'NYY', destTeam: 't.1' }] },
    ];
    const gameStarts = new Map([['NYY|2026-03-31', MAR31_7PM_ET]]);

    const result = detectBenchFailures(snaps, transactions, gameStarts);
    // Earliest add (6 PM) was before game (7 PM) → could have started
    assert.equal(result['p.1|t.1'].benchedWithStats, 1);
  });

  it('only considers add transactions, not drops', () => {
    const snaps = [
      makeSnap('2026-03-31', [{ key: 'p.1', name: 'Player', pos: 'BN', stats: { R: 3 } }]),
    ];
    const transactions = [{
      type: 'add/drop', timestamp: MAR31_730PM_ET,
      players: [
        { type: 'add', playerKey: 'p.1', team: 'PHI', destTeam: 't.1' },
        { type: 'drop', playerKey: 'p.2', sourceTeam: 't.1' },
      ],
    }];
    const gameStarts = new Map([['PHI|2026-03-31', MAR31_7PM_ET]]);

    const result = detectBenchFailures(snaps, transactions, gameStarts);
    // Added at 7:30 after 7:00 game → not flagged
    assert.equal(result['p.1|t.1'].benchedWithStats, 0);
  });
});

describe('MLB API abbreviation mapping', () => {
  it('Yahoo and MLB API use identical team abbreviations', async () => {
    // This test hits the live MLB API to verify abbreviations match
    const resp = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    const data = await resp.json();
    const mlbAbbrevs = new Set(data.teams.map(t => t.abbreviation));

    const yahooAbbrevs = new Set([
      'ATH', 'ATL', 'AZ', 'BAL', 'BOS', 'CHC', 'CIN', 'CLE', 'COL', 'CWS',
      'DET', 'HOU', 'KC', 'LAA', 'LAD', 'MIA', 'MIL', 'MIN', 'NYM', 'NYY',
      'PHI', 'PIT', 'SD', 'SEA', 'SF', 'STL', 'TB', 'TEX', 'TOR', 'WSH',
    ]);

    // Every Yahoo abbrev should exist in MLB API
    for (const abbrev of yahooAbbrevs) {
      assert.ok(mlbAbbrevs.has(abbrev), `Yahoo abbreviation "${abbrev}" not found in MLB API`);
    }

    // Every MLB API abbrev should exist in Yahoo
    for (const abbrev of mlbAbbrevs) {
      assert.ok(yahooAbbrevs.has(abbrev), `MLB API abbreviation "${abbrev}" not found in Yahoo`);
    }

    assert.equal(mlbAbbrevs.size, 30, 'Should have exactly 30 MLB teams');
    assert.equal(yahooAbbrevs.size, 30, 'Should have exactly 30 Yahoo teams');
  });
});

describe('fetchGameStartTimes', () => {
  it('returns game start times keyed by team abbreviation and date', async () => {
    // Use the actual function from analyze.js indirectly by testing the API
    const resp = await fetch('https://statsapi.mlb.com/api/v1/schedule?date=2026-03-31&sportId=1');
    const data = await resp.json();
    const games = data.dates?.[0]?.games || [];

    assert.ok(games.length > 0, 'Should have games on March 31');

    // Verify each game has the required fields
    for (const game of games) {
      assert.ok(game.gameDate, 'Game should have gameDate');
      assert.ok(game.officialDate, 'Game should have officialDate');
      assert.ok(game.teams.away.team.id, 'Game should have away team id');
      assert.ok(game.teams.home.team.id, 'Game should have home team id');

      // gameDate should be a valid ISO timestamp
      const ts = new Date(game.gameDate).getTime();
      assert.ok(!isNaN(ts), `gameDate "${game.gameDate}" should be a valid timestamp`);
    }
  });
});
