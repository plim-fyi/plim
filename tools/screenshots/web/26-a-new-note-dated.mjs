import { allNotes, backToList, EDITOR_READY, expectShifts, freshAuthMinute, mobile, NEW_NOTE, newBlankNote, openNote, pickTag, shot, unlockWithPasskey, until, waitView } from './harness.mjs';
import { withFrontmatter } from './24-tags.mjs';
import { wait } from '../server.mjs';

/** Flow 26: A new note, dated. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow26(shared) {
  const { A } = shared;
  // 26. A new note, dated (#313, #584): its title the date and time, in its frontmatter; a computer
  // puts you in the title, the date selected, to rename it (a phone: in the text, where the
  // keyboard goes); Enter there, the text. With a tag picked in the sidebar, that tag in its
  // block, the note in the list you're looking at.
  await A.bringToFront();
  const STAMP = /^\d{4}-\d\d-\d\d \d{1,2}:\d\d [AP]M$/;
  const state = () => A.evaluate(() => ({
    text: document.getElementById('editor').noteText(), cursor: document.getElementById('editor').cursorPos(),
    head: document.getElementById('note-title').textContent, focus: document.activeElement?.id || document.activeElement?.className,
    title: document.getElementById('note-head-title').value,
    selected: (() => { const t = document.getElementById('note-head-title'); return t.value.slice(t.selectionStart, t.selectionEnd); })(),
    listed: [...document.querySelectorAll('#note-list li[data-id] .title')].map((e) => e.textContent),
  }));
  const titled = (text) => text.match(/^---\ntitle: (.*)\n/)?.[1];
  await backToList(A);
  await A.click(NEW_NOTE(A));
  await until(A, EDITOR_READY);
  await until(A, () => document.getElementById('editor').noteText() !== '', undefined, 5000);
  let st = await state();
  let first = titled(st.text);
  if (!STAMP.test(first ?? '') || st.text !== `---\ntitle: ${first}\n---\n` || st.title !== first) throw new Error(`a new note: the date as its title, in its block: ${JSON.stringify(st)}`);
  if (st.head !== first || st.listed[0] !== first) throw new Error(`a new note's title is its date: ${JSON.stringify(st)}`);
  if (mobile(A) ? st.focus === 'note-head-title' : st.focus !== 'note-head-title' || st.selected !== first) throw new Error(`a new note's focus: ${JSON.stringify(st)}`);
  // Nothing to scroll in a new note: no room after its end until it's taller than the view.
  await until(A, () => {
    const s = document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller');
    return document.getElementById('editor').classList.contains('short') && s.scrollHeight <= s.clientHeight + 1;
  }, undefined, 3000).catch(async () => { throw new Error(`a new note shouldn't scroll: ${JSON.stringify(await A.evaluate(() => { const s = document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller'); return { scroll: s.scrollHeight, client: s.clientHeight, short: document.getElementById('editor').classList.contains('short') }; }))}`); });
  await shot(A, '26-dated-1-new-note', { focused: true });
  if (!mobile(A)) {
    // Renamed as typed (the date selected: replaced), in the block and the list; Enter: the text.
    await A.keyboard.type('Dentist');
    await until(A, () => document.getElementById('editor').noteText() === '---\ntitle: Dentist\n---\n'
      && document.querySelector('#note-list li[data-id] .title')?.textContent === 'Dentist', undefined, 5000)
      .catch(async () => { throw new Error(`the title, typed: ${JSON.stringify(await state())}`); });
    first = 'Dentist';
    await A.keyboard.press('Enter');
    await until(A, () => Boolean(document.activeElement?.closest('#editor')));
  }
  // Typing: the body, after the block; the title as it was. (Undo takes back the typing, not the title.)
  await A.keyboard.type('Called the dentist about Tuesday.');
  if (!mobile(A)) {
    for (let i = 0; i < 2; i++) {
      await A.keyboard.down('Control');
      await A.keyboard.press('z');
      await A.keyboard.up('Control');
      await wait(200);
    }
    st = await state();
    if (st.text !== `---\ntitle: ${first}\n---\n`) throw new Error(`undo takes back the typing, not the title: ${JSON.stringify(st.text)}`);
    await A.keyboard.type('Called the dentist about Tuesday.');
  }
  st = await state();
  if (st.text !== `---\ntitle: ${first}\n---\nCalled the dentist about Tuesday.` || st.head !== first) throw new Error(`typed into a new note: ${JSON.stringify(st)}`);
  // A tag picked in the sidebar: a new note has it, in its block, and is in its list.
  await newBlankNote(A);
  await A.evaluate((t) => document.getElementById('editor').noteYText().insert(0, t), withFrontmatter('Gym log', ['gym'], 'Squat 135 × 12'));
  await backToList(A);
  await pickTag(A, 'gym');
  await A.click(NEW_NOTE(A));
  await until(A, EDITOR_READY);
  await until(A, () => document.getElementById('editor').noteText() !== '', undefined, 5000);
  st = await state();
  first = titled(st.text);
  if (!STAMP.test(first ?? '') || st.text !== `---\ntitle: ${first}\ntags: [gym]\n---\n`) throw new Error(`a new note with #gym picked: ${JSON.stringify(st)}`);
  await backToList(A);
  await until(A, (t) => document.querySelector('#tag-chips .tag-chip[data-tag="gym"]')?.getAttribute('aria-pressed') === 'true' && [...document.querySelectorAll('#note-list li[data-id] .title')].some((e) => e.textContent === t), first, 5000)
    .catch(async () => { throw new Error(`the new note should be in #gym's list: ${JSON.stringify(await state())}`); });
  await shot(A, '26-dated-2-tagged');
  await allNotes(A);
  await until(A, () => !document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]'));

  // Notes from before frontmatter (#582): with the mark taken out of the note list (as it was
  // before), a note written the old way; on the next unlock it's moved: its first line its title,
  // every tag it had its tags, the line of tags out of its text, a #word in a sentence left as
  // text; the note as it was kept as a version; the mark set again.
  await newBlankNote(A);
  await A.evaluate(async () => {
    const { state } = await import(new URL('ui/shared.js', document.querySelector('script[type=module]').src));
    state.index.ydoc.getMap('format').delete('frontmatter');
    document.getElementById('editor').noteYText().insert(0, 'Old note\n#old #gym\n\nWritten before, #inline here.');
  });
  await until(A, () => document.getElementById('save-status').dataset.state === 'saved', undefined, 20000);
  await wait(1500); // (its tags, read from its text the old way, into the list)
  await freshAuthMinute();
  await A.reload();
  await waitView(A, 'view-locked');
  await unlockWithPasskey(A);
  expectShifts(A, 30000); // (the open note, moved: its header comes in, once)
  await until(A, async () => {
    const { state } = await import(new URL('ui/shared.js', document.querySelector('script[type=module]').src));
    return state.index?.ydoc.getMap('format').get('frontmatter') === true;
  }, undefined, 30000).catch(() => { throw new Error('your notes should be moved to frontmatter on unlock, the mark set'); });
  await wait(1000);
  expectShifts(A, 0);
  await openNote(A, 'Old note');
  const moved = await A.evaluate(() => document.getElementById('editor').noteText());
  if (moved !== '---\ntitle: Old note\ntags: [gym, inline, old]\n---\nWritten before, #inline here.') throw new Error(`an old note, moved: ${JSON.stringify(moved)}`);
  const row = await A.evaluate(() => [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === 'Old note')?.querySelector('.row-tags')?.textContent);
  if (!(mobile(A) ? /^#gym #inline/ : /^#gym #inline #old$/).test(row ?? '')) throw new Error(`an old note's tags, moved: ${row}`);
  await shot(A, '26-dated-3-moved');
}
