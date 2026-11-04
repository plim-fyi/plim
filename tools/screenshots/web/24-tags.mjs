import { allNotes, backToList, mobile, newBlankNote, openNote, pickTag, rowMenu, s, setView, until } from './harness.mjs';

/** A note's text with its title and tags in its frontmatter (#584), then its body. */
export const withFrontmatter = (title, tags, body) => `---\ntitle: ${title}\n${tags.length ? `tags: [${tags.join(', ')}]\n` : ''}---\n${body}`;

/** Flow 24: Tags. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow24(shared) {
  const { A, B } = shared;
  // 24. Tags (#308, #539, #584): a note's tags are its frontmatter's (`tags: [gym, training]`), a
  // `#word` in its text is text. The chips over the list (each tag a word: #gym/legs one of its
  // own), picking one to list its notes; more than fit, one row that scrolls. The note's header:
  // its tags as badges, × to take one off, + tag for a picker of yours, a badge tapped for its
  // notes, yaml › for the block itself. The same tags on the other device (kept in the note list).
  await A.bringToFront();
  const chips = (p) => p.evaluate(() => ({
    shown: !document.getElementById('chips').hidden,
    all: String(!document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]')), // (nothing picked: every note, #549)
    top: [...document.querySelectorAll('#tag-chips .tag-chip')].map((b) => `${b.dataset.tag}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`),
  }));
  const listed = (p) => p.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] .title')].map((e) => e.textContent));
  const head = (p) => p.evaluate(() => ({
    shown: !document.getElementById('note-head').hidden,
    title: document.getElementById('note-head-title').value,
    tags: [...document.querySelectorAll('#note-head-tags .head-tag-name')].map((b) => b.dataset.tag).join(),
  }));
  // (Written as a paste would put it in: the note's text, its block first.)
  const write = async (text) => {
    await backToList(A);
    await newBlankNote(A);
    await A.evaluate((t) => document.getElementById('editor').noteYText().insert(0, t), text);
  };
  await write(withFrontmatter('Training 2026', ['gym', 'training'], 'Squat · 135 lb × 12'));
  await write(withFrontmatter('Leg day', ['gym/legs'], 'Felt strong today #notatag, and `#code` too.'));
  await backToList(A);
  await until(A, () => [...document.querySelectorAll('#tag-chips .tag-chip')].length === 3
    && [...document.querySelectorAll('#note-list .row-tags')].some((e) => e.textContent === '#gym/legs'), undefined, 10000)
    .catch(async () => { throw new Error(`the chips should show the tags: ${JSON.stringify(await chips(A))}`); });
  {
    const c = await chips(A);
    // (The most recently used first: Leg day's, written last; then Training's, by name.)
    if (!c.shown || c.all !== 'true' || c.top.join() !== 'gym/legs,gym,training') throw new Error(`the chips (no #notatag: a #word in the text is text): ${JSON.stringify(c)}`);
  }
  // A phone: the same chips, 44 px for a finger, one line; the notes right under them.
  if (mobile(A)) {
    const list = await A.evaluate(() => ({
      heights: [...document.querySelectorAll('#chip-row .chip')].filter((b) => b.offsetParent).map((b) => b.offsetHeight),
      firstNote: Math.round(document.querySelector('#note-list li[data-id]').getBoundingClientRect().top),
    }));
    if (list.heights.some((h) => h < 44) || list.firstNote > 330) throw new Error(`a phone's chips: ${JSON.stringify(list)}`);
  }
  // Each row says its tags after its date (#350): "· #gym #training"; an untagged one, its date alone.
  const rowTags = () => A.evaluate(() => Object.fromEntries([...document.querySelectorAll('#note-list li')].map((li) => [li.querySelector('.title').textContent,
    { tags: li.querySelector('.row-tags')?.textContent ?? null, when: li.querySelector('.when').textContent, line: li.querySelector('.when').scrollHeight <= li.querySelector('.when').clientHeight + 2 }])));
  {
    const r = await rowTags();
    if (r['Training 2026']?.tags !== '#gym #training' || r['Leg day']?.tags !== '#gym/legs' || !r['Training 2026'].when.includes(' · #gym')
      || Object.values(r).some((x) => !x.line)) throw new Error(`rows' tags: ${JSON.stringify(r)}`);
  }
  await s(A, '24-tags-1-sidebar');
  // Picking #gym: the notes tagged #gym, its chip pressed; not Leg day, tagged #gym/legs (#539:
  // a tag is a word, not a folder).
  await pickTag(A, 'gym');
  {
    const gym = await listed(A);
    const c = await chips(A);
    if (gym.join() !== 'Training 2026' || c.all !== 'false' || c.top.join() !== 'gym*,gym/legs,training') throw new Error(`#gym picked: ${JSON.stringify({ gym, c })}`);
    // (#gym isn't said again on its notes' rows: only their other tags.)
    const r = await rowTags();
    if (r['Training 2026']?.tags !== '#training') throw new Error(`rows' tags with #gym picked: ${JSON.stringify(r)}`);
  }
  await s(A, '24-tags-2-picked');
  // #gym/legs: its notes; picked again, every note.
  await pickTag(A, 'gym/legs');
  if ((await listed(A)).join() !== 'Leg day') throw new Error(`#gym/legs's notes: ${await listed(A)}`);
  await A.click('#tag-chips .tag-chip[data-tag="gym/legs"]');
  await until(A, () => !document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]'));
  if ((await listed(A)).length <= 2) throw new Error('a tag picked again should list every note');
  await pickTag(A, 'gym');
  await allNotes(A);
  await until(A, () => !document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]'));
  if ((await listed(A)).length <= 2) throw new Error('All should list them all again');

  // The header (#581): the title and the tags as badges; the block's lines not in the editor.
  await openNote(A, 'Training 2026');
  {
    const h = await head(A);
    const shownText = await A.evaluate(() => (document.querySelector('#editor .cm-content') ?? document.querySelector('#editor textarea')).textContent || document.querySelector('#editor textarea')?.value);
    if (!h.shown || h.title !== 'Training 2026' || h.tags !== 'gym,training' || /tags:|---/.test(shownText)) throw new Error(`the note's header: ${JSON.stringify({ h, shownText })}`);
    const sizes = await A.evaluate(() => [...document.querySelectorAll('#note-head .head-tag button, #note-head-add')].map((b) => b.offsetHeight));
    if (mobile(A) && sizes.some((x) => x < 32 || x > 36)) throw new Error(`a phone's header buttons: 32 px, a finger's without towering: ${sizes}`);
  }
  await s(A, '24-tags-3-header');
  // × on #training: off the note (its block), its chip gone.
  await A.click('#note-head-tags .head-tag-x[data-tag="training"]');
  await until(A, () => !document.getElementById('editor').noteText().includes('training'), undefined, 5000)
    .catch(async () => { throw new Error(`× should take #training out of the block: ${await A.evaluate(() => document.getElementById('editor').noteText())}`); });
  await backToList(A);
  await until(A, () => !document.querySelector('#tag-chips .tag-chip[data-tag="training"]'), undefined, 10000)
    .catch(() => { throw new Error('a tag no note has should leave the chips'); });
  // + tag: the picker, your tags this note hasn't, with their notes; typed "gy", #gym first; Enter puts it on.
  await openNote(A, 'Leg day');
  await A.click('#note-head-add');
  await until(A, () => !document.getElementById('tag-picker').hidden && document.activeElement?.id === 'tag-picker-input');
  await A.keyboard.type('gy');
  const offered = await A.evaluate(() => [...document.querySelectorAll('#tag-picker-list li')].map((li) => `${li.textContent}${li.classList.contains('on') ? '*' : ''}`));
  if (offered[0] !== '#gym1*') throw new Error(`the picker, "gy" typed: ${JSON.stringify(offered)}`);
  await s(A, '24-tags-4-picker');
  await A.focus('#tag-picker-input'); // (the screenshot may have taken the focus)
  await A.keyboard.press('Enter');
  await until(A, () => /^---\ntitle: Leg day\ntags: \[gym\/legs, gym\]\n---\n/.test(document.getElementById('editor').noteText()), undefined, 5000)
    .catch(async () => { throw new Error(`Enter should put #gym on, in the block: ${JSON.stringify(await A.evaluate(() => document.getElementById('editor').noteText()))}`); });
  // A new one, typed whole: "New tag #stretching".
  await A.keyboard.type('Stretching');
  if (!(await A.evaluate(() => [...document.querySelectorAll('#tag-picker-list li')].some((li) => li.textContent === 'New tag #stretching')))) throw new Error('a tag no note has yet: offered as new');
  await A.keyboard.press('Escape');
  await until(A, () => document.getElementById('tag-picker').hidden);
  // (#gym off again, as × does: the flows after this one count the chips.)
  await A.click('#note-head-tags .head-tag-x[data-tag="gym"]');
  await until(A, () => (document.getElementById('note-head-tags').textContent.match(/#/g) ?? []).length === 1);
  // yaml ›: the block itself, in the editor; ‹ fold, gone again.
  await A.click('#note-head-yaml');
  await until(A, () => document.getElementById('note-head-yaml').getAttribute('aria-pressed') === 'true'
    && /tags: \[gym\/legs\]/.test((document.querySelector('#editor .cm-content') ?? {}).textContent ?? document.querySelector('#editor textarea')?.value ?? ''), undefined, 5000)
    .catch(async () => { throw new Error(`yaml › should show the block in the editor: ${await A.evaluate(() => document.querySelector('#editor textarea')?.value ?? document.querySelector('#editor .cm-content').textContent)}`); });
  await s(A, '24-tags-5-yaml');
  await A.click('#note-head-yaml');
  await until(A, () => !/tags:/.test(document.querySelector('#editor textarea')?.value ?? document.querySelector('#editor .cm-content').textContent));
  // On the page: the header over it, a `#word` in the text plain text (no tag), code as code; a
  // badge tapped, its notes in the list.
  await openNote(A, 'Leg day', { edit: false });
  await setView(A, 'preview');
  {
    const page = await A.evaluate(() => ({ tags: document.querySelectorAll('#reading .tag').length, text: document.getElementById('reading').textContent, code: document.querySelector('#reading code')?.textContent,
      yaml: document.getElementById('note-head-yaml').getClientRects().length > 0 })); // (yaml › is the editor's: not over Preview)
    const h = await head(A);
    if (page.tags || page.yaml ||!page.text.includes('#notatag') || /---|tags:/.test(page.text) || page.code !== '#code' || !h.shown || h.tags !== 'gym/legs') {
      throw new Error(`the page: ${JSON.stringify({ page, h })}`);
    }
  }
  await s(A, '24-tags-6-page');
  await A.click('#note-head-tags .head-tag-name[data-tag="gym/legs"]');
  await until(A, () => document.querySelector('#tag-chips .tag-chip[data-tag="gym/legs"]')?.getAttribute('aria-pressed') === 'true');
  if (mobile(A)) await until(A, () => !document.querySelector('.notes').classList.contains('editing'))
    .catch(() => { throw new Error('on a phone, a badge tapped should show its notes: the list'); });
  await allNotes(A);
  await setView(A, 'edit').catch(() => {});
  // The other device: the same tags (they're in the note list).
  // (B, when it's still in this vault: all flows run, flow 7 has forgotten it.)
  await B.bringToFront();
  const inVault = await until(B, () => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === 'Leg day'), undefined, 20000).then(() => true, () => false);
  if (inVault) {
    await backToList(B);
    await until(B, () => [...document.querySelectorAll('#tag-chips .tag-chip')].map((b) => b.dataset.tag).sort().join() === 'gym,gym/legs', undefined, 20000)
      .catch(async () => { throw new Error(`B's chips: ${JSON.stringify(await chips(B))}`); });
  } else console.log('  (B is no longer in this vault: the other device not checked)');
  await A.bringToFront();
  await backToList(A);
  // More tags than fit on a line (#549): one row still, that scrolls sideways (the notes don't move
  // down), faded at its edge; a tag far along it, picked, comes first with its ×; tapped again,
  // every note, the row in its order. A wheel (a computer's) scrolls it sideways.
  const many = Array.from({ length: 12 }, (_, i) => `topic${String(i + 1).padStart(2, '0')}`);
  await write(withFrontmatter('Topics', many, ''));
  // Its header: the tags on one line that scrolls sideways, faded at its end; + tag after them, in sight.
  await until(A, () => document.querySelectorAll('#note-head-tags .head-tag').length === 12);
  {
    const h = await A.evaluate(() => {
      const row = document.getElementById('note-head-tags');
      const add = document.getElementById('note-head-add').getBoundingClientRect();
      const head = document.getElementById('note-head').getBoundingClientRect();
      const tops = new Set([...row.querySelectorAll('.head-tag')].map((t) => Math.round(t.getBoundingClientRect().top)));
      return { lines: tops.size, scrolls: row.scrollWidth > row.clientWidth, fade: row.classList.contains('more-right'),
        addInSight: add.left >= head.left && add.right <= head.right + 1 && add.width > 0, addLine: Math.abs(add.top - [...tops][0]) < add.height };
    });
    if (h.lines !== 1 || !h.scrolls || !h.fade || !h.addInSight || !h.addLine) throw new Error(`the header's tags, more than fit: one line that scrolls, + tag in sight: ${JSON.stringify(h)}`);
  }
  await s(A, '24-tags-6b-header-many');
  await backToList(A);
  await until(A, () => document.querySelectorAll('#tag-chips .tag-chip').length === 14, undefined, 10000)
    .catch(async () => { throw new Error(`12 more tags: ${JSON.stringify(await chips(A))}`); });
  const line = () => A.evaluate(() => {
    const row = document.getElementById('chip-row');
    const all = [...row.querySelectorAll('.chip')];
    const first = all[0];
    return { rows: new Set(all.map((b) => Math.round(b.offsetTop))).size, scrolls: row.scrollWidth > row.clientWidth, left: Math.round(row.scrollLeft),
      fade: [row.classList.contains('more-left'), row.classList.contains('more-right')].join(), first: first?.dataset.tag,
      firstPressed: first?.getAttribute('aria-pressed') === 'true', clear: Boolean(first?.querySelector('.clear')), all: Boolean(document.getElementById('chip-all')) };
  });
  {
    const l = await line();
    if (l.rows !== 1 || !l.scrolls || l.fade !== 'false,true' || l.all) throw new Error(`one row of chips, scrolling sideways, faded at its end, no All: ${JSON.stringify(l)}`);
    await s(A, '24-tags-7-more');
    if (!mobile(A)) {
      const box = await (await A.$('#chip-row')).boundingBox();
      await A.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await A.mouse.wheel({ deltaY: 200 });
      await until(A, () => document.getElementById('chip-row').scrollLeft > 0 && document.getElementById('chip-row').classList.contains('more-left'), undefined, 3000)
        .catch(async () => { throw new Error(`a wheel over the row: sideways: ${JSON.stringify(await line())}`); });
    }
  }
  await pickTag(A, 'topic12');
  {
    const l = await line();
    if (l.first !== 'topic12' || !l.firstPressed || !l.clear || l.left !== 0 || (await listed(A)).join() !== 'Topics') throw new Error(`a tag far along the row, picked: first, with ×: ${JSON.stringify(l)}`);
    await s(A, '24-tags-8-picked-far');
  }
  await A.click('#tag-chips .tag-chip[data-tag="topic12"]');
  // (Topics' tags the most recently used: the row starts with them, by name.)
  await until(A, () => !document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]') && document.querySelector('#tag-chips .tag-chip').dataset.tag === 'topic01')
    .catch(async () => { throw new Error(`the tag picked, tapped again: every note, the row in its order: ${JSON.stringify(await line())}`); });
  // A phone (#592): the header scrolls away with the text, as much as the text does; the bar's
  // small title only once the big one is gone; a tap on it, back to the top.
  if (mobile(A)) {
    const lines = Array.from({ length: 80 }, (_, i) => `Set ${i + 1}: 5 reps`).join('\n');
    await write(withFrontmatter('Long log', ['gym'], lines));
    await A.evaluate(() => document.activeElement?.blur?.());
    const at = () => A.evaluate(() => {
      const s = document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller');
      return { scroll: Math.round(s.scrollTop), head: Math.round(document.getElementById('note-head').getBoundingClientRect().top),
        barTitle: getComputedStyle(document.getElementById('note-title')).opacity };
    });
    await until(A, () => document.getElementById('note-head-title').value === 'Long log');
    await new Promise((r) => setTimeout(r, 300));
    const top = await at();
    if (top.scroll !== 0 || top.barTitle !== '0') throw new Error(`a phone's note at its top: the big title, not the bar's: ${JSON.stringify(top)}`);
    await A.evaluate(() => { (document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller')).scrollTop = 200; });
    await new Promise((r) => setTimeout(r, 400));
    const down = await at();
    if (Math.abs(top.head - down.head - down.scroll) > 1 || down.barTitle !== '1') throw new Error(`scrolled: the header up as far as the text, the bar's title in: ${JSON.stringify({ top, down })}`);
    await s(A, '24-tags-9-phone-scrolled');
    await A.tap('#note-title');
    await until(A, () => (document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller')).scrollTop === 0, undefined, 3000)
      .catch(async () => { throw new Error(`a tap on the bar's title: back to the top: ${JSON.stringify(await at())}`); });
    await backToList(A);
  }
  // (That note, and its tags, out of the way of the flows after this one: deleted.)
  await allNotes(A);
  await backToList(A);
  const topics = await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].find((li) => li.querySelector('.title').textContent === 'Topics').dataset.id);
  await rowMenu(A, `#note-list li[data-id="${topics}"]`);
  await A.click('#note-menu-delete');
  await until(A, () => document.querySelectorAll('#tag-chips .tag-chip').length === 2 && !document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]'), undefined, 10000);
  await A.evaluate(() => (document.getElementById('toast').hidden = true));
  // A new tag while the pointer rests on the note list (#442): no chip slides in under it,
  // moving the others; the chips catch up once the pointer leaves the sidebar. (Written here, with
  // the mouse over the list: the same as a tag arriving from another device.)
  if (!mobile(A)) {
    await newBlankNote(A);
    const row = await (await A.$('#note-list li[data-id] button')).boundingBox();
    await A.mouse.move(row.x + 30, row.y + row.height / 2);
    const gymX = () => A.evaluate(() => Math.round(document.querySelector('#tag-chips .tag-chip[data-tag="gym"]').getBoundingClientRect().left));
    const before = await gymX();
    await A.evaluate((t) => document.getElementById('editor').noteYText().insert(0, t), withFrontmatter('Books to read', ['books'], ''));
    // (Moving over the list meanwhile, as a hand about to click does.)
    const rowShows = () => A.evaluate(() => [...document.querySelectorAll('#note-list .row-tags')].some((e) => e.textContent.includes('#books')));
    for (let i = 0; !(await rowShows()); i++) {
      if (i > 60) throw new Error('the new note\'s row should show #books');
      await A.mouse.move(row.x + 30 + (i % 2) * 4, row.y + row.height / 2);
      await new Promise((r) => setTimeout(r, 250));
    }
    const held = await A.evaluate(() => [...document.querySelectorAll('#tag-chips .tag-chip')].map((b) => b.dataset.tag));
    if (held.includes('books')) throw new Error(`with the pointer on the list, no chip should come in yet: ${held}`);
    if ((await gymX()) !== before) throw new Error(`the chips moved under the pointer: ${before} → ${await gymX()}`);
    // The pointer leaves the sidebar (to the note): the chips catch up.
    const editor = await (await A.$('#editor')).boundingBox();
    await A.mouse.move(editor.x + editor.width / 2, editor.y + editor.height / 2);
    await until(A, () => [...document.querySelectorAll('#tag-chips .tag-chip')].map((b) => b.dataset.tag).join() === 'books,gym/legs,gym', undefined, 10000)
      .catch(() => { throw new Error('once the pointer left the sidebar, #books should be a chip'); });
    await backToList(A);
  }
}
