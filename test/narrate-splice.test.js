const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  SEGMENT_REGISTRY,
  parseArticleSections,
  matchSectionsToRegistry,
  spliceArticle,
} = require('../narrate');

// --- parseArticleSections ---

describe('parseArticleSections', () => {
  it('parses a minimal article with one section', () => {
    const md = `---
title: "Test"
week: 1
---

# Week 1 Recap

## Matchup Recaps

<p class="byline">by Chuck "The Hammer" Morrison</p>

Some content here.

---

`;
    const result = parseArticleSections(md);
    assert.ok(result);
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].title, 'Matchup Recaps');
    assert.equal(result.sections[0].byline, 'Chuck "The Hammer" Morrison');
    assert.equal(result.sections[0].content, 'Some content here.');
  });

  it('parses multiple sections', () => {
    const md = `---
title: "Test"
week: 1
---

# Week 1 Recap

## Section One

<p class="byline">by Writer A</p>

Content one.

---

## Section Two

<p class="byline">by Writer B</p>

Content two.

---

`;
    const result = parseArticleSections(md);
    assert.ok(result);
    assert.equal(result.sections.length, 2);
    assert.equal(result.sections[0].title, 'Section One');
    assert.equal(result.sections[0].content, 'Content one.');
    assert.equal(result.sections[1].title, 'Section Two');
    assert.equal(result.sections[1].content, 'Content two.');
  });

  it('preserves multi-paragraph content', () => {
    const md = `---
title: "Test"
week: 1
---

# Week 1 Recap

## Test Section

<p class="byline">by Writer</p>

Paragraph one with **bold** and *italic*.

Paragraph two continues the story.

Third paragraph closes it out.

---

`;
    const result = parseArticleSections(md);
    assert.ok(result);
    assert.ok(result.sections[0].content.includes('Paragraph one'));
    assert.ok(result.sections[0].content.includes('Third paragraph'));
  });

  it('returns null for articles without ## sections', () => {
    const md = `---\ntitle: "Test"\n---\n\n# Just a heading\n\nNo sections here.\n`;
    assert.equal(parseArticleSections(md), null);
  });

  it('parses real week-01 article', () => {
    const articlePath = path.join(__dirname, '..', 'articles', 'week-01.md');
    if (!fs.existsSync(articlePath)) return; // skip if no article
    const md = fs.readFileSync(articlePath, 'utf-8');
    const result = parseArticleSections(md);
    assert.ok(result);
    assert.equal(result.sections.length, 8);
    assert.equal(result.sections[0].title, 'Matchup Mayhem'); // edited title
    assert.equal(result.sections[0].byline, 'Chuck "The Hammer" Morrison');
  });

  it('parses real week-02 article', () => {
    const articlePath = path.join(__dirname, '..', 'articles', 'week-02.md');
    if (!fs.existsSync(articlePath)) return;
    const md = fs.readFileSync(articlePath, 'utf-8');
    const result = parseArticleSections(md);
    assert.ok(result);
    assert.equal(result.sections.length, 9);
    // "Trade Desk" is an edited title for Transaction Desk
    const tradeDeskSection = result.sections.find(s => s.title === 'Trade Desk');
    assert.ok(tradeDeskSection);
  });
});

// --- matchSectionsToRegistry ---

describe('matchSectionsToRegistry', () => {
  it('matches exact titles correctly', () => {
    const sections = [
      { title: 'Power Rankings', byline: 'Chuck "The Hammer" Morrison' },
      { title: "Mad Dog's Hot Takes", byline: '"Mad Dog" Maguire' },
    ];
    const matches = matchSectionsToRegistry(sections);
    assert.equal(matches.get(0), 'rankings');
    assert.equal(matches.get(1), 'maddog');
  });

  it('matches edited title "Matchup Mayhem" to matchups', () => {
    const sections = [
      { title: 'Matchup Mayhem', byline: 'Chuck "The Hammer" Morrison' },
    ];
    const matches = matchSectionsToRegistry(sections);
    assert.equal(matches.get(0), 'matchups');
  });

  it('matches edited title "Trade Desk" to tx-desk', () => {
    const sections = [
      { title: 'Trade Desk', byline: 'Chuck "The Hammer" Morrison' },
    ];
    const matches = matchSectionsToRegistry(sections);
    assert.equal(matches.get(0), 'tx-desk');
  });

  it('uses byline to disambiguate Mad Dog and Gerald', () => {
    const sections = [
      { title: 'Some Column', byline: '"Mad Dog" Maguire' },
      { title: 'Another Column', byline: 'Gerald R. Pemberton III' },
    ];
    const matches = matchSectionsToRegistry(sections);
    assert.equal(matches.get(0), 'maddog');
    assert.equal(matches.get(1), 'numbers');
  });

  it('matches all sections from week-01 article', () => {
    const articlePath = path.join(__dirname, '..', 'articles', 'week-01.md');
    if (!fs.existsSync(articlePath)) return;
    const md = fs.readFileSync(articlePath, 'utf-8');
    const parsed = parseArticleSections(md);
    const matches = matchSectionsToRegistry(parsed.sections);

    // Week-01 sections: Matchup Mayhem, Power Rankings, Best Pickup, Hall of Shame,
    // Stream of the Week, Front Office Failures, Mad Dog's Hot Takes, The Numbers Don't Lie
    assert.equal(matches.size, 8);
    assert.equal(matches.get(0), 'matchups');      // "Matchup Mayhem"
    assert.equal(matches.get(1), 'rankings');       // "Power Rankings"
    assert.equal(matches.get(6), 'maddog');         // "Mad Dog's Hot Takes"
    assert.equal(matches.get(7), 'numbers');        // "The Numbers Don't Lie"
  });

  it('matches all sections from week-02 article', () => {
    const articlePath = path.join(__dirname, '..', 'articles', 'week-02.md');
    if (!fs.existsSync(articlePath)) return;
    const md = fs.readFileSync(articlePath, 'utf-8');
    const parsed = parseArticleSections(md);
    const matches = matchSectionsToRegistry(parsed.sections);

    assert.equal(matches.size, 9);
    assert.equal(matches.get(0), 'matchups');       // "Matchup Recaps"
    assert.equal(matches.get(1), 'rankings');       // "Power Rankings"
    // "Trade Desk" (edited title) should match tx-desk
    const tradeDeskIdx = parsed.sections.findIndex(s => s.title === 'Trade Desk');
    assert.equal(matches.get(tradeDeskIdx), 'tx-desk');
    assert.equal(matches.get(parsed.sections.length - 2), 'maddog');
    assert.equal(matches.get(parsed.sections.length - 1), 'numbers');
  });
});

// --- spliceArticle ---

describe('spliceArticle', () => {
  const makeParsed = () => ({
    header: '---\ntitle: "Test"\n---\n\n# Week 1 Recap\n\n',
    sections: [
      { title: 'Matchup Recaps', byline: 'Chuck "The Hammer" Morrison', content: 'Original matchup content.' },
      { title: "Mad Dog's Hot Takes", byline: '"Mad Dog" Maguire', content: 'Original mad dog content.' },
      { title: "The Numbers Don't Lie", byline: 'Gerald R. Pemberton III', content: 'Original gerald content.' },
    ],
  });

  it('replaces only targeted sections', () => {
    const parsed = makeParsed();
    const sectionToKey = new Map([[0, 'matchups'], [1, 'maddog'], [2, 'numbers']]);
    const newSections = [{ registryKey: 'maddog', content: 'NEW mad dog content.' }];

    const result = spliceArticle(parsed, newSections, sectionToKey);

    assert.ok(result.includes('Original matchup content.'));
    assert.ok(result.includes('NEW mad dog content.'));
    assert.ok(!result.includes('Original mad dog content.'));
    assert.ok(result.includes('Original gerald content.'));
  });

  it('preserves existing titles and bylines when replacing content', () => {
    const parsed = makeParsed();
    // Simulate an edited title
    parsed.sections[0].title = 'Matchup Mayhem';
    const sectionToKey = new Map([[0, 'matchups'], [1, 'maddog'], [2, 'numbers']]);
    const newSections = [{ registryKey: 'matchups', content: 'New content.' }];

    const result = spliceArticle(parsed, newSections, sectionToKey);

    assert.ok(result.includes('## Matchup Mayhem'));  // edited title preserved
    assert.ok(result.includes('New content.'));
    assert.ok(!result.includes('Original matchup content.'));
  });

  it('leaves all sections intact when no new sections provided', () => {
    const parsed = makeParsed();
    const sectionToKey = new Map([[0, 'matchups'], [1, 'maddog'], [2, 'numbers']]);
    const newSections = [];

    const result = spliceArticle(parsed, newSections, sectionToKey);

    assert.ok(result.includes('Original matchup content.'));
    assert.ok(result.includes('Original mad dog content.'));
    assert.ok(result.includes('Original gerald content.'));
  });

  it('replaces multiple sections at once', () => {
    const parsed = makeParsed();
    const sectionToKey = new Map([[0, 'matchups'], [1, 'maddog'], [2, 'numbers']]);
    const newSections = [
      { registryKey: 'matchups', content: 'New matchups.' },
      { registryKey: 'numbers', content: 'New numbers.' },
    ];

    const result = spliceArticle(parsed, newSections, sectionToKey);

    assert.ok(result.includes('New matchups.'));
    assert.ok(result.includes('Original mad dog content.'));
    assert.ok(result.includes('New numbers.'));
  });

  it('preserves header and article structure', () => {
    const parsed = makeParsed();
    const sectionToKey = new Map([[0, 'matchups'], [1, 'maddog'], [2, 'numbers']]);
    const newSections = [{ registryKey: 'matchups', content: 'New content.' }];

    const result = spliceArticle(parsed, newSections, sectionToKey);

    assert.ok(result.startsWith('---\ntitle: "Test"\n---\n\n# Week 1 Recap\n\n'));
    // Every section should have proper structure
    const sectionCount = (result.match(/^## /gm) || []).length;
    assert.equal(sectionCount, 3);
  });
});

// --- Tx group expansion ---

describe('tx group expansion', () => {
  it('all tx-group keys share the same group', () => {
    const txKeys = SEGMENT_REGISTRY.filter(s => s.group === 'tx').map(s => s.key);
    assert.ok(txKeys.includes('best-pickup'));
    assert.ok(txKeys.includes('hall-of-shame'));
    assert.ok(txKeys.includes('stream'));
    assert.ok(txKeys.includes('tx-desk'));
    assert.ok(txKeys.includes('roasts'));
    assert.equal(txKeys.length, 5);
  });

  it('non-tx segments have no group', () => {
    const nonTx = SEGMENT_REGISTRY.filter(s => s.group !== 'tx');
    for (const entry of nonTx) {
      assert.equal(entry.group, null, `${entry.key} should have null group`);
    }
  });
});
