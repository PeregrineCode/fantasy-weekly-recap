const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Minimal in-memory stand-in for a Cloudflare KV namespace
function fakeKV(seed = []) {
  const store = new Map(seed.map(e => [e.name, e]));
  return {
    async get(name) { return store.get(name)?.value ?? null; },
    async put(name, value, opts = {}) { store.set(name, { name, value, metadata: opts.metadata }); },
    async list({ prefix }) {
      const keys = [...store.values()].filter(e => e.name.startsWith(prefix)).map(e => ({ name: e.name, metadata: e.metadata }));
      return { keys, list_complete: true };
    },
  };
}

let worker;
before(async () => {
  worker = (await import(path.join(__dirname, '..', 'rumours-worker', 'worker.js'))).default;
});

const post = (env, body, ip = '1.2.3.4') => worker.fetch(new Request('https://w/api/rumours', {
  method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip },
}), env);
const list = async (env, qs = '') => (await (await worker.fetch(new Request(`https://w/api/rumours${qs}`), env)).json()).rumours;

describe('rumours worker league tagging', () => {
  it('tags submissions with their league, defaulting to baseball', async () => {
    const env = { RUMOURS: fakeKV() };
    assert.equal((await post(env, { text: 'hockey tip', league: 'hockey' })).status, 201);
    assert.equal((await post(env, { text: 'baseball tip' }, '5.6.7.8')).status, 201);
    assert.deepEqual((await list(env, '?league=hockey')).map(r => r.text), ['hockey tip']);
    assert.deepEqual((await list(env, '?league=baseball')).map(r => r.text), ['baseball tip']);
  });

  it('treats untagged legacy rumours as baseball and returns everything without a filter', async () => {
    const legacy = { name: 'rumour:2026-05-01T00:00:00Z:x', value: '', metadata: { text: 'old', source: null, submittedAt: '2026-05-01T00:00:00.000Z' } };
    const env = { RUMOURS: fakeKV([legacy]) };
    await post(env, { text: 'new hockey', league: 'hockey' });
    assert.deepEqual((await list(env, '?league=baseball')).map(r => r.text), ['old']);
    assert.equal((await list(env)).length, 2);
  });

  it('rate-limits per league, so a manager in both leagues can tip each', async () => {
    const env = { RUMOURS: fakeKV() };
    assert.equal((await post(env, { text: 'a', league: 'baseball' })).status, 201);
    assert.equal((await post(env, { text: 'b', league: 'hockey' })).status, 201);
    assert.equal((await post(env, { text: 'c', league: 'hockey' })).status, 429);
  });

  it('rejects unknown leagues', async () => {
    const env = { RUMOURS: fakeKV() };
    assert.equal((await post(env, { text: 'x', league: 'curling' })).status, 400);
    assert.equal((await worker.fetch(new Request('https://w/api/rumours?league=curling'), env)).status, 400);
  });
});

describe('rumours worker cron dispatch', () => {
  const runCron = async (cron, env) => {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return new Response(null, { status: 204 }); };
    const pending = [];
    try {
      await worker.scheduled({ cron }, env, { waitUntil: p => pending.push(p) });
      await Promise.all(pending);
    } finally {
      global.fetch = realFetch;
    }
    return calls;
  };
  const env = { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/repo' };

  it('dispatches the nightly capture for its cron', async () => {
    const calls = await runCron('7 4 * * *', env);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/me/repo/actions/workflows/hockey-nightly-positions.yml/dispatches');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { ref: 'master' });
  });

  it('dispatches the daily collect for its cron', async () => {
    const calls = await runCron('23 11 * * *', env);
    assert.match(calls[0].url, /hockey-daily-collect\.yml\/dispatches$/);
  });

  it('does nothing without a token', async () => {
    assert.equal((await runCron('7 4 * * *', { GITHUB_REPO: 'me/repo' })).length, 0);
  });

  it('every cron in wrangler.toml has workflows mapped', async () => {
    const toml = require('fs').readFileSync(path.join(__dirname, '..', 'rumours-worker', 'wrangler.toml'), 'utf-8');
    const crons = JSON.parse(toml.match(/crons = (\[.*\])/)[1]);
    for (const cron of crons) {
      assert.ok((await runCron(cron, env)).length > 0, `cron "${cron}" dispatches nothing`);
    }
  });
});
