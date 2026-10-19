/**
 * Manager background notes (returns, titles, rookie seasons) live in the
 * reference table, and every column is written separately from it, so the
 * same note turns up week after week. These helpers find where recent
 * articles already used a manager's note so the writers can be told to skip it.
 */

// Words too common in notes and recaps to signal that a note was used
const STOPWORDS = new Set([
  'about', 'after', 'again', 'already', 'always', 'before', 'being', 'their', 'there',
  'these', 'thing', 'those', 'through', 'under', 'where', 'which', 'while', 'would',
  'every', 'first', 'league', 'season', 'seasons', 'still', 'since', 'never', 'other',
  'team', 'teams', 'this', 'that', 'with', 'from', 'have', 'year', 'week', 'weeks',
  'finished', 'finish', 'games', 'point', 'points', 'going', 'three', 'second', 'third',
]);

/**
 * Parse the "| t.N | Manager | Notes |" table into [{ key, manager, note }].
 * Anything after the notes column on the row counts as part of the note.
 */
function parseManagerNotes(reference) {
  const rows = [];
  for (const m of reference.matchAll(/^\|\s*(t\.\d+)\s*\|\s*([^|]+?)\s*\|(.*)$/gm)) {
    const note = m[3].replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
    if (note) rows.push({ key: m[1], manager: m[2].trim(), note });
  }
  return rows;
}

function noteKeywords(note) {
  const words = note.toLowerCase().match(/[a-z]{5,}/g) || [];
  return new Set(words.filter(w => !STOPWORDS.has(w)));
}

function splitSentences(text) {
  return text
    .replace(/^---[\s\S]*?---\n/, '') // frontmatter
    .split('\n')
    .filter(line => !line.startsWith('#'))
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.replace(/\*\*/g, '').trim())
    .filter(Boolean);
}

/**
 * Sentences in the given articles where a manager is named alongside words
 * from their background note.
 *
 * @param {Array<string>} articles - Markdown of recent articles
 * @param {Array<{manager: string, note: string, teamName?: string}>} notes
 * @returns {Array<{manager: string, sentences: string[]}>}
 */
function findNoteMentions(articles, notes) {
  const sentences = articles.flatMap(splitSentences);
  const found = [];
  for (const { manager, note, teamName } of notes) {
    const keywords = noteKeywords(note);
    // Words in the team's own name ("Ducks on the Pond") aren't a note mention
    for (const w of (teamName || '').toLowerCase().match(/[a-z]{5,}/g) || []) keywords.delete(w);
    const names = [manager, teamName].filter(Boolean)
      .map(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    const hits = sentences.filter(s => {
      if (!names.some(re => re.test(s))) return false;
      const words = s.toLowerCase().match(/[a-z]{5,}/g) || [];
      return words.some(w => keywords.has(w));
    });
    if (hits.length) found.push({ manager, sentences: [...new Set(hits)] });
  }
  return found;
}

module.exports = { parseManagerNotes, findNoteMentions };
