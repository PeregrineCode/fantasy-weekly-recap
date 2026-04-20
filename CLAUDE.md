# Fantasy Weekly Recap

Automated weekly fantasy baseball recap site for Dad's Baseball League 9.0. Dennis's league — 10 teams, H2H Categories, Auction draft, FAAB waivers.

## League

| League | Sport | Key | Teams | Format |
|--------|-------|-----|-------|--------|
| Dad's Baseball League 9.0 | MLB | 469.l.75479 | 10 | H2H Categories, Auction, FAAB ($200) |

**Scoring Categories (12 total):**
- Batting (6): R, HR, RBI, SB, AVG, OBP
- Pitching (6): K, ERA, WHIP, K/BB, QS, SV+H

**League mechanics:** Pure redraft. No salary cap, no contracts, no keepers in-season. FAAB waivers ($200 starting budget). 30 IP minimum per matchup week — teams below forfeit all pitching categories. Trade deadline is 2026-08-06.

## Repository Structure
```
fantasy-weekly-recap/
├── lib/
│   ├── stat-categories.js    # Yahoo stat ID mappings + category definitions
│   └── yahoo-fetch.js        # Yahoo API roster/standings fetch helpers
├── prompts/
│   ├── system.txt            # Core role instruction for claude CLI
│   └── reference.md          # Style guide + league context (edit to improve quality)
├── rumours-worker/           # Cloudflare Worker for trade rumour submissions
│   ├── worker.js             # POST/GET API (~110 lines)
│   ├── wrangler.toml         # Worker config with KV namespace binding
│   └── package.json          # wrangler dev dependency
├── templates/
│   ├── layout.html           # Page template ({{LEAGUE_NAME}} etc.)
│   └── style.css             # Newspaper-style CSS (includes rumour form styles)
├── test/                     # Node.js test suite
├── .github/workflows/        # Daily collection GitHub Actions
├── snapshots/                # Collected data (gitignored, accumulates via Actions)
├── articles/                 # Generated markdown (gitignored)
├── site/                     # Built HTML (gitignored)
├── .env                      # Credentials (gitignored)
└── data/faab-bids.json       # Manual losing FAAB bids (gitignored, optional)
```

## Pipeline
```
daily-positions.js + daily-collect.js  (two-phase daily capture, see below)
collect.js → analyze.js → narrate.js → build.js → deploy.js
(Yahoo API)   (segments)   (claude CLI)  (HTML)     (GitHub Pages)
```

## Daily Data Collection (Two-Phase)
Daily snapshots use a two-phase capture to get both accurate roster positions and finalized stats:

1. **11 PM ET** — `daily-positions.js` via `nightly-positions.yml`: Captures roster positions for **today**. All lineups are locked by this time, so positions reflect the actual game-day lineup. Saves `positions-YYYY-MM-DD.json`.

2. **7 AM ET next morning** — `daily-collect.js` via `daily-collect.yml`: Collects finalized stats for **yesterday** (all games end by ~2 AM). Merges positions from the nightly file into the final `YYYY-MM-DD.json` snapshot. Snapshots include a `positionsSource` field (`"nightly"` or `"api"`) indicating whether accurate positions were available.

**Why two phases:** Yahoo's API always returns **current** roster positions regardless of what date you request stats for. A single morning collection would capture next-day positions (after managers rearrange for the new day), not the game-day lineup. The nightly capture at lineup lock solves this.

**Bench blunder detection** in `analyze.js` only trusts positions from snapshots with `positionsSource: "nightly"`. Days without nightly position data are excluded from bench analysis to avoid false positives.

## Usage
```bash
node run.js                     # Full pipeline for last completed week
node run.js --week 3            # Specific week
node run.js --skip-narrate      # Data pipeline only (no LLM)
node run.js --skip-deploy       # Build locally, don't push

# Individual steps
node daily-positions.js         # Capture today's roster positions (run nightly at 11 PM ET)
node daily-collect.js           # Snapshot yesterday's stats + merge positions (run 7 AM ET)
node collect.js [--week N]      # Fetch Yahoo data → snapshots/
node analyze.js [--week N]      # Compute segments → analysis.json
node narrate.js [--week N]      # Generate prose → articles/
node build.js                   # Build HTML → site/
node deploy.js                  # Push to GitHub Pages repo
```

## Important
- **NEVER run narrate.js, run.js, or deploy.js without explicit permission from Dennis.** Wait for Dennis to ask before generating or deploying content. When testing code changes, use `--skip-narrate --skip-deploy` to validate the data pipeline without producing or publishing articles.
- **NEVER edit article markdown files directly unless Dennis specifically asks.** Dennis reviews and edits articles himself. Code fixes should go in analyze.js/narrate.js/reference.md so they apply to future generations.

## Yahoo API Notes
- Base URL: `https://fantasysports.yahooapis.com/fantasy/v2`
- Game codes: `mlb` (key 469, 2026), `nhl` (key 465, 2025)
- Rate limit: 2s minimum between calls, handles 999 with 5s retry
- Token auto-refreshes 5 minutes before expiry
- All endpoints work identically across sports — only the game key differs
- **Settings endpoint quirk:** `/league/{key}/settings` returns a STALE predraft snapshot frozen at draft time — `is_auction_draft`, `uses_faab`, `draft_status`, `current_week`, etc. all come back wrong (predraft defaults). The fix is the subresource syntax `/league/{key};out=settings`, which returns fresh post-draft values. `client.getLeagueSettings()` already uses the correct form — do not switch it back.
- **Weekly stats quirk:** The `;out=stats;type=week;week=N` parameter syntax returns daily or season stats instead of weekly. The fix is the subresource syntax `/players/stats;type=week;week=N` (slash before `stats`). This works on the team roster endpoint but **not** on the league-level batch player endpoint (`/league/.../players;player_keys=...`), which always returns season stats regardless of syntax.
- **Positions are always current:** `selected_position` in API responses always reflects the **current** roster position at the time of the API call, never historical. Requesting stats for a past date/week still returns today's positions. This is why daily data collection uses two phases.
- **Stats index varies:** Yahoo sometimes inserts extra fields (like `is_editable`) before the `player_stats` object in roster responses, shifting its index. Always search for `player_stats` at any index rather than hardcoding `p[2]`.

## Segments
Matchup Recaps (includes mid-week drama/storylines when daily data available), Players of the Week (1 winner + 3 runners-up for batters and pitchers), Best Pickup, Worst Pickup (Hall of Shame), Best Pitcher Stream, Transaction Desk, Standings Movers, Waiver Wire Misses, Power Rankings, Bench Blunders (requires nightly position data), The Insider Report (trade rumours from league members, requires `RUMOURS_API_URL`)

## Prompts
- `prompts/system.txt` — Core role instruction for claude CLI
- `prompts/reference.md` — Style guide + league context (edit to improve narrative quality)

## Environment Variables (.env)
```
YAHOO_CLIENT_ID          # OAuth client ID
YAHOO_CLIENT_SECRET      # OAuth client secret
YAHOO_REDIRECT_URI       # Must be https://localhost:3000/auth/callback
YAHOO_MLB_LEAGUE_ID      # 75479
DEPLOY_REPO              # GitHub Pages target (e.g., PeregrineCode/dads-league-recap)
RUMOURS_API_URL          # Optional: Cloudflare Worker URL for trade rumours
LEAGUE_NAME              # Optional: override auto-detected league name
FAAB_BUDGET              # Optional: starting FAAB budget (default: 200)
MIN_IP                   # Optional: minimum innings pitched per week (default: 30)
```

## Trade Rumours
League members submit trade rumours and team gossip via a form on the recap site. These feed "The Insider Report" column, written by "Deep Source" DiNapoli.

**Architecture:** Static form on GitHub Pages → Cloudflare Worker + KV → pipeline fetches via GET during narration.

**Worker:** `rumours-worker/` — Cloudflare Worker with KV storage. Deployed at `https://trade-rumours.dads-league.workers.dev`. The Cloudflare account is under the pucksavant domain. Requires `CLOUDFLARE_API_TOKEN` env var for deploys (set in `~/.zshenv`).
- `POST /api/rumours` — accepts `{ text, source? }`, stores in KV with 90-day TTL, rate-limited to 1 per IP per 12 hours
- `GET /api/rumours?since=YYYY-MM-DD` — returns rumours since the given date
- KV uses metadata for fast `list()` reads (no per-key fetches), with value fallback for legacy entries
- Deploy: `cd rumours-worker && npm install && npx wrangler deploy`
- Manage KV: entries visible at https://dash.cloudflare.com → Workers & Pages → KV

**Pipeline integration:** `narrate.js` fetches rumours from `RUMOURS_API_URL` at narration time. If no rumours exist or the URL is not configured, the insider segment is silently skipped. The segment key is `insider` — use `--only insider` to regenerate just this column.

**Submit page:** `build.js` generates `site/submit.html` and adds a nav link when `RUMOURS_API_URL` is set. Without the env var, the submit page and nav link are omitted.

**Writers:** The insider persona ("Deep Source" DiNapoli) is defined in `prompts/reference.md`. He writes with the urgency of an ESPN insider covering a 10-team friends league like it's the MLB Winter Meetings.

## Related Repos
- **yahoo-fantasy-api** — npm package this repo depends on: https://github.com/PeregrineCode/yahoo-fantasy-api
- **fantasy-tools** — Private monorepo with in-season analysis tools (trade advisor, waiver scanner, draft tool)
- **dads-league-recap** — GitHub Pages deploy target: https://github.com/PeregrineCode/dads-league-recap
