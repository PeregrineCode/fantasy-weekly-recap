/**
 * Narrative generator — feeds analysis segments to claude CLI
 * to produce sports-anchor style markdown articles.
 *
 * Batches all segments by writer into single calls for consistency
 * (one writer won't contradict themselves across sections).
 *
 * Usage: node narrate.js [--week N] [--only key,...] [--except key,...] [--list-segments]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BATTING_CATS, PITCHING_CATS } = require('./lib/stat-categories');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'system.txt'), 'utf-8');
const REFERENCE = fs.readFileSync(path.join(__dirname, 'prompts', 'reference.md'), 'utf-8');

// Set before narration starts with current team key → name mapping
let teamNameBlock = '';

// Writer definitions
const WRITERS = {
  chuck: {
    name: 'Chuck "The Hammer" Morrison',
    prompt: 'You are Chuck "The Hammer" Morrison. Write in his voice as described in the Writers section of the reference.',
  },
  maddog: {
    name: '"Mad Dog" Maguire',
    prompt: 'You are "Mad Dog" Maguire. Write in his voice as described in the Writers section of the reference. You are brash, always certain, full of hot takes. You make sweeping declarations and contradict yourself with zero self-awareness.',
  },
  gerald: {
    name: 'Gerald R. Pemberton III',
    prompt: 'You are Gerald R. Pemberton III. Write in his voice as described in the Writers section of the reference. You love the numbers, you write concisely, and you let the stats tell the story. No filler, no jargon for jargon\'s sake.',
  },
  insider: {
    name: '"Deep Source" DiNapoli',
    prompt: 'You are "Deep Source" DiNapoli. Write in his voice as described in the Writers section of the reference. You are the league\'s insider, reporting on trade rumours and behind-the-scenes dealings with the urgency of a breaking news correspondent.',
  },
};

// Canonical segment registry — maps CLI keys to titles, writers, and batch groups.
// Requesting any 'tx'-group key regenerates the entire Transactions batch.
const SEGMENT_REGISTRY = [
  { key: 'matchups',      title: 'Matchup Recaps',           writer: 'chuck',  group: null },
  { key: 'potw',          title: 'Players of the Week',      writer: 'chuck',  group: null },
  { key: 'rankings',      title: 'Power Rankings',           writer: 'chuck',  group: null },
  { key: 'movers',        title: 'Movers and Shakers',       writer: 'chuck',  group: null },
  { key: 'best-pickup',   title: 'Best Pickup of the Week',  writer: 'chuck',  group: 'tx' },
  { key: 'hall-of-shame', title: 'Hall of Shame',            writer: 'chuck',  group: 'tx' },
  { key: 'stream',        title: 'Stream of the Week',       writer: 'chuck',  group: 'tx' },
  { key: 'roasts',        title: 'Front Office Failures',    writer: 'chuck',  group: 'tx' },
  { key: 'tx-desk',       title: 'Transaction Desk',         writer: 'chuck',  group: 'tx' },
  { key: 'insider',       title: 'The Insider Report',        writer: 'insider', group: null },
  { key: 'misses',        title: 'Ones That Got Away',       writer: 'chuck',  group: null },
  { key: 'maddog',        title: "Mad Dog's Hot Takes",      writer: 'maddog', group: null },
  { key: 'numbers',       title: "The Numbers Don't Lie",    writer: 'gerald', group: null },
];

/**
 * Call claude CLI with a batched prompt containing multiple segments.
 * Returns the raw output string.
 */
function callClaude(prompt, writerKey = 'chuck') {
  try {
    const writer = WRITERS[writerKey] || WRITERS.chuck;
    const fullPrompt = `${SYSTEM_PROMPT}\n\n${writer.prompt}\n\n---\n\n# Reference\n\n${REFERENCE}${teamNameBlock}\n\n---\n\n${prompt}`;

    const result = execFileSync('claude', ['--print', '--model', 'sonnet'], {
      input: fullPrompt,
      encoding: 'utf-8',
      timeout: 600000, // 10 min for batched segments
      maxBuffer: 2 * 1024 * 1024,
      // Clear ANTHROPIC_API_KEY so claude CLI uses its own stored OAuth credentials
      // rather than a raw API key. The CLI handles auth, rate limits, and retries.
      env: { ...process.env, TERM: 'dumb', ANTHROPIC_API_KEY: '' },
    });

    return result.trim();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.substring(0, 300) : '';
    console.log(`  Warning: claude CLI failed (exit ${e.status}): ${stderr || e.message}`);
    return null;
  }
}

/**
 * Build a batched prompt for a writer with multiple segments.
 * Each segment is separated by a clear delimiter that we can split on.
 */
function buildBatchPrompt(segmentPrompts) {
  const parts = segmentPrompts.map((sp, i) =>
    `=== SEGMENT ${i + 1}: ${sp.title} ===\n\n${sp.prompt}`
  );

  return `You have ${segmentPrompts.length} segments to write. Write ALL of them in order. Maintain consistent opinions across all segments — if you praise a player or move in one segment, do not contradict that take in another.\n\nSeparate each segment with exactly this delimiter on its own line:\n---SEGMENT_BREAK---\n\n${parts.join('\n\n')}`;
}

/**
 * Parse batched output into individual segment texts.
 */
function parseBatchOutput(output, expectedCount) {
  const segments = output.split(/---SEGMENT_BREAK---/).map(s => s.trim()).filter(Boolean);
  // If splitting didn't work, try to find segment headers
  if (segments.length < expectedCount) {
    const altSegments = output.split(/===\s*SEGMENT\s+\d+/).map(s => s.trim()).filter(Boolean);
    if (altSegments.length >= expectedCount) return altSegments;
  }
  return segments;
}

// --- Segment prompts (same as before, just return the prompt text) ---

const THREE_DECIMAL_STATS = new Set(['AVG', 'OBP']);
const TWO_DECIMAL_STATS = new Set(['ERA', 'WHIP', 'K/BB', 'IP']);
const fmtStat = (k, v) => {
  if (typeof v !== 'number' || v % 1 === 0) return `${k}: ${v}`;
  if (THREE_DECIMAL_STATS.has(k)) return `${k}: ${v.toFixed(3)}`;
  if (TWO_DECIMAL_STATS.has(k)) return `${k}: ${v.toFixed(2)}`;
  return `${k}: ${v.toFixed(2)}`;
};

function promptMatchupRecaps(matchups, storylines) {
  if (!matchups.length) return null;

  const data = matchups.map(m => {
    if (m.isTie) {
      const t1Stats = Object.entries(m.team1.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
      const t2Stats = Object.entries(m.team2.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
      return `RESULT: ${m.team1.name} TIED ${m.team2.name} ${m.score} (this is a TIE — neither team won)` +
        (m.closest ? ` — closest cat: ${m.closest.stat} (margin: ${m.closest.margin.toFixed(3)})` : '') +
        `\n  ${m.team1.name} stats: ${t1Stats}` +
        `\n  ${m.team2.name} stats: ${t2Stats}`;
    }
    const winnerStats = Object.entries(m.winner.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    const loserStats = Object.entries(m.loser.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    const ipWarnings = [];
    for (const [team, opp] of [[m.winner, m.loser], [m.loser, m.winner]]) {
      if (!team.belowIPMinimum) continue;
      const pitchCats = ['K', 'ERA', 'WHIP', 'K/BB', 'QS', 'SV+H'];
      const lowerBetter = { ERA: true, WHIP: true };
      const wouldWin = pitchCats.filter(c => {
        const tv = team.stats?.[c], ov = opp.stats?.[c];
        return tv != null && ov != null && (lowerBetter[c] ? tv < ov : tv > ov);
      });
      const wouldLose = pitchCats.filter(c => !wouldWin.includes(c));
      const minIP = parseInt(process.env.MIN_IP) || 30;
      let warn = `${team.name} was BELOW the ${minIP} IP minimum (${fmtStat('IP', team.stats.IP)}) — forfeited ALL pitching categories.`;
      if (wouldLose.length) warn += ` Would have lost ${wouldLose.join(', ')} anyway.`;
      if (wouldWin.length) warn += ` But would have WON ${wouldWin.join(', ')} — gave away ${wouldWin.length} categories for free, flipping the matchup result.`;
      ipWarnings.push(warn);
    }
    return `RESULT: ${m.winner.name} beat ${m.loser.name} ${m.score}` +
      (m.isBlowout ? ' (BLOWOUT)' : '') +
      (m.closest ? ` — closest cat: ${m.closest.stat} (margin: ${m.closest.margin.toFixed(3)})` : '') +
      (ipWarnings.length ? `\n  ⚠️ ${ipWarnings.join('; ')}` : '') +
      `\n  ${m.winner.name} stats: ${winnerStats}` +
      `\n  ${m.loser.name} stats: ${loserStats}`;
  }).join('\n\n');

  // Attach mid-week storyline arcs to the prompt if available
  let storylineBlock = '';
  if (storylines?.available && storylines.storylines.length > 0) {
    const typeLabels = { comeback: 'COMEBACK', sunday_swing: 'SUNDAY SWING', wire_to_wire: 'WIRE-TO-WIRE DOMINANCE', seesaw: 'SEESAW BATTLE' };
    const arcs = storylines.storylines.map(s => {
      let detail = `[${typeLabels[s.type] || s.type.toUpperCase()}] ${s.winner} def. ${s.loser} ${s.finalScore}`;
      if (s.maxDeficit) detail += ` — overcame a ${s.maxDeficit}-category deficit`;
      if (s.leadChanges) detail += ` — ${s.leadChanges} lead change(s)`;
      if (s.sundaySwing) detail += ` — won it on the final day`;
      detail += '\n  Day-by-day:\n  ' + s.arc.join('\n  ');
      return detail;
    }).join('\n\n');
    storylineBlock = `\n\nMid-week drama (use this to add color to the relevant matchup recaps — lead changes, comebacks, Sunday swings):\n${arcs}`;
  }

  const numCats = BATTING_CATS.length + PITCHING_CATS.length;
  return `Write the "Matchup Recaps" segment. This is a ${numCats}-category league — all scores must add up to ${numCats}. Lead with the most dramatic matchup. Every matchup MUST be mentioned. Use the EXACT scores provided. If a matchup says TIED, report it as a tie.\n\nFor matchups that had mid-week drama (comebacks, lead changes, Sunday swings), weave the storyline into the recap — don't just report the final score, tell the story of how it got there.\n\nIMPORTANT: Each team's stats are labeled with their name. Do NOT swap stats between teams.\n\nMatchup results:\n${data}${storylineBlock}`;
}

function promptPlayersOfTheWeek(segment) {
  if (!segment?.batter && !segment?.pitcher) return null;

  const fmtPlayer = (p, label) => {
    const statLine = Object.entries(p.stats).filter(([k, v]) => !isNaN(v) && v !== 0).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `${label}: ${p.name} (${p.position}, ${p.team}) — ${p.fantasyTeam}\n   Stats: ${statLine}`;
  };

  const parts = [];

  if (segment.batter) {
    const lines = [fmtPlayer(segment.batter, 'BATTER OF THE WEEK')];
    if (segment.batterRunnersUp.length > 0) {
      lines.push('Runners-up:');
      segment.batterRunnersUp.forEach((p, i) => lines.push(fmtPlayer(p, `  ${i + 1}`)));
    }
    parts.push(lines.join('\n'));
  }

  if (segment.pitcher) {
    const lines = [fmtPlayer(segment.pitcher, 'PITCHER OF THE WEEK')];
    if (segment.pitcherRunnersUp.length > 0) {
      lines.push('Runners-up:');
      segment.pitcherRunnersUp.forEach((p, i) => lines.push(fmtPlayer(p, `  ${i + 1}`)));
    }
    parts.push(lines.join('\n'));
  }

  return `Write "Players of the Week" highlighting the most dominant individual performances across the league. Crown one batter and one pitcher as the week's standout stars, then give brief nods to the runners-up. Focus on what made these performances special — historic stat lines, clutch timing, or absurd dominance. Use your baseball knowledge to add context about the players. 2-3 paragraphs.\n\n${parts.join('\n\n')}`;
}

function promptPowerRankings(rankings) {
  if (!rankings.length) return null;
  const data = rankings.map((t, i) =>
    `${i + 1}. ${t.name} [${t.tier}] — ${t.record} (${t.pct.toFixed(3)}) — This week: ${t.weeklyResult} (${t.weeklyCatScore})`
  ).join('\n');
  return `Write the "Power Rankings". Rank every team explicitly #1 through #${rankings.length}. Give each team a 1-2 sentence take. Group by tier (Contenders, Solid, Mediocre, Rebuilding) with a brief intro per tier.\n\nRankings:\n${data}`;
}

function promptBestPickup(segment) {
  if (!segment.top.length) return null;
  const data = segment.top.map(p => {
    const statLine = Object.entries(p.stats).filter(([k, v]) => v !== 0 && !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `${p.name} (${p.position}, ${p.team}) — picked up by ${p.fantasyTeam}\n  Stats: ${statLine}`;
  }).join('\n\n');
  return `Write the "Best Pickup of the Week". Crown the #1 pickup, praise the manager, mention runners-up briefly.\n\nTop pickups:\n${data}`;
}

function promptWorstPickup(segment) {
  if (!segment.bottom.length) return null;
  const data = segment.bottom.map(p => {
    const statLine = Object.entries(p.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `${p.name} (${p.position}, ${p.team}) — picked up by ${p.fantasyTeam}\n  Stats: ${statLine}`;
  }).join('\n\n');
  return `Write the "Hall of Shame" about the worst waiver pickups this week. Roast the decisions. Be funny about it.\n\nWorst pickups:\n${data}`;
}

function promptBestStream(segment) {
  if (!segment.top.length) return null;
  const data = segment.top.map(p => {
    const statLine = Object.entries(p.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `${p.name} (${p.position}, ${p.team}) — streamed by ${p.fantasyTeam}\n  Stats: ${statLine}`;
  }).join('\n\n');
  return `Write the "Stream of the Week" about the best pitcher streaming decision. Focus on the pitching line.\n\nTop pitcher streams:\n${data}`;
}

function promptTransactionDesk(segment) {
  if (!segment.available) return null;

  const parts = [];

  // Trades section
  if (segment.trades.length > 0) {
    const tradeData = segment.trades.map(t => {
      const sides = t.sides.map(s =>
        `${s.team} RECEIVED: ${s.received.map(p => `${p.name} (${p.position}, ${p.team})`).join(', ')}`
      ).join('\n  ');
      return `Trade on ${t.date}:\n  ${sides}`;
    }).join('\n\n');
    parts.push(`TRADES:\n${tradeData}\n\nIMPORTANT: Each team RECEIVED the players listed next to their name. Do NOT reverse the direction.`);
  }

  // FAAB section
  if (segment.faabClaims.length > 0) {
    const claims = segment.faabClaims.map(c => {
      const statLine = Object.entries(c.stats)
        .filter(([k, v]) => !isNaN(v) && v !== 0)
        .map(([k, v]) => fmtStat(k, v)).join(', ');
      const startingBudget = parseInt(process.env.FAAB_BUDGET) || 200;
      const pctOfBudget = Math.round((c.bid / startingBudget) * 100);
      let line = `${c.fantasyTeam} bid $${c.bid} (${pctOfBudget}% of starting budget) on ${c.player} (${c.position}, ${c.playerTeam})`;
      if (c.dropped) line += `, dropping ${c.dropped}`;
      if (c.losingBids?.length > 0) {
        const losers = c.losingBids.map(b => `${b.team} $${b.bid}`).join(', ');
        line += `\n  Losing bids: ${losers}`;
      }
      if (statLine) line += `\n  Weekly stats: ${statLine}`;
      return line;
    }).join('\n\n');

    const budgetLines = segment.faabBudgets.map(b =>
      `${b.team}: $${b.remaining} remaining`
    ).join('\n');

    const faabBudget = parseInt(process.env.FAAB_BUDGET) || 200;
    parts.push(`FAAB BIDS (this is a $${faabBudget} FAAB league):\n${claims}\n\nTotal FAAB spent this week: $${segment.faabWeekTotal}\n\nFAAB budgets remaining:\n${budgetLines}`);
  }

  let prompt = `Write the "Transaction Desk" covering this week's major roster moves. `;
  if (segment.trades.length > 0 && segment.faabClaims.length > 0) {
    prompt += `Cover both trades and FAAB waiver bids. For trades, pick a winner and defend it. For FAAB, highlight the biggest bids, whether the spend looks justified, and who's burning through their budget. 3-4 paragraphs.`;
  } else if (segment.trades.length > 0) {
    prompt += `Cover this week's trades. Pick a winner and defend it. 2-3 paragraphs.`;
  } else {
    prompt += `Cover this week's FAAB waiver bidding. Highlight the biggest bids, whether the spend looks justified, and who's burning through their budget vs. sitting on their war chest. 2-3 paragraphs.`;
  }

  return `${prompt}\n\n${parts.join('\n\n')}`;
}

function promptStandingsMovers(movers) {
  if (!movers.available) return null;
  const significant = movers.movers.filter(m => m.change !== 0);
  if (!significant.length) return null;
  const data = significant.map(m => {
    const dir = m.change > 0 ? `UP ${m.change}` : `DOWN ${Math.abs(m.change)}`;
    return `${m.name}: ${dir} → now #${m.rank} (${m.record})`;
  }).join('\n');
  return `Write "Movers and Shakers" about standings movement. 1-2 paragraphs.\n\nStandings changes:\n${data}`;
}

function promptWaiverMisses(misses) {
  if (!misses.length) return null;
  const data = misses.map(p => {
    const statLine = Object.entries(p.stats).filter(([k, v]) => !isNaN(v) && v !== 0).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `${p.name} (${p.position}, ${p.team}) — ${p.ownership}% owned, rostered by ${p.fantasyTeam}\n  Stats: ${statLine}`;
  }).join('\n\n');
  return `Write "Ones That Got Away" about low-ownership players who had great weeks. 1-2 paragraphs.\n\nLow-owned performers:\n${data}`;
}

function promptRoasts(segment) {
  if (!segment.available || !segment.roasts.length) return null;
  const typeLabels = { benched: 'LEFT ON BENCH', drop_regret: 'DROP REGRET', dead_weight: 'DEAD WEIGHT', carousel: 'PLAYER CAROUSEL', il_hoarder: 'IL HOARDER', hot_potato: 'HOT POTATO' };
  const data = segment.roasts.map(r => {
    const label = typeLabels[r.type] || r.type.toUpperCase();
    const statLine = Object.keys(r.stats).length > 0
      ? Object.entries(r.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ')
      : '';
    return `[${label}] ${r.fantasyTeam}: ${r.description}${statLine ? `\n  Stats: ${statLine}` : ''}`;
  }).join('\n\n');
  return `Write "Front Office Failures" roasting the worst roster decisions. Be creative and funny. 2-4 paragraphs.\n\nQuestionable decisions:\n${data}`;
}

function promptMadDogHotTakes(powerRankings, matchups) {
  if (!powerRankings.length) return null;
  const rankData = powerRankings.map((t, i) =>
    `${i + 1}. ${t.name} [${t.tier}] — ${t.record} (${t.pct.toFixed(3)}) — This week: ${t.weeklyResult} (${t.weeklyCatScore})`
  ).join('\n');
  const matchupData = matchups.map(m =>
    m.isTie ? `${m.team1.name} tied ${m.team2.name} ${m.score}` : `${m.winner.name} beat ${m.loser.name} ${m.score}`
  ).join('\n');
  return `Write "Mad Dog's Hot Takes". Cover 2-3 of: declare a team DONE, crown a dynasty, make a bold prediction for next week, call out something that has you furious. Overreact wildly. 3-4 paragraphs.\n\nStandings:\n${rankData}\n\nResults:\n${matchupData}`;
}

function promptNumbersDontLie(matchups, powerRankings, scoreboard) {
  if (!powerRankings.length) return null;

  const allTeamStats = {};
  const sb = scoreboard || [];
  for (const m of sb) {
    allTeamStats[m.team1.name] = m.team1.stats;
    allTeamStats[m.team2.name] = m.team2.stats;
  }

  const invertedStats = new Set([...BATTING_CATS, ...PITCHING_CATS].filter(c => c.inverted).map(c => c.name));
  const cats = Object.keys(Object.values(allTeamStats)[0] || {});
  const leagueContext = [];
  for (const cat of cats) {
    const vals = Object.entries(allTeamStats).map(([name, stats]) => ({ name, val: stats[cat] })).filter(e => !isNaN(e.val)).sort((a, b) => b.val - a.val);
    if (vals.length === 0) continue;
    // For inverted stats (ERA, WHIP), lower is better
    const best = invertedStats.has(cat) ? vals[vals.length - 1] : vals[0];
    const worst = invertedStats.has(cat) ? vals[0] : vals[vals.length - 1];
    leagueContext.push(`${cat}: best ${best.name} (${fmtStat(cat, best.val)}), worst ${worst.name} (${fmtStat(cat, worst.val)}), avg ${fmtStat(cat, vals.reduce((s,e) => s+e.val, 0)/vals.length)}`);
  }

  const matchupData = matchups.map(m => {
    if (m.isTie) {
      const t1Stats = Object.entries(m.team1.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
      const t2Stats = Object.entries(m.team2.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
      return `${m.team1.name} TIED ${m.team2.name} (${m.score})\n  ${m.team1.name}: ${t1Stats}\n  ${m.team2.name}: ${t2Stats}`;
    }
    const winStats = Object.entries(m.winner.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    const loseStats = Object.entries(m.loser.stats).filter(([k, v]) => !isNaN(v)).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `${m.winner.name} (${m.score}) vs ${m.loser.name}\n  ${m.winner.name}: ${winStats}\n  ${m.loser.name}: ${loseStats}`;
  }).join('\n\n');

  return `Write "The Numbers Don't Lie". Find 2-3 interesting statistical stories: teams that led the league in a stat but lost, record performances, matchup luck, unsustainable lines. Compare against league averages. 3-4 paragraphs.\n\nLeague-wide category leaders:\n${leagueContext.join('\n')}\n\nMatchup details:\n${matchupData}`;
}

// --- Rumours ---

/**
 * Fetch trade rumours from the Cloudflare Worker API.
 * Returns [] if RUMOURS_API_URL is not set or the request fails.
 */
async function fetchRumours(weekStart) {
  const apiUrl = process.env.RUMOURS_API_URL;
  if (!apiUrl) return [];

  try {
    const url = new URL(apiUrl);
    url.searchParams.set('since', weekStart);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  Warning: rumours API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.rumours || [];
  } catch (e) {
    console.log(`  Warning: could not fetch rumours: ${e.message}`);
    return [];
  }
}

function promptInsiderReport(rumours, powerRankings, transactions) {
  if (!rumours.length) return null;

  const tips = rumours.map((r, i) => {
    const date = new Date(r.submittedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const source = r.source ? ` (via ${r.source})` : '';
    return `TIP ${i + 1} [${date}]${source}: ${r.text}`;
  }).join('\n\n');

  let context = '';

  if (powerRankings?.length) {
    const standingsData = powerRankings.map((t, i) =>
      `${i + 1}. ${t.name} — ${t.record} (${t.pct.toFixed(3)}) [${t.tier}]`
    ).join('\n');
    context += `\nCURRENT STANDINGS (for context):\n${standingsData}\n`;
  }

  if (transactions?.available) {
    const parts = [];
    if (transactions.trades?.length) {
      parts.push('Recent trades: ' + transactions.trades.map(t =>
        t.sides.map(s => `${s.team} received ${s.received.map(p => p.name).join(', ')}`).join(' / ')
      ).join('; '));
    }
    if (transactions.faabClaims?.length) {
      const topClaims = transactions.faabClaims.slice(0, 5);
      parts.push('Recent FAAB: ' + topClaims.map(c => `${c.fantasyTeam} bid $${c.bid} on ${c.player}`).join('; '));
    }
    if (parts.length) context += `\nRECENT TRANSACTIONS (for context):\n${parts.join('\n')}\n`;
  }

  return `Write "The Insider Report" — a column covering trade rumours and behind-the-scenes dealings in the league.

You have received the following tips from sources around the league. Weave them into a cohesive insider column. Don't just list the rumours — connect them to the team's standing, recent moves, and league dynamics. Speculate on motivations and potential trade partners. Treat each tip like a legitimate insider scoop.

Address every tip at least briefly — don't skip any. Write 3-5 paragraphs depending on the number of tips. If there are only 1-2 tips, fill out the column with speculation about teams that should be making moves based on their standings position.

TIPS FROM SOURCES:
${tips}
${context}`;
}

// --- Fallback templates ---

function fallbackMatchups(matchups) {
  return matchups.map(m => {
    if (m.isTie) return `**${m.team1.name}** and **${m.team2.name}** tied ${m.score}.`;
    return `**${m.winner.name}** took down **${m.loser.name}** with a ${m.score} victory.`;
  }).join('\n\n');
}

function fallbackSimple(label, items) {
  if (!items.length) return `*No ${label} this week.*`;
  return items.map(p => {
    const statLine = Object.entries(p.stats || {}).filter(([k, v]) => !isNaN(v) && v !== 0).map(([k, v]) => fmtStat(k, v)).join(', ');
    return `**${p.name}** (${p.position}, ${p.team})${p.fantasyTeam ? ` — ${p.fantasyTeam}` : ''}: ${statLine}`;
  }).join('\n\n');
}

function fallbackPowerRankings(rankings) {
  let currentTier = '';
  return rankings.map((t, i) => {
    let tierHeader = '';
    if (t.tier !== currentTier) { currentTier = t.tier; tierHeader = `\n**${t.tier}**\n\n`; }
    return `${tierHeader}${i + 1}. **${t.name}** (${t.record}) — ${t.weeklyResult} this week (${t.weeklyCatScore})`;
  }).join('\n');
}

// --- Article parsing for selective regeneration ---

/**
 * Parse an existing article markdown into its header and ordered sections.
 * Returns { header, sections: [{ title, byline, content }] } or null if unparseable.
 */
function parseArticleSections(markdown) {
  const firstSectionIdx = markdown.indexOf('\n## ');
  if (firstSectionIdx === -1) return null;

  const header = markdown.substring(0, firstSectionIdx + 1);
  const body = markdown.substring(firstSectionIdx + 1);

  const parts = body.split(/^(?=## )/m);
  const sections = [];

  for (const part of parts) {
    if (!part.trim()) continue;
    const titleMatch = part.match(/^## (.+)\n/);
    if (!titleMatch) continue;

    const bylineMatch = part.match(/<p class="byline">by (.+?)<\/p>/);
    let content = '';
    if (bylineMatch) {
      const afterByline = part.substring(part.indexOf(bylineMatch[0]) + bylineMatch[0].length);
      content = afterByline.replace(/\n---\s*$/, '').trim();
    }

    sections.push({
      title: titleMatch[1],
      byline: bylineMatch ? bylineMatch[1] : '',
      content,
    });
  }

  return { header, sections };
}

/**
 * Match parsed article sections to segment registry entries using fuzzy scoring.
 * Returns Map<sectionIndex, registryKey>.
 */
function matchSectionsToRegistry(sections) {
  const matches = new Map();
  const usedKeys = new Set();

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let bestKey = null;
    let bestScore = -1;

    for (const entry of SEGMENT_REGISTRY) {
      if (usedKeys.has(entry.key)) continue;

      let score = 0;
      if (section.title === entry.title) score += 100;
      if (section.byline === WRITERS[entry.writer].name) score += 10;

      // Word overlap (skip short common words)
      const sWords = new Set(section.title.toLowerCase().split(/\s+/));
      const eWords = new Set(entry.title.toLowerCase().split(/\s+/));
      for (const w of sWords) {
        if (w.length > 2 && eWords.has(w)) score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestKey = entry.key;
      }
    }

    if (bestKey && bestScore > 0) {
      matches.set(i, bestKey);
      usedKeys.add(bestKey);
      console.log(`  Matched "${section.title}" → ${bestKey} (score: ${bestScore})`);
    } else {
      console.log(`  Warning: could not match section "${section.title}" to any segment`);
    }
  }

  return matches;
}

/**
 * Splice new section content into an existing parsed article.
 * Preserves existing titles and bylines; only replaces content for targeted sections.
 */
function spliceArticle(parsed, newSections, sectionToKey) {
  const newContentByKey = new Map();
  for (const ns of newSections) newContentByKey.set(ns.registryKey, ns.content);

  const registryIndex = new Map();
  SEGMENT_REGISTRY.forEach((entry, idx) => registryIndex.set(entry.key, idx));

  // Build emit list from existing sections (content possibly replaced by newContentByKey).
  const emit = [];
  for (let i = 0; i < parsed.sections.length; i++) {
    const existing = parsed.sections[i];
    const key = sectionToKey.get(i);
    const newContent = key ? newContentByKey.get(key) : null;
    emit.push({
      key,
      title: existing.title,
      byline: existing.byline,
      content: newContent != null ? newContent : existing.content,
    });
  }

  // Insert any new sections that don't correspond to an existing section,
  // placing each at its registry position relative to existing sections.
  const existingKeys = new Set(emit.map(e => e.key).filter(k => k != null));
  for (const ns of newSections) {
    if (existingKeys.has(ns.registryKey)) continue;
    const regEntry = SEGMENT_REGISTRY.find(e => e.key === ns.registryKey);
    if (!regEntry) continue;
    const writer = WRITERS[regEntry.writer];
    const insertRegIdx = registryIndex.get(ns.registryKey);

    let insertAt = emit.length;
    for (let i = 0; i < emit.length; i++) {
      const existingRegIdx = emit[i].key != null ? (registryIndex.get(emit[i].key) ?? Infinity) : Infinity;
      if (existingRegIdx > insertRegIdx) { insertAt = i; break; }
    }
    emit.splice(insertAt, 0, {
      key: ns.registryKey,
      title: regEntry.title,
      byline: writer.name,
      content: ns.content,
    });
  }

  let article = parsed.header;
  for (const e of emit) {
    article += `## ${e.title}\n\n<p class="byline">by ${e.byline}</p>\n\n${e.content}\n\n---\n\n`;
  }
  return article;
}

// --- Main narration ---

async function narrate(week, { only, except } = {}) {
  const snapshotDir = path.join(__dirname, 'snapshots', `week-${String(week).padStart(2, '0')}`);
  const analysisPath = path.join(snapshotDir, 'analysis.json');

  if (!fs.existsSync(analysisPath)) {
    console.error(`No analysis found for week ${week}. Run analyze.js first.`);
    process.exit(1);
  }

  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
  const { segments } = analysis;

  const scoreboardPath = path.join(snapshotDir, 'scoreboard.json');
  const rawScoreboard = fs.existsSync(scoreboardPath)
    ? JSON.parse(fs.readFileSync(scoreboardPath, 'utf-8'))
    : [];

  const rostersPath = path.join(snapshotDir, 'rosters.json');
  teamNameBlock = '';
  if (fs.existsSync(rostersPath)) {
    const rosters = JSON.parse(fs.readFileSync(rostersPath, 'utf-8'));
    const lines = Object.values(rosters).map(t => {
      const shortKey = 't.' + t.teamKey.replace(/.*\./, '');
      return `${shortKey} = ${t.name}`;
    });
    teamNameBlock = `\n\n# Current Team Names\n${lines.join('\n')}\n`;
  }

  // Fetch trade rumours from the API (if configured)
  const rumours = await fetchRumours(analysis.weekStart || '');

  console.log(`Generating narrative for Week ${week}...`);
  if (rumours.length > 0) {
    console.log(`  Loaded ${rumours.length} rumour(s) for the insider column`);
  }

  // --- Build segment prompts ---

  // Individual: Matchup Recaps (largest prompt, runs first)
  const matchupP = promptMatchupRecaps(segments.matchups, segments.storylines);
  const matchupSeg = matchupP ? { title: 'Matchup Recaps', prompt: matchupP, fallback: () => fallbackMatchups(segments.matchups) } : null;

  // Individual: Players of the Week
  const potwP = promptPlayersOfTheWeek(segments.playersOfTheWeek);
  const potwSeg = potwP ? { title: 'Players of the Week', prompt: potwP, fallback: '*No standout performances this week.*' } : null;

  // Individual: Power Rankings
  const prP = promptPowerRankings(segments.powerRankings);
  const prSeg = prP ? { title: 'Power Rankings', prompt: prP, fallback: () => fallbackPowerRankings(segments.powerRankings) } : null;

  // Individual: Standings Movers (if available)
  const moversP = promptStandingsMovers(segments.standingsMovers);
  const moversSeg = moversP ? { title: 'Movers and Shakers', prompt: moversP, fallback: '' } : null;

  // Batch 2: "Transactions" — player moves, needs consistent takes on which decisions were smart/dumb
  const txBatch = [];
  const bestP = promptBestPickup(segments.bestPickup);
  if (bestP) txBatch.push({ title: 'Best Pickup of the Week', prompt: bestP, fallback: () => fallbackSimple('pickups', segments.bestPickup.top) });
  const worstP = promptWorstPickup(segments.worstPickup);
  if (worstP) txBatch.push({ title: 'Hall of Shame', prompt: worstP, fallback: () => fallbackSimple('duds', segments.worstPickup.bottom) });
  const streamP = promptBestStream(segments.bestStream);
  if (streamP) txBatch.push({ title: 'Stream of the Week', prompt: streamP, fallback: () => fallbackSimple('streams', segments.bestStream.top) });
  if (segments.roasts?.available) {
    const roastsP = promptRoasts(segments.roasts);
    if (roastsP) txBatch.push({ title: 'Front Office Failures', prompt: roastsP, fallback: () => segments.roasts.roasts.map(r => `**${r.fantasyTeam}**: ${r.description}`).join('\n\n') });
  }
  if (segments.transactionDesk?.available) {
    const txDeskP = promptTransactionDesk(segments.transactionDesk);
    if (txDeskP) txBatch.push({ title: 'Transaction Desk', prompt: txDeskP, fallback: '*No trades or FAAB activity this week.*' });
  }

  // Individual: Insider Report (only if rumours exist)
  const insiderP = promptInsiderReport(rumours, segments.powerRankings, segments.transactionDesk);
  const insiderSeg = insiderP ? { title: 'The Insider Report', prompt: insiderP, fallback: '*Our insider is currently unreachable. Check back next week.*' } : null;

  // Individual: Waiver Misses (self-contained)
  const missesP = promptWaiverMisses(segments.waiverMisses);
  const missesSeg = missesP ? { title: 'Ones That Got Away', prompt: missesP, fallback: () => fallbackSimple('sleepers', segments.waiverMisses) } : null;

  // Individual: Mad Dog (isolation is the point)
  const maddogP = promptMadDogHotTakes(segments.powerRankings, segments.matchups);
  const maddogSeg = maddogP ? { title: "Mad Dog's Hot Takes", prompt: maddogP, fallback: '*Mad Dog was unavailable for comment this week.*' } : null;

  // Individual: Gerald (analytical, independent)
  const numbersP = promptNumbersDontLie(segments.matchups, segments.powerRankings, rawScoreboard);
  const geraldSeg = numbersP ? { title: "The Numbers Don't Lie", prompt: numbersP, fallback: '*Gerald is recalculating. Please stand by.*' } : null;

  // --- Generate ---

  const articlesDir = path.join(__dirname, 'articles');
  fs.mkdirSync(articlesDir, { recursive: true });
  const articlePath = path.join(articlesDir, `week-${String(week).padStart(2, '0')}.md`);

  // Map registry keys to their individual segment objects
  const individualSegs = [
    ['matchups', matchupSeg, 'chuck', 'Matchup Recaps'],
    ['potw', potwSeg, 'chuck', 'Players of the Week'],
    ['rankings', prSeg, 'chuck', 'Power Rankings'],
    ['movers', moversSeg, 'chuck', 'Movers and Shakers'],
    ['insider', insiderSeg, 'insider', 'The Insider Report'],
    ['misses', missesSeg, 'chuck', 'Ones That Got Away'],
    ['maddog', maddogSeg, 'maddog', "Mad Dog's Hot Takes"],
    ['numbers', geraldSeg, 'gerald', "The Numbers Don't Lie"],
  ];

  // Build title→key lookup for tx batch entries
  const txTitleToKey = {};
  for (const entry of SEGMENT_REGISTRY) {
    if (entry.group === 'tx') txTitleToKey[entry.title] = entry.key;
  }

  // --- Selective regeneration path ---
  if (only || except) {
    // Resolve target keys
    let targetKeys;
    if (only) {
      targetKeys = new Set(only);
    } else {
      const allKeys = SEGMENT_REGISTRY.map(s => s.key);
      targetKeys = new Set(allKeys.filter(k => !except.includes(k)));
    }

    // Expand tx group: if any tx key is targeted, include all tx keys
    const txKeys = SEGMENT_REGISTRY.filter(s => s.group === 'tx').map(s => s.key);
    const hasTx = txKeys.some(k => targetKeys.has(k));
    if (hasTx) {
      const added = txKeys.filter(k => !targetKeys.has(k));
      for (const k of txKeys) targetKeys.add(k);
      if (added.length > 0) {
        console.log(`  Expanded to full Transactions batch (+${added.join(', ')})`);
      }
    }

    console.log(`  Targeting: ${[...targetKeys].join(', ')}`);

    // Read existing article
    if (!fs.existsSync(articlePath)) {
      console.log(`  No existing article at ${articlePath} — falling back to full generation`);
    } else {
      const existingMarkdown = fs.readFileSync(articlePath, 'utf-8');
      const parsed = parseArticleSections(existingMarkdown);

      if (!parsed) {
        console.log(`  Could not parse existing article — falling back to full generation`);
      } else {
        // Match existing sections to registry
        console.log(`  Matching ${parsed.sections.length} existing sections to registry...`);
        const sectionToKey = matchSectionsToRegistry(parsed.sections);

        // Backup existing article
        const bakPath = articlePath + '.bak';
        fs.writeFileSync(bakPath, existingMarkdown);
        console.log(`  Backup saved → ${bakPath}`);

        // Generate only targeted segments
        const newSections = [];

        // Individual segments
        for (const [key, seg, writerKey, label] of individualSegs) {
          if (!targetKeys.has(key) || !seg) continue;
          const writer = WRITERS[writerKey];
          console.log(`  Regenerating ${label} (${writer.name})...`);
          const text = callClaude(seg.prompt, writerKey) || (typeof seg.fallback === 'function' ? seg.fallback() : seg.fallback);
          newSections.push({ registryKey: key, content: text });
        }

        // Tx batch (if any tx key targeted)
        if (hasTx && txBatch.length > 0) {
          const writer = WRITERS.chuck;
          console.log(`  Regenerating Transactions batch (${writer.name}, ${txBatch.length} segments)...`);

          if (txBatch.length === 1) {
            const seg = txBatch[0];
            const text = callClaude(seg.prompt, 'chuck') || (typeof seg.fallback === 'function' ? seg.fallback() : seg.fallback);
            const rKey = txTitleToKey[seg.title];
            if (rKey) newSections.push({ registryKey: rKey, content: text });
          } else {
            const batchPrompt = buildBatchPrompt(txBatch);
            const output = callClaude(batchPrompt, 'chuck');

            if (output) {
              const batchParsed = parseBatchOutput(output, txBatch.length);
              for (let i = 0; i < txBatch.length; i++) {
                const text = batchParsed[i] || (typeof txBatch[i].fallback === 'function' ? txBatch[i].fallback() : txBatch[i].fallback);
                const rKey = txTitleToKey[txBatch[i].title];
                if (rKey) newSections.push({ registryKey: rKey, content: text });
              }
            } else {
              for (const seg of txBatch) {
                const text = typeof seg.fallback === 'function' ? seg.fallback() : seg.fallback;
                const rKey = txTitleToKey[seg.title];
                if (rKey) newSections.push({ registryKey: rKey, content: text });
              }
            }
          }
        }

        // Splice and write
        const article = spliceArticle(parsed, newSections, sectionToKey);
        fs.writeFileSync(articlePath, article);
        console.log(`\nArticle updated → ${articlePath}`);
        return articlePath;
      }
    }
  }

  // --- Full generation path (default) ---

  const sections = [];

  function generateBatch(writerKey, batch, label) {
    if (batch.length === 0) return;
    const writer = WRITERS[writerKey];
    console.log(`  Generating ${label} (${writer.name}, ${batch.length} segments)...`);

    if (batch.length === 1) {
      const seg = batch[0];
      const text = callClaude(seg.prompt, writerKey) || (typeof seg.fallback === 'function' ? seg.fallback() : seg.fallback);
      sections.push({ title: seg.title, content: text, byline: writer.name });
      return;
    }

    const batchPrompt = buildBatchPrompt(batch);
    const output = callClaude(batchPrompt, writerKey);

    if (output) {
      const parsed = parseBatchOutput(output, batch.length);
      for (let i = 0; i < batch.length; i++) {
        const text = parsed[i] || (typeof batch[i].fallback === 'function' ? batch[i].fallback() : batch[i].fallback);
        sections.push({ title: batch[i].title, content: text, byline: writer.name });
      }
    } else {
      for (const seg of batch) {
        const text = typeof seg.fallback === 'function' ? seg.fallback() : seg.fallback;
        sections.push({ title: seg.title, content: text, byline: writer.name });
      }
    }
  }

  function generateSingle(writerKey, seg, label) {
    if (!seg) return;
    const writer = WRITERS[writerKey];
    console.log(`  Generating ${label} (${writer.name})...`);
    const text = callClaude(seg.prompt, writerKey) || (typeof seg.fallback === 'function' ? seg.fallback() : seg.fallback);
    sections.push({ title: seg.title, content: text, byline: writer.name });
  }

  generateSingle('chuck', matchupSeg, 'Matchup Recaps');
  generateSingle('chuck', potwSeg, 'Players of the Week');
  generateSingle('chuck', prSeg, 'Power Rankings');
  generateSingle('chuck', moversSeg, 'Movers and Shakers');
  generateBatch('chuck', txBatch, 'Transactions');
  generateSingle('insider', insiderSeg, 'The Insider Report');
  generateSingle('chuck', missesSeg, 'Waiver Misses');
  generateSingle('maddog', maddogSeg, "Mad Dog's Hot Takes");
  generateSingle('gerald', geraldSeg, "The Numbers Don't Lie");

  // Assemble article
  const weekLabel = `Week ${week}`;
  const dateRange = analysis.weekStart && analysis.weekEnd
    ? ` (${analysis.weekStart} — ${analysis.weekEnd})`
    : '';

  let article = `---\ntitle: "${weekLabel} Recap: ${analysis.leagueName}"\nweek: ${week}\ndate: ${new Date().toISOString().split('T')[0]}\n---\n\n`;
  article += `# ${weekLabel} Recap${dateRange}\n\n`;

  for (const section of sections) {
    article += `## ${section.title}\n\n<p class="byline">by ${section.byline}</p>\n\n${section.content}\n\n---\n\n`;
  }

  fs.writeFileSync(articlePath, article);
  console.log(`\nArticle saved → ${articlePath}`);

  return articlePath;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);

  // --list-segments: print available keys and exit
  if (args.includes('--list-segments')) {
    console.log('Available segment keys:\n');
    for (const entry of SEGMENT_REGISTRY) {
      const writerLabel = WRITERS[entry.writer].name;
      const groupLabel = entry.group ? `, ${entry.group} batch` : '';
      console.log(`  ${entry.key.padEnd(15)} ${entry.title.padEnd(28)} (${writerLabel}${groupLabel})`);
    }
    console.log('\nNote: Requesting any tx-batch segment regenerates the entire batch.');
    process.exit(0);
  }

  // Parse --week
  const weekIdx = args.indexOf('--week');
  let week = weekIdx !== -1 ? parseInt(args[weekIdx + 1]) : null;

  if (!week) {
    const snapshotsDir = path.join(__dirname, 'snapshots');
    const dirs = fs.readdirSync(snapshotsDir).filter(d => d.startsWith('week-')).sort().reverse();
    if (!dirs.length) { console.error('No snapshots found.'); process.exit(1); }
    week = parseInt(dirs[0].replace('week-', ''));
  }

  // Parse --only and --except
  const validKeys = new Set(SEGMENT_REGISTRY.map(s => s.key));
  let only = null;
  let except = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) {
      if (!only) only = [];
      only.push(...args[++i].split(','));
    } else if (args[i] === '--except' && args[i + 1]) {
      if (!except) except = [];
      except.push(...args[++i].split(','));
    }
  }

  if (only && except) {
    console.error('Cannot use --only and --except together.');
    process.exit(1);
  }

  for (const k of [...(only || []), ...(except || [])]) {
    if (!validKeys.has(k)) {
      console.error(`Unknown segment key: "${k}". Use --list-segments to see valid keys.`);
      process.exit(1);
    }
  }

  narrate(week, { only, except }).catch(err => {
    console.error('Narration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { narrate, SEGMENT_REGISTRY, parseArticleSections, matchSectionsToRegistry, spliceArticle };
