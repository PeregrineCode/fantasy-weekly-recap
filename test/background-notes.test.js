const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseManagerNotes, findNoteMentions } = require('../lib/background-notes');

const REFERENCE = `| Key | Manager | Notes |
|-----|---------|-------|
| t.1 | Tom | Original member. Won the first title (2017-18) | Drafted almost entirely anaheim ducks
| t.3 | Dave | Returning this season after nearly 10 years away from the league |
| t.9 | Mac | |`;

describe('parseManagerNotes', () => {
  it('reads each manager note, including text past the notes column', () => {
    const notes = parseManagerNotes(REFERENCE);
    assert.deepEqual(notes.map(n => n.manager), ['Tom', 'Dave']);
    assert.match(notes[0].note, /anaheim ducks/);
  });
});

describe('findNoteMentions', () => {
  const notes = parseManagerNotes(REFERENCE).map(n => n.manager === 'Dave' ? { ...n, teamName: 'Oscar Meier Wiener' } : n);

  it('finds sentences where a manager is named alongside their note', () => {
    const article = `---\ntitle: x\n---\n## Recaps\n\n**Oscar Meier Wiener** won 7-1-1. Dave, back after nearly ten years away, is rolling. Tom lost again.`;
    const found = findNoteMentions([article], notes);
    assert.equal(found.length, 1);
    assert.equal(found[0].manager, 'Dave');
    assert.deepEqual(found[0].sentences, ['Dave, back after nearly ten years away, is rolling.']);
  });

  it('matches the current team name as well as the manager', () => {
    const found = findNoteMentions(['Oscar Meier Wiener is a returning juggernaut.'], notes);
    assert.equal(found[0].manager, 'Dave');
  });

  it('ignores ordinary mentions with no note words', () => {
    assert.deepEqual(findNoteMentions(['Dave won seven categories this week.'], notes), []);
  });
});
