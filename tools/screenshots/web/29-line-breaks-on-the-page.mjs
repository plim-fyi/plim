import { newBlankNote, setView, shot } from './harness.mjs';

/** Flow 29: Line breaks on the page. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow29(shared) {
  const { A } = shared;
  // 29. A line break on the page is a line break (#317), as it is in the editor: lines typed one
  // under the other stay so in Preview; a line under a list item is on its own line in the item
  // (still in it, as markdown has it); a blank line still makes a new paragraph.
  await A.bringToFront();
  await newBlankNote(A);
  await A.cdp.send('Input.insertText', { text: 'Line breaks\n\nFlights: Thu 08:40\nStay: Alfama\n\n- budget\nmore about the budget\n- hiring\n\nmilk  \neggs' });
  await setView(A, 'preview');
  const lines = await A.evaluate(() => {
    const top = (word) => {
      const r = document.getElementById('reading');
      const walk = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.data.indexOf(word);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i); range.setEnd(n, i + word.length);
        const b = range.getBoundingClientRect();
        return { top: Math.round(b.top), left: Math.round(b.left), li: n.parentElement.closest('li')?.dataset.from ?? null };
      }
      return null;
    };
    return { flights: top('Flights'), stay: top('Stay'), budget: top('budget'), more: top('more about'), milk: top('milk'), eggs: top('eggs'), lis: document.querySelectorAll('#reading li').length, brs: document.querySelectorAll('#reading br').length };
  });
  const below = (a, b) => b.top > a.top + 10;
  if (!below(lines.flights, lines.stay) || lines.stay.left !== lines.flights.left) throw new Error(`Flights / Stay on two lines: ${JSON.stringify(lines)}`);
  if (!below(lines.budget, lines.more) || lines.more.li !== lines.budget.li || lines.lis !== 2) throw new Error(`a line under a list item: its own line, in the item: ${JSON.stringify(lines)}`);
  if (!below(lines.milk, lines.eggs) || lines.brs !== 1) throw new Error(`a hard break (two spaces): one line break, not two: ${JSON.stringify(lines)}`);
  await shot(A, '29-breaks-1-page');
  await setView(A, 'edit');
}
