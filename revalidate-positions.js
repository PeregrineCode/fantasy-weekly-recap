/**
 * Re-evaluate `positionsSource` on existing daily snapshots — WITHOUT re-fetching.
 *
 * The nightly capture (daily-positions.js) is meant to run ~10:30 PM ET when lineups
 * are locked, but GitHub Actions delays can push it past Yahoo's ~3 AM ET fantasy-day
 * rollover, where it reads the NEXT day's not-yet-finalized lineup → phantom bench
 * blunders. daily-collect.js now guards new collections, but snapshots collected before
 * that guard may still be mislabeled `nightly` when they were actually premature.
 *
 * This script reads each day's `positions-YYYY-MM-DD.json` capture time, applies the
 * same trustworthiness window, and rewrites only `positionsSource` / `positionsCapturedAt`
 * on the merged `YYYY-MM-DD.json` snapshot. It never calls Yahoo, so matchups (cumulative
 * -as-of-day) and roster composition stay exactly as originally captured.
 *
 * Usage:
 *   node revalidate-positions.js --week 11      # one week
 *   node revalidate-positions.js                # all weeks under snapshots/
 */

const fs = require('fs');
const path = require('path');
const { isNightlyCaptureTrustworthy } = require('./daily-collect');

function revalidateWeek(weekDir) {
  const dailyDir = path.join(weekDir, 'daily');
  if (!fs.existsSync(dailyDir)) return { changed: 0, checked: 0 };

  let changed = 0, checked = 0;
  const dayFiles = fs.readdirSync(dailyDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const file of dayFiles) {
    const snapPath = path.join(dailyDir, file);
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    // Only days that had a nightly capture merged are candidates ('api' days had none).
    if (snap.positionsSource !== 'nightly' && snap.positionsSource !== 'nightly-premature') continue;

    const posFile = path.join(dailyDir, `positions-${snap.date}.json`);
    if (!fs.existsSync(posFile)) continue;
    const capturedAt = JSON.parse(fs.readFileSync(posFile, 'utf8')).collectedAt || null;

    const newSource = isNightlyCaptureTrustworthy(capturedAt, snap.date) ? 'nightly' : 'nightly-premature';
    checked++;
    if (snap.positionsSource === newSource && snap.positionsCapturedAt === capturedAt) continue;

    const before = snap.positionsSource;
    snap.positionsSource = newSource;
    snap.positionsCapturedAt = capturedAt;
    fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));
    changed++;
    console.log(`  ${snap.date}: ${before} → ${newSource} (captured ${capturedAt})`);
  }
  return { changed, checked };
}

function main() {
  const weekArgIdx = process.argv.indexOf('--week');
  const snapshotsRoot = path.join(__dirname, 'snapshots');
  let weekDirs;
  if (weekArgIdx !== -1 && process.argv[weekArgIdx + 1]) {
    const n = String(parseInt(process.argv[weekArgIdx + 1], 10)).padStart(2, '0');
    weekDirs = [path.join(snapshotsRoot, `week-${n}`)];
  } else {
    weekDirs = fs.readdirSync(snapshotsRoot)
      .filter(d => /^week-\d+$/.test(d))
      .map(d => path.join(snapshotsRoot, d));
  }

  let totalChanged = 0, totalChecked = 0;
  for (const wd of weekDirs) {
    if (!fs.existsSync(wd)) { console.log(`  (no such week dir: ${wd})`); continue; }
    console.log(`Revalidating ${path.basename(wd)}...`);
    const { changed, checked } = revalidateWeek(wd);
    totalChanged += changed; totalChecked += checked;
  }
  console.log(`\nDone. Re-labeled ${totalChanged} of ${totalChecked} nightly-capture day(s).`);
}

if (require.main === module) main();

module.exports = { revalidateWeek };
