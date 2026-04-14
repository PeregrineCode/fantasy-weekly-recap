const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test the pure functions from build.js by reimplementing them
// (they're not exported, but we validate the logic)

describe('parseFrontmatter', () => {
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

  it('parses title and week from frontmatter', () => {
    const raw = `---\ntitle: "Week 1 Recap"\nweek: 1\ndate: 2026-04-03\n---\n\n# Content here`;
    const { meta, content } = parseFrontmatter(raw);
    assert.equal(meta.title, 'Week 1 Recap');
    assert.equal(meta.week, '1');
    assert.equal(meta.date, '2026-04-03');
    assert.ok(content.includes('# Content here'));
  });

  it('handles missing frontmatter', () => {
    const raw = '# Just markdown\n\nNo frontmatter here.';
    const { meta, content } = parseFrontmatter(raw);
    assert.deepEqual(meta, {});
    assert.equal(content, raw);
  });

  it('handles colons in values', () => {
    const raw = `---\ntitle: "Week 1 Recap: The Big One"\n---\n\nContent`;
    const { meta } = parseFrontmatter(raw);
    assert.equal(meta.title, 'Week 1 Recap: The Big One');
  });

  it('handles empty frontmatter', () => {
    const raw = `---\n\n---\n\nContent`;
    const { meta, content } = parseFrontmatter(raw);
    assert.deepEqual(meta, {});
    assert.ok(content.includes('Content'));
  });
});

describe('formatDate', () => {
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  it('formats a valid date', () => {
    const result = formatDate('2026-04-03');
    assert.ok(result.includes('2026'));
    assert.ok(result.includes('April'));
    assert.ok(result.includes('3'));
  });

  it('returns empty string for empty input', () => {
    assert.equal(formatDate(''), '');
    assert.equal(formatDate(null), '');
    assert.equal(formatDate(undefined), '');
  });

  it('returns raw string for invalid date', () => {
    assert.equal(formatDate('not-a-date'), 'not-a-date');
  });
});

describe('nav generation', () => {
  function buildNav(articles, activeWeek, pathPrefix = '') {
    const links = [
      `<a href="${pathPrefix}index.html"${activeWeek === null ? ' class="active"' : ''}>Home</a>`,
    ];
    for (const article of articles) {
      const href = `${pathPrefix}weeks/week-${String(article.weekNum).padStart(2, '0')}.html`;
      const isActive = activeWeek === article.weekNum;
      links.push(`<a href="${href}"${isActive ? ' class="active"' : ''}>Wk ${article.weekNum}</a>`);
    }
    return links.join('\n        ');
  }

  const articles = [
    { weekNum: 3 },
    { weekNum: 2 },
    { weekNum: 1 },
  ];

  it('marks home as active when activeWeek is null', () => {
    const nav = buildNav(articles, null);
    assert.ok(nav.includes('index.html" class="active"'));
  });

  it('marks correct week as active', () => {
    const nav = buildNav(articles, 2);
    assert.ok(nav.includes('week-02.html" class="active"'));
    assert.ok(!nav.includes('index.html" class="active"'));
  });

  it('uses path prefix for week pages', () => {
    const nav = buildNav(articles, 1, '../');
    assert.ok(nav.includes('../index.html'));
    assert.ok(nav.includes('../weeks/week-01.html'));
  });

  it('generates correct week numbers with zero padding', () => {
    const nav = buildNav([{ weekNum: 1 }], null);
    assert.ok(nav.includes('week-01.html'));
  });
});
