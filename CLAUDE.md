# Fantasy Weekly Recap

Automated weekly fantasy recap sites for Dennis's leagues: Dad's Baseball League 9.0 and Dad's Hockey League 10.0. Every script serves one league per run, chosen with `--league <id>` (or `LEAGUE=<id>`); the default is `baseball`.

## Leagues

| League | `--league` | Sport | Key | Teams | Format |
|--------|-----------|-------|-----|-------|--------|
| Dad's Baseball League 9.0 | `baseball` (default) | MLB | 469.l.75479 | 10 | H2H Categories, Auction, FAAB ($200) |
| Dad's Hockey League 10.0 | `hockey` | NHL | 477.l.48642 | 14 | H2H Categories, Auction, FAAB ($100) |

## Multiple Leagues
- **Registry:** `lib/league.js` defines each league (game code, Yahoo league ID, paths, env prefix, abandoned teams). `activeLeague()` resolves the league from `--league`/`LEAGUE` once per process.
- **Sport profiles:** `lib/sports/baseball.js` and `lib/sports/hockey.js` hold everything sport-specific: stat IDs and categories, player groups (batter/pitcher, skater/goalie), stream rules, bench-blunder thresholds, dead-weight rules, the pro schedule API (MLB Stats API / NHL `api-web.nhle.com`), and prompt wording. `analyze.js` and `narrate.js` stay sport-neutral; put new sport logic in the profile, not behind `if (sport === ...)` checks.
- **Stat IDs collide across sports** (26 is ERA in MLB, SV% in NHL), so `STAT_ID_MAP` in `lib/stat-categories.js` is built from the active league's profile.
- **Paths:** baseball predates multi-league support and keeps its data at the repo root (`snapshots/`, `articles/`, `site/`, `.deploy/`, `prompts/`). Other leagues live under `leagues/<id>/` with the same layout (`leagues/hockey/prompts/` is committed; snapshots/articles/site are gitignored).
- **Env vars:** baseball uses the unprefixed names; other leagues prefix league-scoped settings (`HOCKEY_DEPLOY_REPO`, `HOCKEY_LEAGUE_NAME`, `HOCKEY_FAAB_BUDGET`). `RUMOURS_API_URL` and the Yahoo credentials are shared.
- **Writers:** each league's `prompts/writers.json` defines its four personas by role (`lead`, `hottakes`, `analytics`, `insider`) plus column-title overrides. Segment keys (`maddog`, `numbers`, etc.) are the same in every league even when the column is renamed.
- **Abandoned teams are per league:** baseball t.7 (Nate) is excluded from editorial segments; hockey t.7 is Dennis's team and is NOT.

## Hockey League
**Scoring Categories (9 total):** Skaters (6): G, A, P, SOG, HIT, BLK. Goalies (3): W, GAA, SV%. GA, SV, and SA are display-only.

**League mechanics:** Rosters are 2C/2LW/2RW/4D/1Util/2G with 4 BN, 1 IR and 2 IR+. Lineups are set daily and lock at puck drop. FAAB is $100 with a maximum of 4 adds per week (free agents not on waivers cost $0, so most adds carry no bid). Trade deadline 2027-03-03. Playoffs: 8 teams; QF week 24, SF week 25, final week 26, with reseeding. Season runs 2026-09-29 to 2027-04-04. Dennis won 2025 (Hockey 9.0, as Mr. Roboto).

**Hockey segment variants:** Players of the Week crowns a skater and a goalie (goalies need ~20 shots against to qualify). The stream segment is "Goalie Stream of the Week". Dead weight flags skaters with zero points despite shots, and goalies under .870. There is no innings-style minimum and no IR-hoarding roast (the league allows 3 IR slots).

## Baseball League

**Scoring Categories (12 total):**
- Batting (6): R, HR, RBI, SB, AVG, OBP
- Pitching (6): K, ERA, WHIP, K/BB, QS, SV+H

**League mechanics:** Pure redraft. No salary cap, no contracts, no keepers in-season. FAAB waivers ($200 starting budget). 30 IP minimum per matchup week — teams below forfeit all pitching categories. Trade deadline is 2026-08-06.

## Repository Structure
```
fantasy-weekly-recap/
├── lib/
│   ├── league.js             # League registry + active-league resolution (--league)
│   ├── sports/               # Sport profiles: baseball.js, hockey.js
│   ├── stat-categories.js    # Stat ID map for the active league
│   ├── et.js                 # DST-aware Eastern-time helpers
│   └── yahoo-fetch.js        # Yahoo API roster/standings fetch helpers
├── prompts/                  # Baseball prompts
│   ├── system.txt            # Core role instruction for claude CLI
│   ├── reference.md          # Style guide + league context (edit to improve quality)
│   └── writers.json          # Writer personas + column-title overrides
├── leagues/hockey/           # Hockey: prompts/ (committed) + snapshots/articles/site (gitignored)
├── rumours-worker/           # Cloudflare Worker for trade rumour submissions
│   ├── worker.js             # POST/GET API (~110 lines)
│   ├── wrangler.toml         # Worker config with KV namespace binding
│   └── package.json          # wrangler dev dependency
├── templates/
│   ├── layout.html           # Page template ({{LEAGUE_NAME}} etc.)
│   └── style.css             # Newspaper-style CSS (includes rumour form styles)
├── test/                     # Node.js test suite
├── .github/workflows/        # Daily collection GitHub Actions (baseball + hockey-*)
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

1. **10:30 PM ET** — `daily-positions.js` via `nightly-positions.yml`: Captures roster positions for **today**. The latest West Coast game starts before this, so all lineups are locked and positions reflect the actual game-day lineup. Saves `positions-YYYY-MM-DD.json`. GitHub delays scheduled runs by hours (5h+ seen in Sept 2026), and a run that slips past Yahoo's ~3 AM ET fantasy-day rollover would capture the next day's unset roster, so the workflow fires four times inside the locked window (10:30 PM, 11:17 PM, 12:43 AM, 1:51 AM ET). The script keeps the first trusted capture and refuses to write a post-rollover one (`shouldSkipCapture` in `lib/nightly-trust.js`), so extra firings cost one API call and produce no commit.

2. **7 AM ET next morning** — `daily-collect.js` via `daily-collect.yml`: Collects finalized stats for **yesterday** (all games end by ~2 AM). Merges positions from the nightly file into the final `YYYY-MM-DD.json` snapshot. Snapshots include a `positionsSource` field (`"nightly"` or `"api"`) indicating whether accurate positions were available.

**Why two phases:** Yahoo's API always returns **current** roster positions regardless of what date you request stats for. A single morning collection would capture next-day positions (after managers rearrange for the new day), not the game-day lineup. The nightly capture at lineup lock solves this.

**Bench blunder detection** in `analyze.js` only trusts positions from snapshots with `positionsSource: "nightly"`. Days without nightly position data are excluded from bench analysis to avoid false positives, and a week with no daily snapshots gets no bench blunders at all (weekly roster positions are the *current* lineup).

**Hockey** runs the same two phases via `hockey-nightly-positions.yml` (four firings between 11:07 PM and 2:31 AM ET, chosen to land inside the locked window under both EDT and EST) and `hockey-daily-collect.yml` (~7 AM ET). The baseball workflows are disabled in the offseason; re-enable them in the GitHub UI when the MLB season starts.

## Usage
```bash
node run.js                     # Full pipeline for last completed week
node run.js --week 3            # Specific week
node run.js --skip-narrate      # Data pipeline only (no LLM)
node run.js --skip-deploy       # Build locally, don't push

# Individual steps
node daily-positions.js         # Capture today's roster positions (run nightly at 10:30 PM ET)
node daily-collect.js           # Snapshot yesterday's stats + merge positions (run 7 AM ET)
node collect.js [--week N]      # Fetch Yahoo data → snapshots/
node analyze.js [--week N]      # Compute segments → analysis.json
node narrate.js [--week N]      # Generate prose → articles/
node build.js                   # Build HTML → site/
node deploy.js                  # Push to GitHub Pages repo

# Every script takes --league hockey (default: baseball)
node run.js --league hockey --week 2 --skip-narrate --skip-deploy
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

## Playoffs and Finals
Yahoo flags playoff matchups (`is_playoffs`, `is_consolation`) but never says which game is the championship. `collect.js` infers bracket rounds from the previous week's playoff results (`labelPlayoffRounds` in `yahoo-helpers.js`): a team that lost a playoff matchup last week is in the losers' bracket. Each matchup in `scoreboard.json` gets a `round` (Championship, Third Place, Semifinal, Quarterfinal, Consolation, or null), and `meta.json` gets `isPlayoffs` / `isFinals` (finals = the league's `end_week`).

**Finals mode** (automatic when `meta.isFinals`): `analyze.js` covers only the Championship and Third Place games and narrows rosters, transactions, and daily snapshots to the four finalists, so every segment stays on the title games. Standings Movers and Power Rankings are skipped (standings are frozen in the playoffs). `narrate.js` titles the article "Finals Recap", tags each matchup `[CHAMPIONSHIP]` / `[THIRD-PLACE GAME]`, leads with the champion, and switches Mad Dog and The Numbers Don't Lie to finals variants that need no standings. The article frontmatter carries `label: "Finals"`, which `build.js` uses for the nav link instead of "Wk N". The full set of round labels (including consolation results) is preserved in `analysis.playoffs.rounds` if a narrator ever needs them.

## Segments
Matchup Recaps (includes mid-week drama/storylines when daily data available), Players of the Week (1 winner + 3 runners-up for batters and pitchers), Best Pickup, Worst Pickup (Hall of Shame), Best Pitcher Stream, Transaction Desk, Standings Movers, Power Rankings, Bench Blunders (requires nightly position data), The Insider Report (trade rumours from league members, requires `RUMOURS_API_URL`)

## Prompts
Per league (`prompts/` for baseball, `leagues/hockey/prompts/` for hockey):
- `system.txt` — Core role instruction for claude CLI
- `reference.md` — Style guide + league context (edit to improve narrative quality)
- `writers.json` — Writer personas by role + column-title overrides

Hockey writers: Murray "Muzz" Kowalchuk (lead), Ronnie "Red Light" Russo (hot takes), Dr. Ingrid Lindqvist (analytics), Gary "The Wire" Halloran (insider, "The Trade Board").

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

# Hockey (league-scoped settings use the HOCKEY_ prefix)
YAHOO_NHL_LEAGUE_ID      # Optional: defaults to 48642
HOCKEY_DEPLOY_REPO       # GitHub Pages target for the hockey site
HOCKEY_LEAGUE_NAME       # Optional
HOCKEY_FAAB_BUDGET       # Optional (default: 100)
```

## Trade Rumours
League members submit trade rumours and team gossip via a form on the recap site. These feed "The Insider Report" column, written by "Deep Source" DiNapoli.

**Architecture:** Static form on GitHub Pages → Cloudflare Worker + KV → pipeline fetches via GET during narration.

**Worker:** `rumours-worker/` — Cloudflare Worker with KV storage. Deployed at `https://trade-rumours.dads-league.workers.dev`. The Cloudflare account is under the pucksavant domain. Requires `CLOUDFLARE_API_TOKEN` env var for deploys (set in `~/.zshenv`).
- `POST /api/rumours` — accepts `{ text, source?, league? }`, stores in KV with 90-day TTL, rate-limited to 1 per IP per league per 12 hours
- `GET /api/rumours?since=YYYY-MM-DD&league=hockey` — returns rumours since the given date for one league (no `league` = all leagues)
- One worker serves both sites. Each rumour is tagged with its league (`baseball` or `hockey`); entries from before tagging have no league and count as baseball. The submit page and `narrate.js` pass the active league
- KV uses metadata for fast `list()` reads (no per-key fetches), with value fallback for legacy entries
- Deploy: `cd rumours-worker && npm install && npx wrangler deploy`
- Manage KV: entries visible at https://dash.cloudflare.com → Workers & Pages → KV

**Pipeline integration:** `narrate.js` fetches rumours from `RUMOURS_API_URL` at narration time. If no rumours exist or the URL is not configured, the insider segment is silently skipped. The segment key is `insider` — use `--only insider` to regenerate just this column. Each week records the rumours it consumed to `snapshots/week-N/rumours-used.json`; future narrations exclude any submittedAt timestamps already claimed, so a rumour submitted in the early hours of Monday ET can't get double-counted across two weeks.

**Submit page:** `build.js` generates `site/submit.html` and adds a nav link when `RUMOURS_API_URL` is set. Without the env var, the submit page and nav link are omitted.

**Writers:** The insider persona ("Deep Source" DiNapoli) is defined in `prompts/reference.md`. He writes with the urgency of an ESPN insider covering a 10-team friends league like it's the MLB Winter Meetings.

## Related Repos
- **yahoo-fantasy-api** — npm package this repo depends on: https://github.com/PeregrineCode/yahoo-fantasy-api
- **fantasy-tools** — Private monorepo with in-season analysis tools (trade advisor, waiver scanner, draft tool)
- **dads-league-recap** — GitHub Pages deploy target: https://github.com/PeregrineCode/dads-league-recap
