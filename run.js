/**
 * Weekly recap orchestrator — runs the full pipeline:
 * collect → analyze → narrate → build → deploy
 *
 * Usage:
 *   node run.js                     # Full pipeline for last completed week
 *   node run.js --week 3            # Specific week
 *   node run.js --skip-narrate      # Skip LLM generation (data + build only)
 *   node run.js --skip-deploy       # Skip pushing to GitHub Pages
 */

const { collect } = require('./collect');
const { analyze } = require('./analyze');
const { narrate } = require('./narrate');
const { build } = require('./build');
const { deploy } = require('./deploy');

async function run() {
  const args = process.argv.slice(2);
  const weekIdx = args.indexOf('--week');
  let targetWeek = null;
  if (weekIdx !== -1) {
    targetWeek = parseInt(args[weekIdx + 1]);
    if (!targetWeek || targetWeek < 1) {
      console.error('Invalid --week value. Must be a positive integer.');
      process.exit(1);
    }
  }
  const skipNarrate = args.includes('--skip-narrate');
  const skipDeploy = args.includes('--skip-deploy');

  const startTime = Date.now();
  console.log(`\n=== Weekly Recap Pipeline ===`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  try {
    // Step 1: Collect data from Yahoo
    console.log('--- STEP 1: Collect ---');
    const { week } = await collect(targetWeek);
    console.log('');

    // Step 2: Analyze data
    console.log('--- STEP 2: Analyze ---');
    await analyze(week);
    console.log('');

    // Step 3: Generate narrative
    if (!skipNarrate) {
      console.log('--- STEP 3: Narrate ---');
      await narrate(week);
      console.log('');
    } else {
      console.log('--- STEP 3: Narrate (SKIPPED) ---\n');
    }

    // Step 4: Build static site
    console.log('--- STEP 4: Build ---');
    build();
    console.log('');

    // Step 5: Deploy
    if (!skipDeploy) {
      console.log('--- STEP 5: Deploy ---');
      deploy();
    } else {
      console.log('--- STEP 5: Deploy (SKIPPED) ---');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Pipeline complete (${elapsed}s) ===`);

  } catch (err) {
    console.error(`\n!!! Pipeline failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

run();
