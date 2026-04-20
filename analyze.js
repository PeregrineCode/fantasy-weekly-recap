/**
 * Analysis module — transforms raw snapshot data into structured segments
 * for narrative generation. Pure data transforms, no API calls.
 *
 * Usage: node analyze.js [--week N]
 */

const fs = require('fs');
const path = require('path');
const { BATTING_CATS, PITCHING_CATS } = require('./lib/stat-categories');

/**
 * Fetch MLB game start times for a date range.
 * Returns a Map: "TEAM_ABBREV|YYYY-MM-DD" → game start timestamp (Unix seconds).
 * Uses the free MLB Stats API (no auth required).
 */
async function fetchGameStartTimes(startDate, endDate) {
  const gameStarts = new Map();
  const url = `https://statsapi.mlb.com/api/v1/schedule?startDate=${startDate}&endDate=${endDate}&sportId=1`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    // Fetch team abbreviations
    const teamsResp = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=' + startDate.substring(0, 4));
    const teamsData = await teamsResp.json();
    const idToAbbrev = {};
    for (const t of teamsData.teams) idToAbbrev[t.id] = t.abbreviation;

    for (const dateEntry of (data.dates || [])) {
      for (const game of dateEntry.games) {
        const startTs = Math.floor(new Date(game.gameDate).getTime() / 1000);
        const date = game.officialDate;
        for (const side of ['away', 'home']) {
          const abbrev = idToAbbrev[game.teams[side].team.id];
          if (abbrev) {
            const key = `${abbrev}|${date}`;
            // Keep earliest game if doubleheader
            if (!gameStarts.has(key) || startTs < gameStarts.get(key)) {
              gameStarts.set(key, startTs);
            }
          }
        }
      }
    }
  } catch (e) {
    console.log(`  Warning: could not fetch MLB schedule: ${e.message}`);
  }

  return gameStarts;
}

const ALL_CATS = [...BATTING_CATS, ...PITCHING_CATS];
const PITCHING_POSITIONS = ['SP', 'RP', 'P'];
const MIN_IP = 30; // League minimum innings pitched per week; below this, ratio cats are forfeited

/**
 * Load a snapshot file, returning null if it doesn't exist.
 */
function loadSnapshot(snapshotDir, filename) {
  const filepath = path.join(snapshotDir, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

/**
 * Build a teamKey → name lookup from all available data sources.
 * Uses the most recent name found (rosters > standings > scoreboard).
 */
function buildTeamNames(rosters, standings, scoreboard) {
  const map = {};
  // Scoreboard names (earliest, may be stale)
  if (scoreboard) {
    for (const m of scoreboard) {
      if (m.team1?.teamKey) map[m.team1.teamKey] = m.team1.name;
      if (m.team2?.teamKey) map[m.team2.teamKey] = m.team2.name;
    }
  }
  // Standings names
  if (standings) {
    for (const team of standings) {
      if (team.teamKey) map[team.teamKey] = team.name;
    }
  }
  // Roster names (most recent, wins)
  if (rosters) {
    for (const team of Object.values(rosters)) {
      map[team.teamKey] = team.name;
    }
  }
  return map;
}

// --- Segment analyzers ---

/**
 * Matchup recaps — who won, category scores, closest battles, blowouts.
 */
function analyzeMatchups(scoreboard, teamNames) {
  return scoreboard.map(m => {
    const isTie = m.team1Wins === m.team2Wins;

    // Find closest category margins
    const catDetails = m.statWinners.map(sw => {
      const t1Val = m.team1.stats[sw.stat] ?? 0;
      const t2Val = m.team2.stats[sw.stat] ?? 0;
      const cat = ALL_CATS.find(c => c.name === sw.stat);
      const margin = Math.abs(t1Val - t2Val);
      return {
        stat: sw.stat,
        display: cat?.display || sw.stat,
        team1Val: t1Val,
        team2Val: t2Val,
        margin,
        isTied: sw.isTied,
        winnerTeamKey: sw.winnerTeamKey,
      };
    });

    // Sort by margin to find closest battle
    const closest = catDetails
      .filter(c => !c.isTied)
      .sort((a, b) => a.margin - b.margin)[0] || null;

    const isBlowout = !isTie && Math.max(m.team1Wins, m.team2Wins) >= 8;

    // Flag teams below the minimum IP threshold (forfeit pitching ratio cats)
    const t1BelowIP = (m.team1.stats.IP || 0) < MIN_IP;
    const t2BelowIP = (m.team2.stats.IP || 0) < MIN_IP;

    if (isTie) {
      return {
        isTie: true,
        team1: { teamKey: m.team1.teamKey, name: teamNames[m.team1.teamKey] || m.team1.name, stats: m.team1.stats, belowIPMinimum: t1BelowIP },
        team2: { teamKey: m.team2.teamKey, name: teamNames[m.team2.teamKey] || m.team2.name, stats: m.team2.stats, belowIPMinimum: t2BelowIP },
        score: `${m.team1Wins}-${m.team2Wins}-${m.ties}`,
        winnerWins: m.team1Wins,
        loserWins: m.team2Wins,
        ties: m.ties,
        isBlowout: false,
        closest,
        categories: catDetails,
      };
    }

    const winner = m.team1Wins > m.team2Wins ? m.team1 : m.team2;
    const loser = m.team1Wins > m.team2Wins ? m.team2 : m.team1;
    const winnerBelowIP = winner === m.team1 ? t1BelowIP : t2BelowIP;
    const loserBelowIP = winner === m.team1 ? t2BelowIP : t1BelowIP;

    return {
      isTie: false,
      winner: { teamKey: winner.teamKey, name: teamNames[winner.teamKey] || winner.name, stats: winner.stats, belowIPMinimum: winnerBelowIP },
      loser: { teamKey: loser.teamKey, name: teamNames[loser.teamKey] || loser.name, stats: loser.stats, belowIPMinimum: loserBelowIP },
      score: `${Math.max(m.team1Wins, m.team2Wins)}-${Math.min(m.team1Wins, m.team2Wins)}-${m.ties}`,
      winnerWins: Math.max(m.team1Wins, m.team2Wins),
      loserWins: Math.min(m.team1Wins, m.team2Wins),
      ties: m.ties,
      isBlowout,
      closest,
      categories: catDetails,
    };
  }).sort((a, b) => {
    // Sort by drama: ties and closest matchups first, blowouts last
    const aDiff = a.winnerWins - a.loserWins;
    const bDiff = b.winnerWins - b.loserWins;
    return aDiff - bDiff;
  });
}

/**
 * Compute league-wide stat distributions from all players' weekly stats.
 * Returns { statName: { mean, std } } for z-score normalization.
 */
function computeStatDistributions(weeklyStats) {
  const values = {};
  const players = weeklyStats ? Object.values(weeklyStats) : [];

  for (const player of players) {
    if (!player.stats) continue;
    for (const cat of ALL_CATS) {
      const val = player.stats[cat.name];
      if (val == null || isNaN(val)) continue;
      if (!values[cat.name]) values[cat.name] = [];
      values[cat.name].push(val);
    }
  }

  const distributions = {};
  for (const [stat, vals] of Object.entries(values)) {
    if (vals.length < 2) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    distributions[stat] = { mean, std: std || 1 }; // avoid division by zero
  }

  return distributions;
}

// Module-level stat distributions — set once per analyze() call
let _statDistributions = {};

/**
 * Score a player's weekly value using z-scores normalized against league averages.
 * Each category contributes equally regardless of its raw scale.
 * Higher score = better performance relative to the league.
 */
function scorePlayer(stats) {
  let score = 0;
  for (const cat of ALL_CATS) {
    const val = stats[cat.name];
    if (val == null || isNaN(val)) continue;
    const dist = _statDistributions[cat.name];
    if (!dist) continue;

    let z = (val - dist.mean) / dist.std;
    if (cat.inverted) z = -z; // lower ERA/WHIP = positive z-score
    score += z;
  }
  return score;
}

/**
 * Score a pitcher's weekly performance using z-scores (pitching cats only).
 */
function scorePitcher(stats) {
  let score = 0;
  for (const cat of PITCHING_CATS) {
    const val = stats[cat.name];
    if (val == null || isNaN(val)) continue;
    const dist = _statDistributions[cat.name];
    if (!dist) continue;

    let z = (val - dist.mean) / dist.std;
    if (cat.inverted) z = -z;
    score += z;
  }
  return score;
}

/**
 * Find players that were added this week, enriched with weekly stats.
 */
/**
 * Check if a stats object has any real numeric scoring category values.
 */
function hasRealStats(stats) {
  for (const cat of ALL_CATS) {
    const val = stats[cat.name];
    if (val != null && typeof val === 'number' && !isNaN(val)) return true;
  }
  return false;
}

function findAddedPlayersWithStats(transactions, weeklyStats, teamNames) {
  const adds = transactions.filter(tx =>
    tx.type === 'add' || tx.type === 'add/drop'
  );

  // Build a set of players who were dropped by each team, so we can exclude
  // adds where the player was later dropped by the same team (not a real pickup).
  const droppedByTeam = new Set();
  for (const tx of transactions) {
    for (const p of tx.players) {
      if (p.type === 'drop') {
        droppedByTeam.add(`${p.playerKey}|${p.sourceTeam}`);
      }
    }
  }

  const results = [];
  for (const tx of adds) {
    const addedPlayers = tx.players.filter(p => p.type === 'add');
    for (const added of addedPlayers) {
      // Skip if this player was also dropped by the same team this week
      if (droppedByTeam.has(`${added.playerKey}|${added.destTeam}`)) continue;

      const teamName = teamNames[added.destTeam] || 'Unknown';
      const playerStats = weeklyStats[added.playerKey]?.stats || {};

      // Skip players with no real numeric stats (all dashes = no data)
      if (!hasRealStats(playerStats)) continue;

      results.push({
        name: added.name,
        team: added.team,
        position: added.position,
        fantasyTeam: teamName,
        stats: playerStats,
        score: scorePlayer(playerStats),
        isPitcher: PITCHING_POSITIONS.some(p => added.position.includes(p)),
        timestamp: tx.timestamp,
      });
    }
  }

  return results;
}

/**
 * Best pickup — added player with best weekly stat line.
 */
function analyzeBestPickup(transactions, weeklyStats, teamNames) {
  const added = findAddedPlayersWithStats(transactions, weeklyStats, teamNames);
  const sorted = added
    .filter(p => !p.isPitcher)
    .sort((a, b) => b.score - a.score);

  return {
    top: sorted.slice(0, 3).map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      fantasyTeam: p.fantasyTeam,
      stats: p.stats,
    })),
    count: sorted.length,
  };
}

/**
 * Worst pickup — added player who produced nothing or negative value.
 */
function analyzeWorstPickup(transactions, weeklyStats, teamNames) {
  const added = findAddedPlayersWithStats(transactions, weeklyStats, teamNames);
  const sorted = added.sort((a, b) => a.score - b.score);

  return {
    bottom: sorted.slice(0, 3).map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      fantasyTeam: p.fantasyTeam,
      stats: p.stats,
    })),
    count: sorted.length,
  };
}

/**
 * Best pitcher stream — best pitching add of the week.
 */
function analyzeBestStream(transactions, weeklyStats, teamNames) {
  const added = findAddedPlayersWithStats(transactions, weeklyStats, teamNames);
  const pitchers = added
    .filter(p => p.isPitcher)
    .sort((a, b) => scorePitcher(b.stats) - scorePitcher(a.stats));

  return {
    top: pitchers.slice(0, 3).map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      fantasyTeam: p.fantasyTeam,
      stats: p.stats,
    })),
    count: pitchers.length,
  };
}

/**
 * Trade recap — any trades that happened this week.
 */
/**
 * Transaction desk — trades and FAAB waiver bids for the week.
 * Combines both into a single segment so weeks with only one type still get coverage.
 */
function analyzeTransactionDesk(transactions, weeklyStats, teamNames, standings, week) {
  // --- Trades ---
  const trades = transactions.filter(tx => tx.type === 'trade').map(tx => {
    const sides = {};
    for (const p of tx.players) {
      const dest = p.destTeam;
      if (!sides[dest]) sides[dest] = { team: teamNames[dest] || dest, received: [] };
      sides[dest].received.push({
        name: p.name,
        team: p.team,
        position: p.position,
      });
    }
    return {
      timestamp: tx.timestamp,
      date: new Date(tx.timestamp * 1000).toLocaleDateString(),
      sides: Object.values(sides),
    };
  });

  // --- FAAB claims ---
  const faabClaims = transactions
    .filter(tx => tx.faabBid != null && tx.faabBid > 0)
    .map(tx => {
      const added = tx.players.find(p => p.type === 'add');
      const dropped = tx.players.find(p => p.type === 'drop');
      const stats = added ? weeklyStats[added.playerKey]?.stats || {} : {};
      return {
        player: added?.name || 'Unknown',
        playerTeam: added?.team || '',
        position: added?.position || '',
        fantasyTeam: teamNames[added?.destTeam] || 'Unknown',
        fantasyTeamKey: added?.destTeam || '',
        bid: tx.faabBid,
        dropped: dropped?.name || null,
        stats,
        timestamp: tx.timestamp,
      };
    })
    .sort((a, b) => b.bid - a.bid);

  if (trades.length === 0 && faabClaims.length === 0) {
    return { available: false };
  }

  // Merge manually-entered losing bids (from data/faab-bids.json)
  const faabBidsFile = path.join(__dirname, 'data', 'faab-bids.json');
  if (faabClaims.length > 0 && fs.existsSync(faabBidsFile)) {
    const allBids = JSON.parse(fs.readFileSync(faabBidsFile, 'utf-8'));
    const weekBids = allBids[String(week)] || [];
    for (const claim of faabClaims) {
      const entry = weekBids.find(b => b.player === claim.player);
      if (entry?.losingBids?.length > 0) {
        claim.losingBids = entry.losingBids;
      }
    }
  }

  // FAAB balances from standings (sourced from Yahoo's faab_balance field)
  let faabBudgets = null;
  if (faabClaims.length > 0) {
    faabBudgets = standings
      .filter(t => t.faabBalance != null)
      .map(t => ({
        team: teamNames[t.teamKey] || t.name,
        remaining: t.faabBalance,
      }))
      .sort((a, b) => a.remaining - b.remaining);
  }

  return {
    available: true,
    trades,
    faabClaims,
    faabBudgets,
    faabWeekTotal: faabClaims.reduce((sum, c) => sum + c.bid, 0),
  };
}

/**
 * Standings movers — compare current vs previous week rankings.
 */
function analyzeStandingsMovers(standings, prevStandings, teamNames) {
  if (!prevStandings) {
    return { available: false, movers: [] };
  }

  const prevRanks = {};
  for (const team of prevStandings) {
    prevRanks[team.teamKey] = team.rank;
  }

  const movers = standings.map(team => ({
    teamKey: team.teamKey,
    name: teamNames[team.teamKey] || team.name,
    rank: team.rank,
    prevRank: prevRanks[team.teamKey] || team.rank,
    change: (prevRanks[team.teamKey] || team.rank) - team.rank,
    record: `${team.wins}-${team.losses}-${team.ties}`,
    pct: team.pct,
  })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  return { available: true, movers };
}

/**
 * Power rankings — tier teams by record and recent performance.
 */
function analyzePowerRankings(standings, scoreboard, teamNames) {
  // Compute weekly performance from scoreboard, keyed by teamKey
  const weeklyPerf = {};
  for (const m of scoreboard) {
    const isTie = m.team1Wins === m.team2Wins;
    weeklyPerf[m.team1.teamKey] = { wins: m.team1Wins > m.team2Wins ? 1 : isTie ? 0.5 : 0, catWins: m.team1Wins, catLosses: m.team2Wins, isTie };
    weeklyPerf[m.team2.teamKey] = { wins: m.team2Wins > m.team1Wins ? 1 : isTie ? 0.5 : 0, catWins: m.team2Wins, catLosses: m.team1Wins, isTie };
  }

  const ranked = standings
    .map(team => {
      const weekly = weeklyPerf[team.teamKey] || { wins: 0, catWins: 0, catLosses: 0 };
      // Composite score: win% * 0.6 + weekly cat win rate * 0.4
      const seasonScore = team.pct;
      const weeklyScore = weekly.catWins / Math.max(1, weekly.catWins + weekly.catLosses);
      const composite = seasonScore * 0.6 + weeklyScore * 0.4;

      return {
        teamKey: team.teamKey,
        name: teamNames[team.teamKey] || team.name,
        rank: team.rank,
        record: `${team.wins}-${team.losses}-${team.ties}`,
        pct: team.pct,
        weeklyResult: weekly.wins === 1 ? 'W' : weekly.isTie ? 'T' : 'L',
        weeklyCatScore: `${weekly.catWins}-${weekly.catLosses}`,
        composite,
      };
    })
    .sort((a, b) => b.composite - a.composite);

  // Assign tiers
  const totalTeams = ranked.length;
  return ranked.map((team, i) => {
    let tier;
    const pct = i / totalTeams;
    if (pct < 0.25) tier = 'Contenders';
    else if (pct < 0.5) tier = 'Solid';
    else if (pct < 0.75) tier = 'Mediocre';
    else tier = 'Rebuilding';

    return { ...team, tier, powerRank: i + 1 };
  });
}

/**
 * Score a batter's weekly performance using z-scores (batting cats only).
 */
function scoreBatter(stats) {
  let score = 0;
  for (const cat of BATTING_CATS) {
    const val = stats[cat.name];
    if (val == null || isNaN(val)) continue;
    const dist = _statDistributions[cat.name];
    if (!dist) continue;

    let z = (val - dist.mean) / dist.std;
    if (cat.inverted) z = -z;
    score += z;
  }
  return score;
}

/**
 * Players of the Week — standout individual performances across all rosters.
 * Finds the top batters and top pitchers by z-score from weekly roster stats.
 * Excludes bench (BN) and injured list (IL/IL+) players.
 */
function analyzePlayersOfTheWeek(weeklyRosters) {
  if (!weeklyRosters) return { batters: [], pitchers: [] };

  const batters = [];
  const pitchers = [];

  for (const roster of Object.values(weeklyRosters)) {
    for (const player of roster.players) {
      // Skip bench and IL players — only count active lineup contributions
      if (['BN', 'IL', 'IL+'].includes(player.selectedPosition)) continue;

      const stats = player.stats || {};
      if (Object.keys(stats).length === 0) continue;
      if (!hasRealStats(stats)) continue;

      const isPitcher = PITCHING_POSITIONS.some(p => player.displayPosition.includes(p));

      const entry = {
        name: player.name,
        team: player.team,
        position: player.displayPosition,
        fantasyTeam: roster.name,
        stats,
      };

      if (isPitcher) {
        entry.score = scorePitcher(stats);
        pitchers.push(entry);
      } else {
        entry.score = scoreBatter(stats);
        batters.push(entry);
      }
    }
  }

  batters.sort((a, b) => b.score - a.score);
  pitchers.sort((a, b) => b.score - a.score);

  const mapOut = p => ({
    name: p.name,
    team: p.team,
    position: p.position,
    fantasyTeam: p.fantasyTeam,
    stats: p.stats,
  });

  return {
    batter: batters.length > 0 ? mapOut(batters[0]) : null,
    batterRunnersUp: batters.slice(1, 4).map(mapOut),
    pitcher: pitchers.length > 0 ? mapOut(pitchers[0]) : null,
    pitcherRunnersUp: pitchers.slice(1, 4).map(mapOut),
  };
}

/**
 * Waiver wire misses — best unrostered performers of the week.
 * Looks at all players on rosters who have low ownership.
 */
function analyzeWaiverMisses(rosters, weeklyRosters) {
  // Find low-ownership players who had great weeks.
  // Use season rosters for ownership data, weekly rosters for weekly stats.
  const allPlayers = [];

  // Build ownership lookup from season rosters
  const ownershipMap = {};
  if (rosters) {
    for (const roster of Object.values(rosters)) {
      for (const player of roster.players) {
        ownershipMap[player.playerKey] = player.ownership;
      }
    }
  }

  // Score players using weekly stats
  const source = weeklyRosters || rosters;
  if (!source) return [];

  for (const roster of Object.values(source)) {
    for (const player of roster.players) {
      const ownership = ownershipMap[player.playerKey] ?? player.ownership ?? 0;
      if (ownership <= 0 || ownership >= 30) continue;
      const stats = player.stats || {};
      if (Object.keys(stats).length === 0) continue;

      allPlayers.push({
        name: player.name,
        team: player.team,
        position: player.displayPosition,
        ownership,
        stats,
        score: scorePlayer(stats),
        fantasyTeam: roster.name,
      });
    }
  }

  allPlayers.sort((a, b) => b.score - a.score);
  return allPlayers.slice(0, 5).map(p => ({
    name: p.name,
    team: p.team,
    position: p.position,
    ownership: p.ownership,
    stats: p.stats,
    fantasyTeam: p.fantasyTeam,
  }));
}

/**
 * Compute rolling batting stats from recent weekly roster snapshots.
 * Looks back up to ROLLING_WEEKS weeks and sums H/AB to compute rolling AVG/OBP.
 * Returns { playerKey: { hits, ab, avg, obp, weeks } }
 */
const ROLLING_WEEKS = 3;

function computeRecentPlayerStats(currentWeek) {
  const playerTotals = {};
  let weeksFound = 0;

  for (let w = currentWeek; w >= 1 && w > currentWeek - ROLLING_WEEKS; w--) {
    const weekDir = path.join(__dirname, 'snapshots', `week-${String(w).padStart(2, '0')}`);
    const weeklyRosters = loadSnapshot(weekDir, 'weekly-rosters.json');
    if (!weeklyRosters) continue;
    weeksFound++;

    for (const roster of Object.values(weeklyRosters)) {
      for (const player of roster.players) {
        const hab = player.stats?.['H/AB'];
        if (hab == null) continue;
        // H/AB can be a number (from parseYahooStats) or string "5/20"
        let hits = 0, ab = 0;
        if (typeof hab === 'string' && hab.includes('/')) {
          const parts = hab.split('/');
          hits = parseInt(parts[0]) || 0;
          ab = parseInt(parts[1]) || 0;
        }
        if (ab === 0) continue;

        if (!playerTotals[player.playerKey]) {
          playerTotals[player.playerKey] = { hits: 0, ab: 0, obpNumer: 0, obpDenom: 0 };
        }
        playerTotals[player.playerKey].hits += hits;
        playerTotals[player.playerKey].ab += ab;

        // For OBP: use weekly OBP × PA as a rough weighted average
        const obp = player.stats?.OBP;
        if (obp != null && !isNaN(obp)) {
          // Approximate PA ≈ AB * 1.1 (rough)
          const pa = Math.round(ab * 1.1);
          playerTotals[player.playerKey].obpNumer += obp * pa;
          playerTotals[player.playerKey].obpDenom += pa;
        }
      }
    }
  }

  // Compute rolling averages
  const result = {};
  for (const [key, totals] of Object.entries(playerTotals)) {
    if (totals.ab < 1) continue;
    result[key] = {
      hits: totals.hits,
      ab: totals.ab,
      avg: totals.hits / totals.ab,
      obp: totals.obpDenom > 0 ? totals.obpNumer / totals.obpDenom : 0,
      weeks: weeksFound,
    };
  }
  return result;
}

/**
 * Front Office Failures — head-scratching roster decisions worth calling out.
 * Includes: benched players who went off, dropped players who went off,
 * roster dead weight, same-player carousel, IL hoarding.
 * Only included if there's material worth roasting.
 */
function analyzeRoasts(transactions, weeklyStats, rosters, weeklyRosters, teamNames, recentPlayerStats, dailySnapshots, scoreboard, gameStarts) {
  const roasts = [];

  // 1. Benched players who produced — uses daily roster snapshots for accuracy.
  //    A player only counts as "benched" on days they were on BN AND had stats that day.
  //    This avoids false positives for SPs who are naturally benched on non-start days.
  //    Also excludes days where the player was added after their game started —
  //    if a manager picked up a player after their game, they couldn't have started them.
  if (dailySnapshots && dailySnapshots.length > 0 && weeklyRosters) {
    // Build a lookup: "playerKey|teamKey" → add timestamp (Unix seconds)
    const addTimestamps = {};
    const addedPlayerTeams = {}; // playerKey → MLB team abbrev at time of add
    for (const tx of transactions) {
      if (tx.type !== 'add' && tx.type !== 'add/drop') continue;
      for (const p of tx.players) {
        if (p.type !== 'add' || !p.destTeam) continue;
        const key = `${p.playerKey}|${p.destTeam}`;
        // Keep earliest add timestamp if multiple
        if (!addTimestamps[key] || tx.timestamp < addTimestamps[key]) {
          addTimestamps[key] = tx.timestamp;
          addedPlayerTeams[key] = p.team; // MLB team abbreviation
        }
      }
    }

    // Build a map: playerKey → { teamKey, daysOnBench, totalDays, benchedWithStats, benchedDayStats[] }
    // Only trust positions from snapshots with nightly position data (positionsSource === 'nightly').
    // Snapshots without nightly positions have stale API positions from the next morning,
    // which reflect lineup changes made after games ended.
    const benchDays = {};
    for (const snap of dailySnapshots) {
      if (!snap.rosters) continue;
      if (snap.positionsSource !== 'nightly') continue;
      for (const roster of Object.values(snap.rosters)) {
        for (const player of roster.players) {
          const key = `${player.playerKey}|${roster.teamKey}`;
          if (!benchDays[key]) {
            benchDays[key] = { playerKey: player.playerKey, teamKey: roster.teamKey, name: player.name, daysOnBench: 0, totalDays: 0, benchedWithStats: 0, benchedDayStats: [] };
          }
          benchDays[key].totalDays++;
          const hadStats = player.stats && Object.values(player.stats).some(v => typeof v === 'number' && v !== 0);
          if (player.selectedPosition === 'BN') {
            benchDays[key].daysOnBench++;
            if (hadStats) {
              // Check if the player was added after their game started on this day.
              // If so, the manager couldn't have started them — not a benchable offense.
              const addTs = addTimestamps[key];
              let couldHaveStarted = true;
              if (addTs) {
                const mlbTeam = addedPlayerTeams[key];
                const gameStartTs = mlbTeam && gameStarts?.get(`${mlbTeam}|${snap.date}`);
                if (gameStartTs) {
                  // Player was added after their game started — can't be benched
                  couldHaveStarted = addTs < gameStartTs;
                } else {
                  // No game start data — fall back to day-level check
                  const addDate = new Date(addTs * 1000).toISOString().split('T')[0];
                  couldHaveStarted = addDate < snap.date;
                }
              }
              if (couldHaveStarted) {
                benchDays[key].benchedWithStats++;
                benchDays[key].benchedDayStats.push(player.stats);
              }
            }
          }
        }
      }
    }

    // Find players who were benched on at least 1 day they had stats
    for (const info of Object.values(benchDays)) {
      if (info.benchedWithStats === 0) continue;

      // Sum stats from only the benched days (not the full week)
      const benchStats = {};
      for (const dayStats of info.benchedDayStats) {
        for (const [k, v] of Object.entries(dayStats)) {
          if (typeof v !== 'number') continue;
          benchStats[k] = (benchStats[k] || 0) + v;
        }
      }
      // Drop daily ratio stats (AVG, OBP, ERA, WHIP, K/BB) — they can't be summed
      delete benchStats['AVG'];
      delete benchStats['OBP'];
      delete benchStats['ERA'];
      delete benchStats['WHIP'];
      delete benchStats['K/BB'];

      // Use counting-stat thresholds instead of z-scores (which are calibrated for
      // full-week totals and would filter out every single-day bench blunder).
      const isBatter = (benchStats['H/AB'] != null || benchStats['R'] != null);
      const isPitcher = (benchStats['IP'] != null || benchStats['K'] != null);
      let notable = false;
      if (isBatter) {
        notable = (benchStats['HR'] >= 1 || benchStats['RBI'] >= 3 || benchStats['SB'] >= 2 || benchStats['R'] >= 3);
      } else if (isPitcher) {
        // QS or SV+H on any benched day (SV+H caps at 1 per day).
        // For ratio check, use per-day ERA/WHIP from the raw daily stats
        // (not the summed benchStats where ratios were dropped).
        // A start with ERA < 3 and WHIP < 1.2 is always worth starting.
        notable = (benchStats['QS'] >= 1 || benchStats['SV+H'] >= 1);
        if (!notable) {
          notable = info.benchedDayStats.some(day =>
            day['IP'] > 0 && day['ERA'] != null && day['WHIP'] != null
            && day['ERA'] < 3 && day['WHIP'] < 1.2
          );
        }
      }
      if (!notable) continue;

      // Rank by simple fantasy points (z-scores are calibrated for weekly totals
      // and produce nonsensical rankings for daily counting stats).
      const score = (benchStats['R'] || 0) * 1 + (benchStats['HR'] || 0) * 4
        + (benchStats['RBI'] || 0) * 1 + (benchStats['SB'] || 0) * 2
        + (benchStats['K'] || 0) * 1 + (benchStats['QS'] || 0) * 5
        + (benchStats['SV+H'] || 0) * 3;

      const weeklyPlayer = weeklyStats[info.playerKey];
      const statLine = Object.entries(benchStats)
        .filter(([k, v]) => !isNaN(v) && v !== 0)
        .map(([k, v]) => `${k}: ${typeof v === 'number' && v % 1 !== 0 ? v.toFixed(3) : v}`)
        .join(', ');

      const benchDesc = info.daysOnBench === info.totalDays
        ? 'the entire week'
        : `${info.benchedWithStats} day(s) he had stats`;

      roasts.push({
        type: 'benched',
        playerName: info.name,
        playerTeam: weeklyPlayer?.team || '',
        position: weeklyPlayer?.position || '',
        fantasyTeam: teamNames[info.teamKey] || info.teamKey,
        stats: benchStats,
        score,
        description: `Benched ${info.name} on ${benchDesc} while he put up ${statLine}`,
      });
    }
  } else if (weeklyRosters) {
    // Fallback: use end-of-week roster positions (less accurate)
    for (const roster of Object.values(weeklyRosters)) {
      for (const player of roster.players) {
        if (player.selectedPosition !== 'BN') continue;
        const score = scorePlayer(player.stats);
        if (score <= 2) continue;

        const statLine = Object.entries(player.stats)
          .filter(([k, v]) => !isNaN(v) && v !== 0)
          .map(([k, v]) => `${k}: ${typeof v === 'number' && v % 1 !== 0 ? v.toFixed(3) : v}`)
          .join(', ');

        roasts.push({
          type: 'benched',
          playerName: player.name,
          playerTeam: player.team,
          position: player.displayPosition,
          fantasyTeam: teamNames[roster.teamKey] || roster.name,
          stats: player.stats,
          score,
          description: `Left ${player.name} on the bench while he put up ${statLine}`,
        });
      }
    }
  }

  // 2. Dropped players who had great weeks after being dropped
  const drops = transactions.filter(tx =>
    tx.type === 'drop' || tx.type === 'add/drop'
  );
  for (const tx of drops) {
    const droppedPlayers = tx.players.filter(p => p.type === 'drop');
    for (const dropped of droppedPlayers) {
      const stats = weeklyStats[dropped.playerKey]?.stats || {};
      const score = scorePlayer(stats);
      // z-score > 2 means the dropped player had a strong week
      if (score > 2) {
        roasts.push({
          type: 'drop_regret',
          playerName: dropped.name,
          playerTeam: dropped.team,
          position: dropped.position,
          fantasyTeam: teamNames[dropped.sourceTeam] || 'Unknown',
          stats,
          score,
          description: `Dropped ${dropped.name} who then put up a strong week`,
        });
      }
    }
  }

  // 3. Hot potato — players dropped by one team then picked up or traded by others
  const playerJourney = {};
  for (const tx of transactions) {
    for (const p of tx.players) {
      if (!playerJourney[p.playerKey]) playerJourney[p.playerKey] = { name: p.name, team: p.team, position: p.position, events: [] };
      playerJourney[p.playerKey].events.push({
        type: p.type,
        txType: tx.type,
        sourceTeam: p.sourceTeam,
        destTeam: p.destTeam,
        timestamp: tx.timestamp,
      });
    }
  }
  for (const [playerKey, info] of Object.entries(playerJourney)) {
    if (info.events.length < 2) continue;
    // Find cases where a player was dropped then added/traded elsewhere
    const dropEvents = info.events.filter(e => e.type === 'drop');
    const addEvents = info.events.filter(e => e.type === 'add' || e.type === 'trade');
    for (const drop of dropEvents) {
      const laterPickup = addEvents.find(a =>
        a.timestamp >= drop.timestamp && a.destTeam !== drop.sourceTeam
      );
      if (laterPickup) {
        const dropperName = teamNames[drop.sourceTeam] || 'Unknown';
        const pickerName = teamNames[laterPickup.destTeam] || 'Unknown';
        const method = laterPickup.txType === 'trade' ? 'traded for' : 'picked up';
        roasts.push({
          type: 'hot_potato',
          playerName: info.name,
          playerTeam: info.team,
          position: info.position,
          fantasyTeam: dropperName,
          stats: weeklyStats[playerKey]?.stats || {},
          score: 1, // moderate priority
          description: `${dropperName} dropped ${info.name}, who was then ${method} by ${pickerName}`,
        });
        break; // one roast per player
      }
    }
  }

  // 4. Roster dead weight — players with terrible rolling stats
  //    Uses recent weekly snapshots (last 3 weeks) to compute rolling averages.
  //    Falls back to season stats if not enough weekly data.
  if (rosters) {
    for (const roster of Object.values(rosters)) {
      for (const player of roster.players) {
        const rolling = recentPlayerStats?.[player.playerKey];
        if (rolling && rolling.ab >= 20 && rolling.avg < 0.150) {
          roasts.push({
            type: 'dead_weight',
            playerName: player.name,
            playerTeam: player.team,
            position: player.displayPosition,
            fantasyTeam: teamNames[roster.teamKey] || roster.name,
            stats: { AVG: rolling.avg, OBP: rolling.obp, AB: rolling.ab, weeks: rolling.weeks },
            score: 0,
            description: `Still rostering ${player.name} who is hitting ${rolling.avg.toFixed(3)} over the last ${rolling.weeks} week${rolling.weeks > 1 ? 's' : ''}`,
          });
        } else if (!rolling && player.stats?.AVG != null && player.stats.AVG < 0.150 && player.stats['H/AB']) {
          // Fallback to season stats if no weekly data
          const hab = String(player.stats['H/AB']);
          const parts = hab.split('/');
          const ab = parts.length === 2 ? parseInt(parts[1]) : 0;
          if (ab >= 30) {
            roasts.push({
              type: 'dead_weight',
              playerName: player.name,
              playerTeam: player.team,
              position: player.displayPosition,
              fantasyTeam: teamNames[roster.teamKey] || roster.name,
              stats: { AVG: player.stats.AVG, OBP: player.stats.OBP, AB: ab },
              score: 0,
              description: `Still rostering ${player.name} who is hitting ${player.stats.AVG.toFixed(3)} on the season`,
            });
          }
        }
      }
    }
  }

  // 4. Same-player carousel — add/dropped the same player multiple times in one week
  const playerTxCount = {};
  for (const tx of transactions) {
    for (const p of tx.players) {
      const key = `${p.playerKey}|${p.destTeam || p.sourceTeam}`;
      if (!playerTxCount[key]) playerTxCount[key] = { name: p.name, team: p.team, position: p.position, fantasyTeamKey: p.destTeam || p.sourceTeam, count: 0 };
      playerTxCount[key].count++;
    }
  }
  for (const [key, info] of Object.entries(playerTxCount)) {
    if (info.count >= 3) {
      roasts.push({
        type: 'carousel',
        playerName: info.name,
        playerTeam: info.team,
        position: info.position,
        fantasyTeam: teamNames[info.fantasyTeamKey] || 'Unknown',
        stats: {},
        score: 0,
        description: `Added/dropped ${info.name} ${info.count} times this week — make up your mind`,
      });
    }
  }

  // 5. IL hoarding — teams carrying 3+ IL players
  if (weeklyRosters) {
    for (const roster of Object.values(weeklyRosters)) {
      const ilPlayers = roster.players.filter(p => p.selectedPosition === 'IL' || p.selectedPosition === 'IL+');
      if (ilPlayers.length >= 3) {
        const names = ilPlayers.map(p => p.name).join(', ');
        roasts.push({
          type: 'il_hoarder',
          playerName: names,
          playerTeam: '',
          position: '',
          fantasyTeam: teamNames[roster.teamKey] || roster.name,
          stats: {},
          score: 0,
          description: `Carrying ${ilPlayers.length} IL players (${names}) — that's not a roster, it's a hospital ward`,
        });
      }
    }
  }

  // 6. Below IP minimum — teams that didn't pitch enough innings and forfeited ALL pitching categories
  if (scoreboard) {
    for (const m of scoreboard) {
      const opponent = (team) => team === m.team1 ? m.team2 : m.team1;
      for (const team of [m.team1, m.team2]) {
        const ip = team.stats?.IP || 0;
        if (ip < MIN_IP) {
          const opp = opponent(team);
          // Figure out which pitching cats they would have won if they'd hit the minimum
          const pitchingCats = PITCHING_CATS.map(c => c.name);
          const lowerIsBetter = { ERA: true, WHIP: true };
          const wouldHaveWon = pitchingCats.filter(cat => {
            const teamVal = team.stats?.[cat];
            const oppVal = opp.stats?.[cat];
            if (teamVal == null || oppVal == null) return false;
            return lowerIsBetter[cat] ? teamVal < oppVal : teamVal > oppVal;
          });

          const wouldHaveLost = pitchingCats.filter(cat => !wouldHaveWon.includes(cat));
          let desc = `Only pitched ${ip} innings (minimum is ${MIN_IP}) — forfeited ALL pitching categories.`;
          if (wouldHaveLost.length > 0) {
            desc += ` Would have lost ${wouldHaveLost.join(', ')} anyway.`;
          }
          if (wouldHaveWon.length > 0) {
            desc += ` But would have WON ${wouldHaveWon.join(', ')} — gave away ${wouldHaveWon.length} categor${wouldHaveWon.length === 1 ? 'y' : 'ies'} for free.`;
          }

          roasts.push({
            type: 'ip_minimum',
            playerName: '',
            playerTeam: '',
            position: '',
            fantasyTeam: teamNames[team.teamKey] || team.name,
            stats: { IP: ip },
            score: 100, // High priority — this is a major failure
            description: desc,
          });
        }
      }
    }
  }

  // Sort: benched and drop regrets first (by score), then other types
  roasts.sort((a, b) => b.score - a.score);
  return { available: roasts.length > 0, roasts: roasts.slice(0, 7) };
}

/**
 * Storylines — detect mid-week narratives from daily scoreboard snapshots.
 * Looks for comebacks, collapses, lead changes, sunday heroics, wire-to-wire dominance.
 */
function analyzeStorylines(dailySnapshots, finalScoreboard, teamNames) {
  if (!dailySnapshots || dailySnapshots.length < 2) {
    return { available: false, storylines: [] };
  }

  /**
   * For a given matchup across daily snapshots, compute who was leading each day
   * and the category score trajectory.
   */
  function computeMatchupArc(team1Key, team2Key) {
    const arc = [];
    for (const snap of dailySnapshots) {
      const matchup = snap.matchups.find(m =>
        (m.team1.teamKey === team1Key && m.team2.teamKey === team2Key) ||
        (m.team1.teamKey === team2Key && m.team2.teamKey === team1Key)
      );
      if (!matchup) continue;

      // Normalize so team1/team2 are consistent
      const flipped = matchup.team1.teamKey !== team1Key;
      const t1Wins = flipped ? matchup.team2Wins : matchup.team1Wins;
      const t2Wins = flipped ? matchup.team1Wins : matchup.team2Wins;
      const t1Stats = flipped ? matchup.team2.stats : matchup.team1.stats;
      const t2Stats = flipped ? matchup.team1.stats : matchup.team2.stats;

      arc.push({
        date: snap.date || snap.statsDate,
        t1Wins,
        t2Wins,
        ties: matchup.ties,
        leader: t1Wins > t2Wins ? 'team1' : t2Wins > t1Wins ? 'team2' : 'tied',
        t1Stats,
        t2Stats,
      });
    }
    return arc;
  }

  const storylines = [];

  for (const matchup of finalScoreboard) {
    const t1Key = matchup.team1.teamKey;
    const t2Key = matchup.team2.teamKey;
    const t1Name = teamNames[t1Key] || matchup.team1.name;
    const t2Name = teamNames[t2Key] || matchup.team2.name;
    const arc = computeMatchupArc(t1Key, t2Key);

    if (arc.length < 2) continue;

    // Skip tied matchups — no winner to build a storyline around
    if (matchup.team1Wins === matchup.team2Wins) continue;

    const finalWinner = matchup.team1Wins > matchup.team2Wins ? 'team1' : 'team2';
    const finalScore = `${Math.max(matchup.team1Wins, matchup.team2Wins)}-${Math.min(matchup.team1Wins, matchup.team2Wins)}-${matchup.ties}`;
    const winnerName = finalWinner === 'team1' ? t1Name : t2Name;
    const loserName = finalWinner === 'team1' ? t2Name : t1Name;

    // Count lead changes
    let leadChanges = 0;
    for (let i = 1; i < arc.length; i++) {
      if (arc[i].leader !== arc[i - 1].leader && arc[i].leader !== 'tied' && arc[i - 1].leader !== 'tied') {
        leadChanges++;
      }
    }

    // Check for comeback: winner was losing earlier in the week
    const winnerWasLosing = arc.some(day => day.leader !== finalWinner && day.leader !== 'tied');
    const maxDeficit = arc.reduce((worst, day) => {
      const deficit = finalWinner === 'team1'
        ? day.t2Wins - day.t1Wins
        : day.t1Wins - day.t2Wins;
      return Math.max(worst, deficit);
    }, 0);

    // Check for wire-to-wire: winner led every single day
    const wireToWire = arc.every(day => day.leader === finalWinner);

    // Sunday swing: leader changed on the final day
    const sundaySwing = arc.length >= 2 &&
      arc[arc.length - 1].leader !== arc[arc.length - 2].leader &&
      arc[arc.length - 1].leader === finalWinner &&
      arc[arc.length - 2].leader !== 'tied';

    // Find biggest single-day category swing
    let biggestSwing = null;
    if (arc.length >= 2) {
      const secondLast = arc[arc.length - 2];
      const last = arc[arc.length - 1];
      const catSwing = Math.abs(
        (last.t1Wins - last.t2Wins) - (secondLast.t1Wins - secondLast.t2Wins)
      );
      if (catSwing >= 3) {
        biggestSwing = {
          from: `${secondLast.t1Wins}-${secondLast.t2Wins}`,
          to: `${last.t1Wins}-${last.t2Wins}`,
          day: last.day,
          swing: catSwing,
        };
      }
    }

    // Build the arc summary for the prompt
    const arcSummary = arc.map(day => {
      const score = `${day.t1Wins}-${day.t2Wins}-${day.ties}`;
      const leader = day.leader === 'team1' ? t1Name : day.leader === 'team2' ? t2Name : 'Tied';
      return `${day.date}: ${score} — ${leader} leading`;
    });

    // Only create a storyline if something interesting happened
    if (winnerWasLosing && maxDeficit >= 2) {
      storylines.push({
        type: 'comeback',
        winner: winnerName,
        loser: loserName,
        finalScore,
        maxDeficit,
        leadChanges,
        sundaySwing,
        arc: arcSummary,
        drama: maxDeficit + leadChanges + (sundaySwing ? 3 : 0),
      });
    } else if (sundaySwing) {
      storylines.push({
        type: 'sunday_swing',
        winner: winnerName,
        loser: loserName,
        finalScore,
        biggestSwing,
        arc: arcSummary,
        drama: 4 + (biggestSwing?.swing || 0),
      });
    } else if (wireToWire && (matchup.team1Wins >= 8 || matchup.team2Wins >= 8)) {
      storylines.push({
        type: 'wire_to_wire',
        winner: winnerName,
        loser: loserName,
        finalScore,
        arc: arcSummary,
        drama: 2,
      });
    } else if (leadChanges >= 2) {
      storylines.push({
        type: 'seesaw',
        winner: winnerName,
        loser: loserName,
        finalScore,
        leadChanges,
        arc: arcSummary,
        drama: leadChanges + 1,
      });
    }
  }

  // Sort by drama level
  storylines.sort((a, b) => b.drama - a.drama);

  return { available: true, storylines };
}

// --- Main analysis ---

async function analyze(week) {
  const snapshotDir = path.join(__dirname, 'snapshots', `week-${String(week).padStart(2, '0')}`);

  if (!fs.existsSync(snapshotDir)) {
    console.error(`No snapshot found for week ${week} at ${snapshotDir}`);
    process.exit(1);
  }

  const meta = loadSnapshot(snapshotDir, 'meta.json');
  const scoreboard = loadSnapshot(snapshotDir, 'scoreboard.json') || [];
  const standings = loadSnapshot(snapshotDir, 'standings.json') || [];
  const transactions = loadSnapshot(snapshotDir, 'transactions.json') || [];
  const rosters = loadSnapshot(snapshotDir, 'rosters.json') || {};
  const weeklyStats = loadSnapshot(snapshotDir, 'weekly-stats.json') || {};
  const weeklyRosters = loadSnapshot(snapshotDir, 'weekly-rosters.json');

  // Try loading previous week's standings for movers
  const prevDir = path.join(__dirname, 'snapshots', `week-${String(week - 1).padStart(2, '0')}`);
  const prevStandings = loadSnapshot(prevDir, 'standings.json');

  const teamNames = buildTeamNames(rosters, standings, scoreboard);

  // Compute stat distributions for z-score normalization
  _statDistributions = computeStatDistributions(weeklyStats);

  // Load daily snapshots (used by storylines and bench analysis)
  // Files are named by date (YYYY-MM-DD.json), sorted chronologically.
  // Exclude positions-YYYY-MM-DD.json — those are raw position captures
  // from daily-positions.js that get merged into the stats files at collect time.
  const dailyDir = path.join(snapshotDir, 'daily');
  const dailySnapshots = [];
  if (fs.existsSync(dailyDir)) {
    const files = fs.readdirSync(dailyDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('positions-'))
      .sort();
    for (const file of files) {
      const data = loadSnapshot(dailyDir, file);
      if (data) dailySnapshots.push(data);
    }
  }

  const storylines = analyzeStorylines(dailySnapshots, scoreboard, teamNames);

  // Fetch MLB game start times for bench detection accuracy
  let gameStarts = new Map();
  if (meta?.weekStart && meta?.weekEnd) {
    gameStarts = await fetchGameStartTimes(meta.weekStart, meta.weekEnd);
  }

  console.log(`Analyzing Week ${week}...`);
  console.log(`  ${scoreboard.length} matchups, ${transactions.length} transactions, ${standings.length} teams, ${Object.keys(weeklyStats).length} players with weekly stats`);
  if (dailySnapshots.length > 0) {
    const hasRosters = dailySnapshots.some(s => s.rosters);
    console.log(`  ${dailySnapshots.length} daily snapshots${hasRosters ? ' (with roster positions)' : ''}`);
  } else {
    console.log(`  No daily snapshots found`);
  }
  if (storylines.available) {
    console.log(`  ${storylines.storylines.length} storylines detected`);
  }

  const analysis = {
    week,
    leagueName: meta?.leagueName || process.env.LEAGUE_NAME || "Fantasy Baseball League",
    weekStart: meta?.weekStart,
    weekEnd: meta?.weekEnd,
    segments: {
      storylines,
      matchups: analyzeMatchups(scoreboard, teamNames),
      playersOfTheWeek: analyzePlayersOfTheWeek(weeklyRosters),
      bestPickup: analyzeBestPickup(transactions, weeklyStats, teamNames),
      worstPickup: analyzeWorstPickup(transactions, weeklyStats, teamNames),
      bestStream: analyzeBestStream(transactions, weeklyStats, teamNames),
      transactionDesk: analyzeTransactionDesk(transactions, weeklyStats, teamNames, standings, week),
      standingsMovers: analyzeStandingsMovers(standings, prevStandings, teamNames),
      powerRankings: analyzePowerRankings(standings, scoreboard, teamNames),
      waiverMisses: analyzeWaiverMisses(rosters, weeklyRosters),
      roasts: analyzeRoasts(transactions, weeklyStats, rosters, weeklyRosters, teamNames, computeRecentPlayerStats(week), dailySnapshots, scoreboard, gameStarts),
    },
  };

  fs.writeFileSync(
    path.join(snapshotDir, 'analysis.json'),
    JSON.stringify(analysis, null, 2)
  );
  console.log(`  Saved analysis.json → ${snapshotDir}`);

  return analysis;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const weekIdx = args.indexOf('--week');
  const week = weekIdx !== -1 ? parseInt(args[weekIdx + 1]) : null;

  if (!week) {
    // Auto-detect from most recent snapshot
    const snapshotsDir = path.join(__dirname, 'snapshots');
    if (!fs.existsSync(snapshotsDir)) {
      console.error('No snapshots directory found. Run collect.js first.');
      process.exit(1);
    }
    const dirs = fs.readdirSync(snapshotsDir)
      .filter(d => d.startsWith('week-'))
      .sort()
      .reverse();
    if (dirs.length === 0) {
      console.error('No snapshot data found. Run collect.js first.');
      process.exit(1);
    }
    const latestWeek = parseInt(dirs[0].replace('week-', ''));
    analyze(latestWeek).catch(err => { console.error(err); process.exit(1); });
  } else {
    analyze(week).catch(err => { console.error(err); process.exit(1); });
  }
}

module.exports = { analyze };
