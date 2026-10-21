/**
 * Matchup scoring formats. A sport profile picks one as its `scoring`.
 *
 * Categories (H2H Categories): a matchup score is categories won, e.g. 6-3-0.
 * Points (H2H Points): a matchup score is fantasy points, e.g. 222.8-198.4.
 *
 * Scoreboard matchups keep the field names team1Wins / team2Wins / ties in
 * both formats (snapshots on disk already use them). In a points league they
 * hold each team's fantasy points and ties is always 0.
 */

// Round to hundredths first so float noise (640.65 → 640.6499…) can't flip
// the tenths digit: 640.65 → 640.7
const fmtPoints = v => (Math.round(Math.round(v * 100) / 10) / 10).toFixed(1);

function categoryScoring({ blowoutWins }) {
  return {
    type: 'categories',
    unit: 'category',
    units: 'categories',
    formatScore: (a, b, ties) => `${a}-${b}-${ties}`,
    isBlowout: (winner, loser) => winner >= blowoutWins,
    // Storyline thresholds, in categories
    comebackDeficit: 2,
    finalDaySwing: 3,
    dramaUnit: 1,
    // Player value (z-score sum) that counts as a strong week
    strongWeek: 2,
    // Share of the week's categories won, for power rankings
    weeklyForm: (own, opp, ties) => own / Math.max(1, own + opp),
  };
}

/**
 * @param {Object} opts
 * @param {Object} opts.modifiers - Stat name → fantasy points per unit
 * @param {number} opts.blowoutMargin - Point margin that counts as a blowout
 */
function pointsScoring({ modifiers, blowoutMargin }) {
  const fantasyPoints = stats => {
    let total = 0;
    for (const [stat, mult] of Object.entries(modifiers)) {
      const v = stats[stat];
      if (typeof v === 'number' && !isNaN(v)) total += v * mult;
    }
    return Math.round(total * 100) / 100;
  };
  return {
    type: 'points',
    unit: 'point',
    units: 'points',
    modifiers,
    fantasyPoints,
    formatScore: (a, b) => `${fmtPoints(a)}-${fmtPoints(b)}`,
    isBlowout: (winner, loser) => winner - loser >= blowoutMargin,
    comebackDeficit: Math.round(blowoutMargin / 3),
    finalDaySwing: Math.round(blowoutMargin / 2),
    dramaUnit: Math.round(blowoutMargin / 6),
    // Fantasy points that count as a strong week for one player
    strongWeek: Math.round(blowoutMargin / 3),
    // Points scored this week relative to the opponent, squashed into 0..1
    weeklyForm: (own, opp) => (own + opp > 0 ? own / (own + opp) : 0.5),
  };
}

module.exports = { categoryScoring, pointsScoring, fmtPoints };
