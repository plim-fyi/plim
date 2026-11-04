// A note's title: its first non-empty line, without its markdown marks (#138):
// "# Trip to Lisbon" is listed as "Trip to Lisbon".
// The terminal client does the same (crates/plim-cli/src/notes.rs,
// title_from_line); web/tests/fixtures/titles.json holds the cases both pass.

const BLOCK_MARK = /^(?:#{1,6}(?:\s+|$)|>\s*|[-*+](?:\s+|$)|\d{1,9}[.)](?:\s+|$)|\[[ xX]\](?:\s+|$))/;

/** A line, as a title: heading, quote, list and task marks at its start go, as do links' brackets and bold, strike and code marks. */
export function titleFromLine(line) {
  const trimmed = line.trim();
  let t = trimmed;
  // (Repeated: "> - [ ] Call Ana" is a task in a list in a quote.)
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t.replace(BLOCK_MARK, '');
  }
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|~~|`/g, '').trim();
  return t || trimmed; // (a line that's only marks, like "---", stays as it is)
}
