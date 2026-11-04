import { backToList, mobile, newBlankNote, SHOTS, SHOWCASE, showcasePhoneShot, showcaseShot, until } from './harness.mjs';
import { wait } from '../server.mjs';
import { toFrontmatter } from '../../../web/core/frontmatter.js';

/** Flow 31: A note worth showing. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow31(shared) {
  const { A } = shared;
  // 31. A note worth showing (#352), as a page (Preview): a heading, tags, bold and italic, tasks
  // (two ticked), a table, a quote, a link; screenshots light and dark, in a Safari window on a
  // computer, on an iPhone 16 on a phone (for the site about Plim).
  const phone = mobile(A);
  await newBlankNote(A);
  // (Its title and tags in its frontmatter, #584: the header shows them over the page.)
  await A.evaluate((t) => document.getElementById('editor').noteYText().insert(0, t), toFrontmatter(SHOWCASE));
  await until(A, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
  // (Its tags in its row too, once they're read from its text: a second after typing stops.)
  await until(A, () => [...document.querySelectorAll('#note-list li')].some((li) => li.querySelector('.row-tags')?.textContent === '#lisbon #travel'), undefined, 10000);
  // (A phone: Preview is the bar's toggle; a computer: the Edit / Split / Preview switch.)
  await A.click(phone ? '#note-preview' : '#note-mode [data-mode="preview"]');
  await until(A, () => !document.getElementById('reading').hidden && document.querySelector('#reading table'));
  // From its top (Preview keeps the place you were typing at: the end).
  await A.evaluate(() => (document.getElementById('reading').scrollTop = 0));
  await wait(300);
  const page = await A.evaluate(() => {
    const r = document.getElementById('reading');
    return { h1: document.getElementById('note-head-title').value, rows: r.querySelectorAll('tbody tr').length, ticked: r.querySelectorAll('input[type=checkbox]:checked').length,
      tasks: r.querySelectorAll('input[type=checkbox]').length, quote: Boolean(r.querySelector('blockquote')), tags: document.querySelectorAll('#note-head-tags .head-tag').length + r.querySelectorAll('.tag').length * 10,
      bold: r.querySelectorAll('strong').length, link: r.querySelector('a[href]')?.textContent,
      // (The table's empty corner keeps its place, #352: three header cells over three columns.)
      head: [...r.querySelectorAll('thead th')].map((th) => th.textContent).join('|') };
  });
  if (page.h1 !== 'Lisbon, 18–21 October' || page.rows !== 3 || page.tasks !== 4 || page.ticked !== 2 || !page.quote || page.tags !== 2 || page.bold < 2 || page.link !== 'Visit Lisboa' || page.head !== '|Planned|Spent') {
    throw new Error(`the note worth showing, as a page: ${JSON.stringify(page)}`);
  }
  if (SHOTS) {
    for (const scheme of ['light', 'dark']) {
      await A.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await wait(400);
      // (No toast left over from an earlier flow over the list: it's a picture for the site.)
      await A.evaluate(() => {
        document.activeElement?.blur?.();
        for (const t of document.querySelectorAll('.toast')) t.hidden = true;
      });
      if (phone) await showcasePhoneShot(A, scheme === 'light');
      else await showcaseShot(await A.screenshot(), scheme === 'light');
    }
    await A.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  }
  // Back as it was: the editor (a phone: the list, as the next flow expects).
  if (phone) await backToList(A);
  else await A.click('#note-mode [data-mode="edit"]');
}
