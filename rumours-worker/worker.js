/**
 * Cloudflare Worker — Trade Rumours API
 *
 * Receives rumour submissions from the recap site form and serves them
 * to the narration pipeline. Backed by Cloudflare KV.
 *
 * KV key prefixes:
 *   rumour:*     — rumour data (stored in metadata for fast listing)
 *   ratelimit:*  — ephemeral per-IP rate limit markers (60s TTL)
 *
 * Routes:
 *   POST /api/rumours    — submit a rumour { text, source? }
 *   GET  /api/rumours    — list rumours, optional ?since=YYYY-MM-DD filter
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rumours auto-expire after 90 days — old tips have no narration value
const RUMOUR_TTL_DAYS = 90;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
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
      // Rate limit: 1 submission per 12 hours per IP
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateKey = `ratelimit:${ip}`;
      const existing = await env.RUMOURS.get(rateKey);
      if (existing) {
        return json({ error: "You've already submitted your rumour for today." }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const text = (body.text || '').trim();
      if (!text) return json({ error: 'Rumour text is required' }, 400);
      if (text.length > 1000) return json({ error: 'Rumour must be 1000 characters or fewer' }, 400);

      const source = (body.source || '').trim().slice(0, 50) || null;
      const submittedAt = new Date().toISOString();
      const key = `rumour:${submittedAt}:${crypto.randomUUID()}`;

      const rumour = { text, source, submittedAt };

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
            if (new Date(key.metadata.submittedAt) >= sinceDate) {
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
            if (rumour.submittedAt && new Date(rumour.submittedAt) >= sinceDate) {
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
