/**
 * Static site builder — converts markdown articles to HTML pages
 * with a classic newspaper layout.
 *
 * Usage: node build.js
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

require('dotenv').config();

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const ARTICLES_DIR = path.join(__dirname, 'articles');
const SITE_DIR = path.join(__dirname, 'site');
const WEEKS_DIR = path.join(SITE_DIR, 'weeks');
const RUMOURS_API_URL = process.env.RUMOURS_API_URL || '';

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      let val = rest.join(':').trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      meta[key.trim()] = val;
    }
  }

  return { meta, content: match[2] };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function loadArticles() {
  if (!fs.existsSync(ARTICLES_DIR)) return [];

  return fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.startsWith('week-') && f.endsWith('.md'))
    .sort()
    .reverse()
    .map(filename => {
      const raw = fs.readFileSync(path.join(ARTICLES_DIR, filename), 'utf-8');
      const { meta, content } = parseFrontmatter(raw);
      const weekNum = parseInt(filename.replace('week-', '').replace('.md', ''));
      return { filename, weekNum, meta, content };
    });
}

function buildNav(articles, activeWeek, pathPrefix = '') {
  const links = [
    `<a href="${pathPrefix}index.html"${activeWeek === null ? ' class="active"' : ''}>Home</a>`,
  ];

  for (const article of articles) {
    const href = `${pathPrefix}weeks/week-${String(article.weekNum).padStart(2, '0')}.html`;
    const isActive = activeWeek === article.weekNum;
    links.push(
      `<a href="${href}"${isActive ? ' class="active"' : ''}>Wk ${article.weekNum}</a>`
    );
  }

  if (RUMOURS_API_URL) {
    const isActive = activeWeek === 'submit';
    links.push(
      `<a href="${pathPrefix}submit.html"${isActive ? ' class="active"' : ''}>Submit a Rumour</a>`
    );
  }

  return links.join('\n        ');
}

function renderPage(title, content, nav, cssPath, homePath, dateDisplay, leagueName) {
  const layout = fs.readFileSync(path.join(TEMPLATES_DIR, 'layout.html'), 'utf-8');
  const season = new Date().getFullYear().toString();
  return layout
    .replace('{{TITLE}}', title)
    .replace('{{CSS_PATH}}', cssPath)
    .replace('{{HOME_PATH}}', homePath)
    .replace('{{NAV}}', nav)
    .replace('{{DATE_DISPLAY}}', dateDisplay)
    .replace(/\{\{LEAGUE_NAME\}\}/g, leagueName || 'Fantasy Baseball League')
    .replace('{{SEASON}}', season)
    .replace('{{CONTENT}}', content);
}

/**
 * Convert article markdown to HTML, splitting the h1 into a header area
 * and wrapping the body in a column layout div.
 */
function renderArticle(article) {
  const rawHtml = marked(article.content);
  const dateDisplay = formatDate(article.meta.date);

  // Extract the h1 from the rendered HTML — it becomes the header headline
  const h1Match = rawHtml.match(/<h1[^>]*>(.*?)<\/h1>/);
  const headline = h1Match ? h1Match[1] : article.meta.title || `Week ${article.weekNum} Recap`;
  const bodyHtml = rawHtml.replace(/<h1[^>]*>.*?<\/h1>/, '');

  return `
    <div class="article-header">
      <div class="kicker">Weekly Recap</div>
      <h1>${headline}</h1>
      <div class="dateline">${dateDisplay}</div>
    </div>
    <div class="article-body">
      ${bodyHtml}
    </div>`;
}

function getLeagueName() {
  // Read from the most recent analysis.json, fall back to env var or default
  const snapshotsDir = path.join(__dirname, 'snapshots');
  if (fs.existsSync(snapshotsDir)) {
    const weeks = fs.readdirSync(snapshotsDir).filter(f => f.startsWith('week-')).sort().reverse();
    for (const week of weeks) {
      const analysisPath = path.join(snapshotsDir, week, 'analysis.json');
      if (fs.existsSync(analysisPath)) {
        try {
          const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
          if (analysis.leagueName) return analysis.leagueName;
        } catch (e) { /* ignore */ }
      }
    }
  }
  return process.env.LEAGUE_NAME || 'Fantasy Baseball League';
}

function buildSubmitContent() {
  return `
    <div class="article-header">
      <div class="kicker">League Intel</div>
      <h1>Submit a Rumour</h1>
    </div>
    <div class="rumour-box">
      <p class="rumour-intro">Heard whispers about a trade? Know which manager is shopping a player? Drop a tip for our insider.</p>
      <form id="rumour-form" class="rumour-form">
        <textarea id="rumour-text" name="text" rows="4" maxlength="1000" placeholder="e.g., Jarren Duran is on the trade block. His manager is looking for pitching help..." required></textarea>
        <div class="rumour-meta">
          <input type="text" id="rumour-source" name="source" placeholder="Your name or alias (optional)" maxlength="50">
          <button type="submit" id="rumour-submit">Submit Tip</button>
        </div>
        <div id="rumour-status" class="rumour-status"></div>
      </form>
    </div>
    <script>
    (function() {
      var API = ${JSON.stringify(RUMOURS_API_URL)};
      var form = document.getElementById('rumour-form');
      var btn = document.getElementById('rumour-submit');
      var status = document.getElementById('rumour-status');

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var text = document.getElementById('rumour-text').value.trim();
        var source = document.getElementById('rumour-source').value.trim();
        if (!text) return;

        btn.disabled = true;
        status.textContent = 'Submitting...';
        status.className = 'rumour-status';

        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, source: source || undefined })
        })
        .then(function(res) {
          if (!res.ok) return res.text().then(function(t) {
            try { var d = JSON.parse(t); throw new Error(d.error || 'Submission failed'); }
            catch(e) { if (e instanceof SyntaxError) throw new Error('Submission failed'); throw e; }
          });
          return res.json();
        })
        .then(function() {
          status.textContent = 'Tip received. Our insider will look into it.';
          status.className = 'rumour-status success';
          document.getElementById('rumour-text').value = '';
          document.getElementById('rumour-source').value = '';
        })
        .catch(function(err) {
          status.textContent = err.message || 'Something went wrong. Try again.';
          status.className = 'rumour-status error';
        })
        .finally(function() {
          btn.disabled = false;
        });
      });
    })();
    </script>`;
}

function build() {
  const articles = loadArticles();

  if (articles.length === 0) {
    console.log('No articles found in articles/. Run narrate.js first.');
    return;
  }

  const leagueName = getLeagueName();

  fs.mkdirSync(WEEKS_DIR, { recursive: true });

  fs.copyFileSync(
    path.join(TEMPLATES_DIR, 'style.css'),
    path.join(SITE_DIR, 'style.css')
  );

  // Build week pages
  for (const article of articles) {
    const nav = buildNav(articles, article.weekNum, '../');
    const htmlContent = renderArticle(article);
    const dateDisplay = formatDateShort(article.meta.date);

    const page = renderPage(
      article.meta.title || `Week ${article.weekNum} Recap`,
      htmlContent,
      nav,
      '../style.css',
      '../index.html',
      dateDisplay,
      leagueName
    );

    const outPath = path.join(WEEKS_DIR, `week-${String(article.weekNum).padStart(2, '0')}.html`);
    fs.writeFileSync(outPath, page);
    console.log(`  Built ${outPath}`);
  }

  // Build index page
  const nav = buildNav(articles, null);
  const latest = articles[0];
  const latestHref = `weeks/week-${String(latest.weekNum).padStart(2, '0')}.html`;

  let indexContent = `
    <div class="index-header">
      <p>Weekly recaps, hot takes, and questionable roster decisions</p>
    </div>

    <div class="section-label">Latest Edition</div>
    <div class="featured">
      <a href="${latestHref}">
        <div class="week-title">${latest.meta.title || `Week ${latest.weekNum} Recap`}</div>
        <div class="week-date">${formatDate(latest.meta.date)}</div>
        <span class="read-link">Read the full recap &rarr;</span>
      </a>
    </div>`;

  if (articles.length > 1) {
    indexContent += `\n    <div class="section-label">Previous Editions</div>\n    <ul class="week-list">`;
    for (const article of articles.slice(1)) {
      const href = `weeks/week-${String(article.weekNum).padStart(2, '0')}.html`;
      indexContent += `
      <li>
        <a href="${href}">
          <div class="week-title">${article.meta.title || `Week ${article.weekNum} Recap`}</div>
          <div class="week-date">${formatDate(article.meta.date)}</div>
        </a>
      </li>`;
    }
    indexContent += `\n    </ul>`;
  }

  const indexPage = renderPage(
    `The League Report — ${leagueName}`,
    indexContent,
    nav,
    'style.css',
    'index.html',
    formatDateShort(new Date().toISOString().split('T')[0]),
    leagueName
  );

  fs.writeFileSync(path.join(SITE_DIR, 'index.html'), indexPage);
  console.log(`  Built index.html`);

  // Build submit page (if rumours API is configured)
  if (RUMOURS_API_URL) {
    const submitNav = buildNav(articles, 'submit');
    const submitPage = renderPage(
      `Submit a Rumour — The League Report`,
      buildSubmitContent(),
      submitNav,
      'style.css',
      'index.html',
      'League Intel',
      leagueName
    );
    fs.writeFileSync(path.join(SITE_DIR, 'submit.html'), submitPage);
    console.log(`  Built submit.html`);
  }

  console.log(`\nSite built → ${SITE_DIR}`);
}

if (require.main === module) {
  build();
}

module.exports = { build };
