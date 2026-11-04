import { backToList, mobile, newBlankNote, shot, until } from './harness.mjs';
import { withFrontmatter } from './24-tags.mjs';
import { wait } from '../server.mjs';

/** Flow 27: The tag picker. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow27(shared) {
  const { A } = shared;
  // 27. The tag picker (#313, #581): "+ tag" in a note's header offers the tags you use, most used
  // first, with how many notes each; what's typed narrows them (lift/: those under it); Enter, Tab
  // or a tap puts one on, in the note's block; Escape closes it. A `#l` typed in the text opens no
  // list and is no tag (#584: a #word is text).
  await A.bringToFront();
  const phone = mobile(A);
  const picker = () => A.evaluate(() => ({
    open: !document.getElementById('tag-picker').hidden,
    options: [...document.querySelectorAll('#tag-picker-list li')].map((li) => `${li.querySelector('.tp-name').textContent}${li.querySelector('.tp-n') ? ` ${li.querySelector('.tp-n').textContent}` : ''}${li.classList.contains('on') ? '*' : ''}`),
  }));
  const tags = () => A.evaluate(() => document.getElementById('editor').noteText().match(/^---\n(?:.*\n)*?tags: \[(.*)\]\n/)?.[1] ?? '');
  const write = async (text) => {
    await newBlankNote(A);
    await A.evaluate((t) => document.getElementById('editor').noteYText().insert(0, t), text);
  };
  await write(withFrontmatter('Squats', ['lift', 'lift/legs'], ''));
  await write(withFrontmatter('Bench', ['lift'], ''));
  await write(withFrontmatter('Tomatoes', ['lawn'], ''));
  await backToList(A);
  await until(A, () => ['lift', 'lawn'].every((t) => document.querySelector(`#tag-chips .tag-chip[data-tag="${t}"]`)), undefined, 10000);
  await write(withFrontmatter('Leg day', [], ''));
  // A #word in the text: no list, no tag.
  await A.keyboard.type('Felt good #l');
  await wait(1600);
  if (await A.evaluate(() => Boolean(document.querySelector('#editor .slash-menu:not([hidden])')))) throw new Error('#l in the text: no list of tags (#584)');
  if (await A.evaluate(() => Boolean(document.querySelector('#tag-chips .tag-chip[data-tag="l"]')))) throw new Error('#l in the text is no tag (#584)');
  // + tag: yours, most used first.
  await A.click('#note-head-add');
  await until(A, () => !document.getElementById('tag-picker').hidden);
  let p = await picker();
  const counts = p.options.map((o) => Number(o.match(/ (\d+)\*?$/)?.[1]));
  if (!p.options.some((o) => o.startsWith('#lift 2')) || counts.some((n, i) => i && n > counts[i - 1]) || !p.options[0].endsWith('*')) throw new Error(`the picker, opened: the most used first: ${JSON.stringify(p)}`);
  await A.keyboard.type('l');
  p = await picker();
  if (p.options.slice(0, 3).join() !== '#lift 2*,#lawn 1,#lift/legs 1') throw new Error(`"l" typed: ${JSON.stringify(p)}`);
  await shot(A, '27-tags-1-suggested', { focused: true });
  if (phone) await A.tap('#tag-picker-list li:first-child');
  else {
    await A.focus('#tag-picker-input');
    await A.keyboard.press('Enter');
  }
  await until(A, () => /tags: \[lift\]/.test(document.getElementById('editor').noteText()), undefined, 5000)
    .catch(async () => { throw new Error(`#lift picked: ${JSON.stringify(await tags())}`); });
  // Under a tag: lift/ offers lift/legs.
  await A.focus('#tag-picker-input');
  await A.keyboard.type('lift/');
  p = await picker();
  if (p.options.join() !== '#lift/legs 1*') throw new Error(`lift/: ${JSON.stringify(p)}`);
  if (phone) await A.tap('#tag-picker-list li:first-child');
  else await A.keyboard.press('Enter');
  await until(A, () => /tags: \[lift, lift\/legs\]/.test(document.getElementById('editor').noteText()), undefined, 5000)
    .catch(async () => { throw new Error(`#lift/legs picked: ${JSON.stringify(await tags())}`); });
  // Escape: closed, the button focused again.
  await A.focus('#tag-picker-input');
  await A.keyboard.press('Escape');
  await until(A, () => document.getElementById('tag-picker').hidden && document.activeElement?.id === 'note-head-add', undefined, 3000)
    .catch(async () => { throw new Error(`Escape: ${JSON.stringify(await picker())}`); });
  await until(A, () => document.getElementById('save-status').dataset.state === 'saved', undefined, 20000);
  await backToList(A);
  await until(A, () => [...document.querySelectorAll('#note-list li')].some((li) => li.querySelector('.title')?.textContent === 'Leg day' && li.querySelector('.row-tags')?.textContent === '#lift #lift/legs'), undefined, 10000)
    .catch(async () => { throw new Error(`Leg day's tags in the list: ${await A.evaluate(() => [...document.querySelectorAll('#note-list li')].map((li) => li.textContent).join(' | '))}`); });
}
