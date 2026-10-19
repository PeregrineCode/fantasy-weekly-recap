const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCounterOffers } = require('../lib/trades');

const move = (playerKey, name, sourceTeam, destTeam) =>
  ({ playerKey, name, team: 'FLA', position: 'C', type: 'trade', sourceType: 'team', sourceTeam, destType: 'team', destTeam });
const trade = (transactionId, timestamp, players) =>
  ({ transactionId, type: 'trade', status: 'successful', timestamp, players });

// Week 3 2026 hockey: Barkov to t.7 for Cooley, reversed 3 days later, then
// sent to t.5 for Tavares on the winning counter offer.
const original = trade('131', 1000, [move('p.cooley', 'Logan Cooley', 't.7', 't.12'), move('p.barkov', 'Aleksander Barkov', 't.12', 't.7')]);
const reversal = trade('166', 2000, [move('p.cooley', 'Logan Cooley', 't.12', 't.7'), move('p.barkov', 'Aleksander Barkov', 't.7', 't.12')]);
const counter = trade('167', 2300, [move('p.tavares', 'John Tavares', 't.5', 't.12'), move('p.barkov', 'Aleksander Barkov', 't.12', 't.5')]);
const add = { transactionId: '150', type: 'add', status: 'successful', timestamp: 1500, players: [{ playerKey: 'p.x', type: 'add', destTeam: 't.3' }] };

describe('resolveCounterOffers', () => {
  it('drops the overturned trade and its reversal, tags the winning counter', () => {
    const txs = [counter, reversal, add, original].map(t => ({ ...t }));
    const { transactions, overturned } = resolveCounterOffers(txs);
    assert.deepEqual(transactions.map(t => t.transactionId), ['167', '150']);
    assert.equal(overturned.length, 1);
    assert.equal(overturned[0].original.transactionId, '131');
    assert.equal(overturned[0].counter.transactionId, '167');
    assert.equal(overturned[0].originalInPriorWeek, false);
    assert.equal(transactions[0].counterOffer.original.transactionId, '131');
    assert.equal(transactions[0].counterOffer.reversedAt, 2000);
  });

  it('matches an original trade from the prior week', () => {
    const { transactions, overturned } = resolveCounterOffers([{ ...reversal }, { ...counter }], [{ ...original }]);
    assert.deepEqual(transactions.map(t => t.transactionId), ['167']);
    assert.equal(overturned[0].originalInPriorWeek, true);
  });

  it('records a reversal with no counter trade', () => {
    const { transactions, overturned } = resolveCounterOffers([{ ...original }, { ...reversal }]);
    assert.equal(transactions.length, 0);
    assert.equal(overturned[0].counter, null);
  });

  it('leaves ordinary trades alone', () => {
    const { transactions, overturned } = resolveCounterOffers([{ ...original }, { ...counter }, { ...add }]);
    assert.equal(transactions.length, 3);
    assert.equal(overturned.length, 0);
    assert.equal(transactions[1].counterOffer, undefined);
  });
});
