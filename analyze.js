/**
 * Analysis module — transforms raw snapshot data into structured segments
 * for narrative generation. Pure data transforms, no API calls.
 *
 * Usage: node analyze.js [--week N] [--league hockey]
 */

const fs = require('fs');
const path = require('path');
const { FINALS_ROUNDS } = require('./yahoo-helpers');
const { activeLeague } = require('./lib/league');
const { etDate, etHour } = require('./lib/et');

const league = activeLeague();
const sport = league.sportProfile;

// Teams with no manager (e.g. baseball's t.7 after Nate left) stay in
// league-wide segments but are excluded from editorial features — see lib/league.js.
const isAbandonedTeam = league.isAbandonedTeam;

const ALL_CATS = sport.allCats;
// League minimum innings pitched per week (baseball only); below this, all
// pitching cats are forfeited
const MIN_IP = sport.defaultMinIP != null ? (parseInt(league.setting('MIN_IP')) || sport.defaultMinIP) : null;

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
  // Each category's spread across every team this week. "Closest battle" is
  // judged in these units so ratio cats (.824 vs .974 SV%) aren't always
  // "closest" next to counting cats (47 vs 67 SOG) just for being small numbers.
  const catSpread = {};
  for (const cat of ALL_CATS) {
    const vals = scoreboard.flatMap(m => [m.team1.stats[cat.name], m.team2.stats[cat.name]])
      .filter(v => typeof v === 'number' && !isNaN(v));
    if (vals.length < 2) continue;
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    catSpread[cat.name] = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
  }

  return scoreboard.map(m => {
    const isTie = m.team1Wins === m.team2Wins;

    // Find closest category margins
    const catDetails = m.statWinners.map(sw => {
      const t1Val = m.team1.stats[sw.stat] ?? 0;
      const t2Val = m.team2.stats[sw.stat] ?? 0;
      const cat = ALL_CATS.find(c => c.name === sw.stat);
      const margin = Math.abs(t1Val - t2Val);
      const spreadMargin = margin / (catSpread[sw.stat] || 1);
      return {
        stat: sw.stat,
        display: cat?.display || sw.stat,
        team1Val: t1Val,
        team2Val: t2Val,
        margin,
        spreadMargin,
        isTied: sw.isTied,
        winnerTeamKey: sw.winnerTeamKey,
      };
    });

    // Sort by margin to find closest battle
    const closest = catDetails
      .filter(c => !c.isTied)
      .sort((a, b) => a.spreadMargin - b.spreadMargin)[0] || null;

    const isBlowout = !isTie && Math.max(m.team1Wins, m.team2Wins) >= sport.blowoutWins;

    // Flag teams below the minimum IP threshold (forfeit pitching ratio cats)
    const t1BelowIP = MIN_IP != null && (m.team1.stats.IP || 0) < MIN_IP;
    const t2BelowIP = MIN_IP != null && (m.team2.stats.IP || 0) < MIN_IP;

    if (isTie) {
      return {
        isTie: true,
        round: m.round || null,
        // Yahoo breaks category ties (e.g. by seed) — the official winner still matters in the playoffs
        yahooWinnerTeamKey: m.winnerTeamKey || null,
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
      round: m.round || null,
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
    // The championship always leads, whatever the score
    const aChamp = a.round === 'Championship' ? 0 : 1;
    const bChamp = b.round === 'Championship' ? 0 : 1;
    if (aChamp !== bChamp) return aChamp - bChamp;
    // Otherwise sort by drama: ties and closest matchups first, blowouts last
    const aDiff = a.winnerWins - a.loserWins;
    const bDiff = b.winnerWins - b.loserWins;
    return aDiff - bDiff;
  });
}

/**
 * Finals mode: the recap covers only the championship and third-place games.
 * Narrow every input to the four finalist teams so downstream segments
 * (players of the week, pickups, roasts, storylines) don't drift into the
 * consolation bracket. Standings-based segments are turned off by the caller.
 */
function restrictToFinalists({ scoreboard, rosters, weeklyRosters, weeklyStats, transactions, dailySnapshots }) {
  const finalsMatchups = scoreboard.filter(m => FINALS_ROUNDS.has(m.round));
  const finalistKeys = new Set(finalsMatchups.flatMap(m => [m.team1.teamKey, m.team2.teamKey]));
  const pick = obj => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => finalistKeys.has(k)));

  const finalistRosters = pick(rosters);
  const finalistWeeklyRosters = pick(weeklyRosters);
  const finalistPlayerKeys = new Set(
    Object.values(finalistWeeklyRosters).flatMap(t => (t.players || []).map(p => p.playerKey))
  );
  const finalistWeeklyStats = Object.fromEntries(
    Object.entries(weeklyStats || {}).filter(([k]) => finalistPlayerKeys.has(k))
  );
  const finalistTransactions = (transactions || []).filter(tx =>
    (tx.players || []).some(p => finalistKeys.has(p.sourceTeam) || finalistKeys.has(p.destTeam))
  );
  const finalistDaily = (dailySnapshots || []).map(snap => ({
    ...snap,
    matchups: (snap.matchups || []).filter(m => finalistKeys.has(m.team1.teamKey) && finalistKeys.has(m.team2.teamKey)),
    rosters: snap.rosters ? pick(snap.rosters) : snap.rosters,
  }));

  return {
    finalistKeys,
    scoreboard: finalsMatchups,
    rosters: finalistRosters,
    weeklyRosters: weeklyRosters ? finalistWeeklyRosters : weeklyRosters,
    weeklyStats: finalistWeeklyStats,
    transactions: finalistTransactions,
    dailySnapshots: finalistDaily,
  };
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
 * Score a player's weekly performance using z-scores over one group's
 * categories (e.g. batting cats for batters, goalie cats for goalies).
 */
function scoreCats(stats, cats) {
  let score = 0;
  for (const cat of cats) {
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

// Count fantasy days a pickup had to contribute, from the add timestamp through
// week end. ET-aware: an add after noon ET doesn't count that day (afternoon
// games already started), so a Saturday-night add for a Sunday-only week
// returns 1 day, not 2. Used to keep low-opportunity pickups out of the
// worst-pickup pool — a 1-day cold stat line isn't a roastable decision.
function computeDaysRostered(addTimestampSec, weekEndStr) {
  if (!addTimestampSec || !weekEndStr) return null;
  const addMs = addTimestampSec * 1000;
  const [ay, am, ad] = etDate(addMs).split('-').map(Number);
  const startDay = Date.UTC(ay, am - 1, ad) + (etHour(addMs) >= 12 ? 86400000 : 0);
  const [y, m, d] = weekEndStr.split('-').map(Number);
  const weekEndDay = Date.UTC(y, m - 1, d);
  return Math.max(0, Math.round((weekEndDay - startDay) / 86400000) + 1);
}

function findAddedPlayersWithStats(transactions, weeklyStats, teamNames, weekEnd) {
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
      if (isAbandonedTeam(added.destTeam)) continue;
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
        group: sport.groupForPosition(added.position),
        timestamp: tx.timestamp,
        daysRostered: computeDaysRostered(tx.timestamp, weekEnd),
      });
    }
  }

  return results;
}

/**
 * Best pickup — added player with best weekly stat line.
 */
function analyzeBestPickup(transactions, weeklyStats, teamNames, weekEnd) {
  const added = findAddedPlayersWithStats(transactions, weeklyStats, teamNames, weekEnd);
  const sorted = added
    .filter(p => p.group === sport.pickupGroup)
    .sort((a, b) => b.score - a.score);

  return {
    top: sorted.slice(0, 3).map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      fantasyTeam: p.fantasyTeam,
      stats: p.stats,
      daysRostered: p.daysRostered,
    })),
    count: sorted.length,
  };
}

/**
 * Worst pickup — added player who produced nothing or negative value.
 * Excludes players added too late in the week to have a real chance to
 * contribute (≤1 fantasy day) — a 0-fer in a single game isn't a roastable
 * decision, the manager simply didn't have a week of data to look bad.
 */
function analyzeWorstPickup(transactions, weeklyStats, teamNames, weekEnd) {
  const added = findAddedPlayersWithStats(transactions, weeklyStats, teamNames, weekEnd);
  const eligible = added.filter(p => p.daysRostered == null || p.daysRostered >= 2);
  const sorted = eligible.sort((a, b) => a.score - b.score);

  return {
    bottom: sorted.slice(0, 3).map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      fantasyTeam: p.fantasyTeam,
      stats: p.stats,
      daysRostered: p.daysRostered,
    })),
    count: sorted.length,
  };
}

/**
 * Best stream — best pitcher (baseball) or goalie (hockey) add of the week.
 * The sport's streamQualifies sets a workload floor (5+ IP, ~a full start in
 * net) so tiny relief lines can't dominate the ratio-stat z-scores.
 */
function analyzeBestStream(transactions, weeklyStats, teamNames, weekEnd) {
  const added = findAddedPlayersWithStats(transactions, weeklyStats, teamNames, weekEnd);
  const streamCats = sport.playerGroups.find(g => g.key === sport.streamGroup).cats;
  const pitchers = added
    .filter(p => p.group === sport.streamGroup && sport.streamQualifies(p.stats))
    .sort((a, b) => scoreCats(b.stats, streamCats) - scoreCats(a.stats, streamCats));

  return {
    top: pitchers.slice(0, 3).map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      fantasyTeam: p.fantasyTeam,
      stats: p.stats,
      daysRostered: p.daysRostered,
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
  const faabBidsFile = path.join(league.paths.data, 'faab-bids.json');
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
    weeklyPerf[m.team1.teamKey] = { wins: m.team1Wins > m.team2Wins ? 1 : isTie ? 0.5 : 0, catWins: m.team1Wins, catLosses: m.team2Wins, catTies: m.ties || 0, isTie };
    weeklyPerf[m.team2.teamKey] = { wins: m.team2Wins > m.team1Wins ? 1 : isTie ? 0.5 : 0, catWins: m.team2Wins, catLosses: m.team1Wins, catTies: m.ties || 0, isTie };
  }

  const ranked = standings
    .map(team => {
      const weekly = weeklyPerf[team.teamKey] || { wins: 0, catWins: 0, catLosses: 0, catTies: 0 };
      // Composite score: win% * 0.85 + weekly cat win rate * 0.15.
      // The weekly term nudges for hot/cold form without letting one matchup
      // overwhelm a team's season body of work — a 2-10 week shouldn't move
      // a top-3 team out of the top half.
      const seasonScore = team.pct;
      const weeklyScore = weekly.catWins / Math.max(1, weekly.catWins + weekly.catLosses);
      const composite = seasonScore * 0.85 + weeklyScore * 0.15;

      return {
        teamKey: team.teamKey,
        name: teamNames[team.teamKey] || team.name,
        rank: team.rank,
        record: `${team.wins}-${team.losses}-${team.ties}`,
        pct: team.pct,
        weeklyResult: weekly.wins === 1 ? 'W' : weekly.isTie ? 'T' : 'L',
        weeklyCatScore: `${weekly.catWins}-${weekly.catLosses}-${weekly.catTies}`,
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
 * Players of the Week — standout individual performances across all rosters.
 * Finds the top players in each of the sport's player groups (batters and
 * pitchers, or skaters and goalies) by z-score from weekly roster stats.
 * Excludes bench and injured-list players.
 * Returns { <group>: top, <group>RunnersUp: [...] } for each group.
 */
function analyzePlayersOfTheWeek(weeklyRosters) {
  const result = {};
  const pools = {};
  for (const g of sport.playerGroups) {
    pools[g.key] = [];
  }

  for (const [teamKey, roster] of Object.entries(weeklyRosters || {})) {
    if (isAbandonedTeam(teamKey)) continue;
    for (const player of roster.players) {
      // Skip bench and IL players — only count active lineup contributions
      if (sport.inactiveSlots.includes(player.selectedPosition)) continue;

      const stats = player.stats || {};
      if (Object.keys(stats).length === 0) continue;
      if (!hasRealStats(stats)) continue;

      const group = sport.playerGroups.find(g => g.key === sport.groupForPosition(player.displayPosition));
      if (group.qualifies && !group.qualifies(stats)) continue;

      pools[group.key].push({
        name: player.name,
        team: player.team,
        position: player.displayPosition,
        fantasyTeam: roster.name,
        stats,
        score: scoreCats(stats, group.cats),
      });
    }
  }

  const mapOut = p => ({
    name: p.name,
    team: p.team,
    position: p.position,
    fantasyTeam: p.fantasyTeam,
    stats: p.stats,
  });

  for (const g of sport.playerGroups) {
    const pool = pools[g.key].sort((a, b) => b.score - a.score);
    result[g.key] = pool.length > 0 ? mapOut(pool[0]) : null;
    result[`${g.key}RunnersUp`] = pool.slice(1, 4).map(mapOut);
  }
  return result;
}

/**
 * Front Office Failures — head-scratching roster decisions worth calling out.
 * Includes: benched players who went off, dropped players who went off,
 * roster dead weight, same-player carousel, IL hoarding.
 * Only included if there's material worth roasting.
 */
function analyzeRoasts(transactions, weeklyStats, rosters, weeklyRosters, teamNames, week, dailySnapshots, scoreboard, gameStarts) {
  const roasts = [];

  // 1. Benched players who produced — uses daily roster snapshots for accuracy.
  //    A player only counts as "benched" on days they were on BN AND had stats that day.
  //    This avoids false positives for SPs who are naturally benched on non-start days.
  //    Also excludes days where the player was added after their game started —
  //    if a manager picked up a player after their game, they couldn't have started them.
  if (dailySnapshots && dailySnapshots.length > 0 && weeklyRosters) {
    // Build a lookup: "playerKey|teamKey" → add timestamp (Unix seconds)
    const addTimestamps = {};
    const addedPlayerTeams = {}; // playerKey → pro team abbrev at time of add
    for (const tx of transactions) {
      if (tx.type !== 'add' && tx.type !== 'add/drop') continue;
      for (const p of tx.players) {
        if (p.type !== 'add' || !p.destTeam) continue;
        const key = `${p.playerKey}|${p.destTeam}`;
        // Keep earliest add timestamp if multiple
        if (!addTimestamps[key] || tx.timestamp < addTimestamps[key]) {
          addTimestamps[key] = tx.timestamp;
          addedPlayerTeams[key] = p.team; // pro team abbreviation
        }
      }
    }

    // Build a map: playerKey → { teamKey, daysOnBench, totalDays, benchedWithStats, benchedDayStats[] }
    // Only trust positions from snapshots with nightly position data (positionsSource === 'nightly').
    // Snapshots without nightly positions have stale API positions from the next morning,
    // which reflect lineup changes made after games ended.
    const benchDays = {};
    let nightlySnapshotCount = 0;
    for (const snap of dailySnapshots) {
      if (!snap.rosters) continue;
      if (snap.positionsSource !== 'nightly') continue;
      nightlySnapshotCount++;
      for (const roster of Object.values(snap.rosters)) {
        for (const player of roster.players) {
          const key = `${player.playerKey}|${roster.teamKey}`;
          if (!benchDays[key]) {
            benchDays[key] = { playerKey: player.playerKey, teamKey: roster.teamKey, name: player.name, daysOnBench: 0, totalDays: 0, benchedWithStats: 0, benchedDayStats: [] };
          }
          benchDays[key].totalDays++;
          const hadStats = player.stats && Object.values(player.stats).some(v => typeof v === 'number' && v !== 0);
          if (player.selectedPosition === sport.benchSlot) {
            benchDays[key].daysOnBench++;
            if (hadStats) {
              // Check if the player was added after their game started on this day.
              // If so, the manager couldn't have started them — not a benchable offense.
              const addTs = addTimestamps[key];
              let couldHaveStarted = true;
              if (addTs) {
                const proTeam = addedPlayerTeams[key];
                const gameStartTs = proTeam && gameStarts?.get(`${proTeam}|${snap.date}`);
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
      if (isAbandonedTeam(info.teamKey)) continue;
      if (info.benchedWithStats === 0) continue;
      // Skip players who were only on the roster for a single day — a late-week
      // pickup who didn't start is a timing slip, not a "front office failure."
      if (info.totalDays < 2) continue;

      // Sum stats from only the benched days (not the full week)
      const benchStats = {};
      for (const dayStats of info.benchedDayStats) {
        for (const [k, v] of Object.entries(dayStats)) {
          if (typeof v !== 'number') continue;
          benchStats[k] = (benchStats[k] || 0) + v;
        }
      }
      // Drop per-day ratio stats that can't be summed, then judge the benching
      // with counting-stat thresholds (z-scores are calibrated for full weeks)
      sport.normalizeBenchStats(benchStats);
      if (!sport.isNotableBenching(benchStats, info.benchedDayStats)) continue;
      const score = sport.benchScore(benchStats);

      const weeklyPlayer = weeklyStats[info.playerKey];
      const statLine = Object.entries(benchStats)
        .filter(([k, v]) => !isNaN(v) && v !== 0)
        .map(([k, v]) => `${k}: ${typeof v === 'number' && v % 1 !== 0 ? v.toFixed(3) : v}`)
        .join(', ');

      // "Entire week" only when we have trustworthy positions for EVERY day of the week
      // (no days dropped as premature/stale) AND the player was on the roster all of them
      // AND benched all of them. If some days were excluded, the trusted days are only a
      // slice of the week — claiming "the entire week" would overstate what we observed
      // (the player may have been started on an excluded day), so describe by day count.
      const fullWeekCoverage = dailySnapshots.length > 0 && nightlySnapshotCount === dailySnapshots.length;
      const benchDesc = (fullWeekCoverage && info.totalDays === nightlySnapshotCount && info.daysOnBench === nightlySnapshotCount)
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
  }
  // No daily snapshots → no bench blunders. Weekly roster positions are the
  // *current* lineup (Yahoo never returns historical positions), so treating
  // them as the week's lineup roasts stars who were simply off that day.

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

  // 4. Roster dead weight — players with terrible rolling stats (sport-specific:
  //    sub-.150 hitters in baseball, pointless skaters / leaky goalies in hockey)
  roasts.push(...sport.findDeadWeight({
    rosters,
    teamNames,
    week,
    loadWeeklyRosters: w => loadSnapshot(league.weekDir(w), 'weekly-rosters.json'),
  }));

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

  // 5. IL hoarding — teams carrying 3+ IL players (off where the league's own
  //    injured slots already allow that many)
  if (weeklyRosters && sport.injuredHoardThreshold) {
    for (const roster of Object.values(weeklyRosters)) {
      const ilPlayers = roster.players.filter(p => sport.injuredSlots.includes(p.selectedPosition));
      if (ilPlayers.length >= sport.injuredHoardThreshold) {
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
  if (scoreboard && MIN_IP != null) {
    for (const m of scoreboard) {
      const opponent = (team) => team === m.team1 ? m.team2 : m.team1;
      for (const team of [m.team1, m.team2]) {
        const ip = team.stats?.IP || 0;
        if (ip < MIN_IP) {
          const opp = opponent(team);
          // Figure out which pitching cats they would have won if they'd hit the minimum
          const pitchingCats = sport.categoryGroups.find(g => g.key === 'pitching').cats.map(c => c.name);
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
    } else if (wireToWire && (matchup.team1Wins >= sport.blowoutWins || matchup.team2Wins >= sport.blowoutWins)) {
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
  const snapshotDir = league.weekDir(week);

  if (!fs.existsSync(snapshotDir)) {
    console.error(`No snapshot found for week ${week} at ${snapshotDir}`);
    process.exit(1);
  }

  const meta = loadSnapshot(snapshotDir, 'meta.json');
  const fullScoreboard = loadSnapshot(snapshotDir, 'scoreboard.json') || [];
  let scoreboard = fullScoreboard;
  const standings = loadSnapshot(snapshotDir, 'standings.json') || [];
  let transactions = loadSnapshot(snapshotDir, 'transactions.json') || [];
  let rosters = loadSnapshot(snapshotDir, 'rosters.json') || {};
  let weeklyStats = loadSnapshot(snapshotDir, 'weekly-stats.json') || {};
  let weeklyRosters = loadSnapshot(snapshotDir, 'weekly-rosters.json');

  // Finals week: only the championship and third-place games get covered.
  const isFinals = !!meta?.isFinals && fullScoreboard.some(m => FINALS_ROUNDS.has(m.round));

  // Try loading previous week's standings for movers
  const prevDir = league.weekDir(week - 1);
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

  let dailySnapshots_ = dailySnapshots;
  if (isFinals) {
    const narrowed = restrictToFinalists({ scoreboard, rosters, weeklyRosters, weeklyStats, transactions, dailySnapshots });
    ({ scoreboard, rosters, weeklyRosters, weeklyStats, transactions } = narrowed);
    dailySnapshots_ = narrowed.dailySnapshots;
    console.log(`  FINALS mode: ${scoreboard.map(m => `${m.round}: ${m.team1.name} vs ${m.team2.name}`).join('; ')}`);
    console.log(`  Restricted to ${narrowed.finalistKeys.size} finalist teams (${fullScoreboard.length - scoreboard.length} consolation matchups dropped)`);
  }

  const storylines = analyzeStorylines(dailySnapshots_, scoreboard, teamNames);

  // Fetch pro game start times for bench detection accuracy
  let gameStarts = new Map();
  if (meta?.weekStart && meta?.weekEnd) {
    gameStarts = await sport.fetchGameStartTimes(meta.weekStart, meta.weekEnd);
  }

  console.log(`Analyzing ${league.id} Week ${week}...`);
  console.log(`  ${scoreboard.length} matchups, ${transactions.length} transactions, ${standings.length} teams, ${Object.keys(weeklyStats).length} players with weekly stats`);
  if (dailySnapshots_.length > 0) {
    const hasRosters = dailySnapshots_.some(s => s.rosters);
    console.log(`  ${dailySnapshots_.length} daily snapshots${hasRosters ? ' (with roster positions)' : ''}`);
  } else {
    console.log(`  No daily snapshots found`);
  }
  if (storylines.available) {
    console.log(`  ${storylines.storylines.length} storylines detected`);
  }

  const analysis = {
    week,
    leagueName: meta?.leagueName || league.leagueName() || league.defaultName,
    weekStart: meta?.weekStart,
    weekEnd: meta?.weekEnd,
    playoffs: {
      isPlayoffs: !!meta?.isPlayoffs,
      isFinals,
      // Bracket labels for every matchup this week, including the ones the
      // recap skips, so narrators can mention the consolation results if asked.
      rounds: fullScoreboard.map(m => ({ round: m.round || null, team1: teamNames[m.team1.teamKey] || m.team1.name, team2: teamNames[m.team2.teamKey] || m.team2.name, winnerTeamKey: m.winnerTeamKey || null })),
    },
    segments: {
      storylines,
      matchups: analyzeMatchups(scoreboard, teamNames),
      playersOfTheWeek: analyzePlayersOfTheWeek(weeklyRosters),
      bestPickup: analyzeBestPickup(transactions, weeklyStats, teamNames, meta?.weekEnd),
      worstPickup: analyzeWorstPickup(transactions, weeklyStats, teamNames, meta?.weekEnd),
      bestStream: analyzeBestStream(transactions, weeklyStats, teamNames, meta?.weekEnd),
      transactionDesk: analyzeTransactionDesk(transactions, weeklyStats, teamNames, standings, week),
      // Standings are frozen during the playoffs — movers and power rankings
      // would just restate the regular-season table, so the finals skip them.
      standingsMovers: isFinals ? { available: false, movers: [] } : analyzeStandingsMovers(standings, prevStandings, teamNames),
      powerRankings: isFinals ? [] : analyzePowerRankings(standings, scoreboard, teamNames),
      roasts: analyzeRoasts(transactions, weeklyStats, rosters, weeklyRosters, teamNames, week, dailySnapshots_, scoreboard, gameStarts),
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
    const snapshotsDir = league.paths.snapshots;
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

module.exports = { analyze, restrictToFinalists };
