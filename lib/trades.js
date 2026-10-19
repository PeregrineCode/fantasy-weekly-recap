/**
 * Counter-offer trades.
 *
 * The hockey league gives other teams 48 hours after a trade to make a better
 * counter offer. Trades now sit pending through that window and only the
 * winner processes, but when the rule launched (week 3 2026, Barkov) the
 * original trade processed and the commissioner undid it with an exact
 * inverse trade before the counter went through. Yahoo has no "overturned"
 * status, so left alone every segment would treat all three as real moves.
 * Kept for that week and for any future commissioner reversal.
 */

function moveKeys(tx, inverse = false) {
  return tx.players
    .map(p => inverse
      ? `${p.playerKey}:${p.destTeam}>${p.sourceTeam}`
      : `${p.playerKey}:${p.sourceTeam}>${p.destTeam}`)
    .sort()
    .join('|');
}

/**
 * Pair each reversal trade with the trade it undoes, drop both, and tag the
 * counter trade that won the player(s) with the offer it beat.
 *
 * @param {Array} transactions - This week's transactions
 * @param {Array} priorTransactions - Last week's transactions, so an original
 *   trade made late in the prior week can still be matched
 * @returns {{ transactions: Array, overturned: Array }}
 */
function resolveCounterOffers(transactions, priorTransactions = []) {
  const isTrade = tx => tx.type === 'trade' && tx.players?.length > 0;
  const candidates = [...priorTransactions, ...transactions].filter(isTrade);
  const removed = new Set();
  const overturned = [];

  const trades = transactions.filter(isTrade).sort((a, b) => a.timestamp - b.timestamp);
  for (const reversal of trades) {
    if (removed.has(reversal)) continue;
    const inverse = moveKeys(reversal, true);
    const original = candidates
      .filter(tx => tx !== reversal && !removed.has(tx) && tx.timestamp < reversal.timestamp && moveKeys(tx) === inverse)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!original) continue;

    removed.add(reversal);
    removed.add(original);

    // The winning counter: the next trade that moves any of the contested
    // players out of the team that got them back.
    const contested = new Map(reversal.players.map(p => [p.playerKey, p.destTeam]));
    const counter = trades.find(tx =>
      tx.timestamp >= reversal.timestamp && !removed.has(tx) &&
      tx.players.some(p => contested.get(p.playerKey) === p.sourceTeam));

    const entry = {
      original,
      originalInPriorWeek: !transactions.includes(original),
      reversedAt: reversal.timestamp,
      counter: counter || null,
    };
    overturned.push(entry);
    if (counter) counter.counterOffer = { original, reversedAt: reversal.timestamp };
  }

  return { transactions: transactions.filter(tx => !removed.has(tx)), overturned };
}

module.exports = { resolveCounterOffers };
