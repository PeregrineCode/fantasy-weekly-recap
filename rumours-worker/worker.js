/**
 * Cloudflare Worker — Trade Rumours API
 *
 * Receives rumour submissions from the recap site form and serves them
 * to the narration pipeline. Backed by Cloudflare KV.
 *
 * KV key prefixes:
 *   rumour:*     — rumour data (stored in metadata for fast listing)
 *   ratelimit:*  — ephemeral per-league, per-IP rate limit markers (12h TTL)
 *
 * Routes:
 *   POST /api/rumours    — submit a rumour { text, source?, league? }
 *   GET  /api/rumours    — list rumours, optional ?since=YYYY-MM-DD and ?league= filters
 *
 * One worker serves every league's site. Rumours are tagged with their league;
 * entries from before league tagging have none and belong to baseball.
 *
 * Cron triggers (wrangler.toml) also start the recap repo's data-collection
 * workflows via workflow_dispatch. GitHub's own `schedule` runs have arrived
 * 7+ hours late, which misses the overnight lineup-capture window; dispatched
 * runs start right away. Needs the GITHUB_DISPATCH_TOKEN secret (fine-grained
 * PAT, Actions: read and write on the recap repo) and the GITHUB_REPO var.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rumours auto-expire after 90 days — old tips have no narration value
const RUMOUR_TTL_DAYS = 90;

const LEAGUES = ['baseball', 'hockey'];
const DEFAULT_LEAGUE = 'baseball';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Cron expression (UTC, must match wrangler.toml) → workflow files to dispatch
const CRON_DISPATCHES = {
  '7 4 * * *': ['hockey-nightly-positions.yml'],   // 12:07am EDT / 11:07pm EST
  '43 5 * * *': ['hockey-nightly-positions.yml'],  // 1:43am EDT / 12:43am EST (retry; script skips if already captured)
  '23 11 * * *': ['hockey-daily-collect.yml'],     // 7:23am EDT / 6:23am EST
};

async function dispatchWorkflow(env, workflow) {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPO) {
    console.error(`Cannot dispatch ${workflow}: GITHUB_DISPATCH_TOKEN or GITHUB_REPO is not set`);
    return false;
  }
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trade-rumours-worker',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'master' }),
  });
  if (res.status !== 204) {
    console.error(`Dispatch of ${workflow} failed: ${res.status} ${await res.text()}`);
    return false;
  }
  console.log(`Dispatched ${workflow}`);
  return true;
}

export default {
  async scheduled(event, env, ctx) {
    const workflows = CRON_DISPATCHES[event.cron] || [];
    if (!workflows.length) console.error(`No workflows mapped to cron "${event.cron}"`);
    ctx.waitUntil(Promise.all(workflows.map(wf => dispatchWorkflow(env, wf))));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname !== '/api/rumours') {
      return json({ error: 'Not found' }, 404);
    }

    // --- POST: submit a rumour ---
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const league = body.league || DEFAULT_LEAGUE;
      if (!LEAGUES.includes(league)) return json({ error: 'Unknown league' }, 400);

      // Rate limit: 1 submission per 12 hours per IP, per league (some
      // managers play in more than one league)
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateKey = league === DEFAULT_LEAGUE ? `ratelimit:${ip}` : `ratelimit:${league}:${ip}`;
      const existing = await env.RUMOURS.get(rateKey);
      if (existing) {
        return json({ error: "You've already submitted your rumour for today." }, 429);
      }

      const text = (body.text || '').trim();
      if (!text) return json({ error: 'Rumour text is required' }, 400);
      if (text.length > 1000) return json({ error: 'Rumour must be 1000 characters or fewer' }, 400);

      const source = (body.source || '').trim().slice(0, 50) || null;
      const submittedAt = new Date().toISOString();
      const key = `rumour:${submittedAt}:${crypto.randomUUID()}`;

      const rumour = { text, source, submittedAt, league };

      // Store rumour data in KV metadata so GET can read it from list()
      // without issuing individual get() calls per key
      await env.RUMOURS.put(key, '', {
        metadata: rumour,
        expirationTtl: RUMOUR_TTL_DAYS * 24 * 60 * 60,
      });

      // Set rate limit marker (12 hour TTL)
      await env.RUMOURS.put(rateKey, '1', { expirationTtl: 12 * 60 * 60 });

      return json({ ok: true, rumour }, 201);
    }

    // --- GET: list rumours ---
    if (request.method === 'GET') {
      const since = url.searchParams.get('since') || '1970-01-01';
      const sinceDate = new Date(since + 'T00:00:00Z');

      if (isNaN(sinceDate.getTime())) {
        return json({ error: 'Invalid since date, expected YYYY-MM-DD' }, 400);
      }

      // Without ?league=, return every league's rumours (pre-tagging behavior)
      const leagueFilter = url.searchParams.get('league');
      if (leagueFilter && !LEAGUES.includes(leagueFilter)) return json({ error: 'Unknown league' }, 400);
      const inLeague = r => !leagueFilter || (r.league || DEFAULT_LEAGUE) === leagueFilter;

      const rumours = [];
      let cursor = null;

      // Read rumours from KV. Prefer metadata (fast, no extra reads),
      // fall back to value for entries written before the metadata migration.
      do {
        const list = await env.RUMOURS.list({ prefix: 'rumour:', cursor });
        const valueFetches = [];

        for (const key of list.keys) {
          if (key.metadata && key.metadata.submittedAt) {
            // New format: data in metadata
            if (new Date(key.metadata.submittedAt) >= sinceDate && inLeague(key.metadata)) {
              rumours.push(key.metadata);
            }
          } else {
            // Old format: data in value — need individual get()
            valueFetches.push(env.RUMOURS.get(key.name));
          }
        }

        // Fetch old-format entries in parallel
        const values = await Promise.all(valueFetches);
        for (const val of values) {
          if (!val) continue;
          try {
            const rumour = JSON.parse(val);
            if (rumour.submittedAt && new Date(rumour.submittedAt) >= sinceDate && inLeague(rumour)) {
              rumours.push(rumour);
            }
          } catch { /* skip malformed entries */ }
        }

        cursor = list.list_complete ? null : list.cursor;
      } while (cursor);

      rumours.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
      return json({ rumours });
    }

    return json({ error: 'Method not allowed' }, 405);
  },
};
