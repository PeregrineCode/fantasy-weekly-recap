# Fantasy Weekly Recap

Automated weekly recap site for Yahoo Fantasy Baseball leagues. Generates opinionated, sports-anchor-style articles with AI narration, mid-week storyline tracking, and a newspaper-themed static site.

## What It Does

Every week during the fantasy season, this pipeline:

1. **Collects** matchup results, standings, transactions, and player stats from Yahoo Fantasy
2. **Analyzes** the data into segments: matchup recaps, players of the week, power rankings, trade desk, bench blunders, and more
3. **Narrates** each segment using Claude AI with configurable writer personas
4. **Builds** a static newspaper-style HTML site
5. **Deploys** to GitHub Pages

Daily data collection tracks mid-week storylines (comebacks, blowouts) and roster positions for bench blunder detection.

## Prerequisites

- Node.js 18+
- [Yahoo Fantasy API credentials](https://developer.yahoo.com/apps/) — create an app with Fantasy Sports read permissions
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude --print`) for AI narration
- A GitHub Pages repo for deployment (optional)

## Setup

```bash
git clone https://github.com/PeregrineCode/fantasy-weekly-recap.git
cd fantasy-weekly-recap
npm install
```

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Generate SSL certs for Yahoo OAuth:

```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj '/CN=localhost'
```

Authenticate with Yahoo:

```bash
npx yahoo-fantasy-api authenticate
```

### Configure for Your League

1. **Stat categories** — Edit `lib/stat-categories.js` to match your league's scoring categories. Run `npx yahoo-fantasy-api league-settings <your-league-key>` to see your league's stat IDs.

2. **Prompts** — Edit `prompts/reference.md` with your league's context: team names, manager info, rivalries, running jokes. This is what makes the recaps feel personal. The included file is an example — customize it for your league.

3. **Writer personas** — The narration uses multiple fictional writer voices defined in `prompts/reference.md` and `prompts/system.txt`. Adjust the personas to match your league's vibe.

## Usage

### Full Pipeline

```bash
node run.js                     # Full pipeline for last completed week
node run.js --week 3            # Specific week
node run.js --skip-narrate      # Data pipeline only (no AI)
node run.js --skip-deploy       # Build locally, don't push
```

### Individual Steps

```bash
node daily-positions.js         # Capture today's roster positions (run nightly at 11 PM)
node daily-collect.js           # Snapshot yesterday's stats + merge positions (run 7 AM)
node collect.js [--week N]      # Fetch end-of-week Yahoo data
node analyze.js [--week N]      # Compute segments from collected data
node narrate.js [--week N]      # Generate prose with Claude AI
node build.js                   # Build static HTML site
node deploy.js                  # Push to GitHub Pages
```

### Automated Daily Collection

Two GitHub Actions workflows handle daily data collection:

- **Nightly positions** (11 PM ET) — Captures roster positions when lineups are locked
- **Daily stats** (7 AM ET) — Collects finalized stats and merges with nightly positions

Set these GitHub repo secrets: `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_TOKEN_JSON`, `YAHOO_MLB_LEAGUE_ID`, `PAT_TOKEN`.

## Pipeline Architecture

```
daily-positions.js (11 PM) + daily-collect.js (7 AM)  — daily snapshots
collect.js → analyze.js → narrate.js → build.js → deploy.js  — weekly pipeline
```

### Segments

The analysis generates these segments from the weekly data:

- **Matchup Recaps** — Category-by-category breakdowns with mid-week storylines
- **Players of the Week** — Top batter and pitcher with runners-up
- **Power Rankings** — Composite ranking with tier labels
- **Standings Movers** — Biggest risers and fallers
- **Best/Worst Pickup** — Waiver wire winners and losers
- **Best Stream** — Top streaming pitcher add
- **Transaction Desk** — Trade analysis, FAAB spending, notable moves
- **Bench Blunders** — Players who produced while benched (requires nightly position data)

## Daily Data Collection (Two-Phase)

Yahoo's API always returns current roster positions, not historical. A single morning collection captures next-day positions after managers rearrange. The two-phase approach solves this:

1. **11 PM ET** — Positions captured when lineups are locked for the day
2. **7 AM ET** — Stats captured after all games finish, merged with nightly positions

Snapshots include a `positionsSource` field (`"nightly"` or `"api"`) so analysis knows which days have reliable position data.

## License

MIT
