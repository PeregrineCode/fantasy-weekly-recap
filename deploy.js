/**
 * Deploy script — pushes built site to a separate public GitHub Pages repo.
 *
 * Usage: node deploy.js
 *
 * Target repo is configured via DEPLOY_REPO env var (required).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SITE_DIR = path.join(__dirname, 'site');
const DEPLOY_DIR = path.join(__dirname, '.deploy');

function git(args, opts = {}) {
  console.log(`  $ git ${args.join(' ')}`);
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 30000,
    ...opts,
  }).trim();
}

function deploy() {
  const DEPLOY_REPO = process.env.DEPLOY_REPO;
  if (!DEPLOY_REPO) {
    console.error('DEPLOY_REPO env var required (e.g., "your-user/your-recap-site")');
    process.exit(1);
  }
  const REPO_URL = `https://github.com/${DEPLOY_REPO}.git`;

  if (!fs.existsSync(SITE_DIR) || !fs.existsSync(path.join(SITE_DIR, 'index.html'))) {
    console.error('No built site found. Run build.js first.');
    process.exit(1);
  }

  console.log(`Deploying to ${DEPLOY_REPO}...`);

  // Clone or update the deploy repo
  if (fs.existsSync(path.join(DEPLOY_DIR, '.git'))) {
    console.log('  Updating existing deploy checkout...');
    git(['pull', '--ff-only'], { cwd: DEPLOY_DIR });
  } else {
    console.log('  Cloning deploy repo...');
    try {
      git(['clone', REPO_URL, DEPLOY_DIR]);
    } catch (e) {
      console.error(`Failed to clone ${REPO_URL}. Make sure the repo exists:`);
      console.error(`  gh repo create ${DEPLOY_REPO} --public --description "Weekly fantasy baseball league recaps"`);
      process.exit(1);
    }
  }

  // Clear old files (except .git)
  const existing = fs.readdirSync(DEPLOY_DIR).filter(f => f !== '.git');
  for (const file of existing) {
    fs.rmSync(path.join(DEPLOY_DIR, file), { recursive: true, force: true });
  }

  // Copy site files
  copyRecursive(SITE_DIR, DEPLOY_DIR);

  // Include reference file for transparency
  const refSrc = path.join(__dirname, 'prompts', 'reference.md');
  if (fs.existsSync(refSrc)) {
    fs.copyFileSync(refSrc, path.join(DEPLOY_DIR, 'reference.md'));
  }

  console.log('  Copied site files.');

  // Check if there are changes
  const status = git(['status', '--porcelain'], { cwd: DEPLOY_DIR });
  if (!status) {
    console.log('  No changes to deploy.');
    return;
  }

  // Find the latest week for the commit message
  const weeksDir = path.join(SITE_DIR, 'weeks');
  let weekLabel = 'update';
  if (fs.existsSync(weeksDir)) {
    const weeks = fs.readdirSync(weeksDir).filter(f => f.endsWith('.html')).sort().reverse();
    if (weeks.length) {
      const num = parseInt(weeks[0].replace('week-', '').replace('.html', ''));
      if (num > 0) weekLabel = `Week ${num} recap`;
    }
  }

  // Commit and push
  const date = new Date().toISOString().split('T')[0];
  git(['add', '-A'], { cwd: DEPLOY_DIR });
  git(['commit', '-m', `${weekLabel} — ${date}`], { cwd: DEPLOY_DIR });
  git(['push'], { cwd: DEPLOY_DIR, timeout: 60000 });

  const owner = DEPLOY_REPO.split('/')[0].toLowerCase();
  const repo = DEPLOY_REPO.split('/')[1];
  console.log(`\nDeployed! Site should be live at: https://${owner}.github.io/${repo}/`);
}

function copyRecursive(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (require.main === module) {
  deploy();
}

module.exports = { deploy };
