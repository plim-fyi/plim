import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backToList, closeSettings, OUT, openSettings, rowMenu, s, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 34: Export. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow34(shared) {
  const { A, profile } = shared;
  // 34. Export (#47): Settings → Account → Export all notes saves one zip, a Markdown file a note
  // (Recently deleted's in deleted/), each its text with created, updated and id in its frontmatter;
  // a note's menu → Download saves that note's file, the same as in the zip.
  await A.bringToFront();
  await backToList(A);
  const dir = join(OUT, `../downloads-${profile}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // (Each device is a browser context of its own: downloads allowed in A's.)
  const cdp = await A.browser().target().createCDPSession();
  const browserContextId = A.browserContext().id;
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId });
  /** The file a download saved, once it's whole. */
  const saved = async (match) => {
    for (let i = 0; i < 100; i++) {
      const f = readdirSync(dir).find((n) => match.test(n) && !n.endsWith('.crdownload'));
      if (f) return join(dir, f);
      await wait(100);
    }
    throw new Error(`no download matching ${match}: ${readdirSync(dir).join(', ')}`);
  };
  // (One note in Recently deleted, for deleted/: the list's last.)
  const gone = await A.$$eval('#note-list li[data-id]', (lis) => ({ id: lis.at(-1).dataset.id, title: lis.at(-1).querySelector('.title').textContent }));
  await rowMenu(A, `#note-list li[data-id="${gone.id}"]`);
  await A.click('#note-menu-delete');
  await until(A, (id) => !document.querySelector(`#note-list li[data-id="${id}"]`), gone.id);
  const listed = await A.evaluate(() => ({
    titles: [...document.querySelectorAll('#note-list li[data-id] .title')].map((t) => t.textContent),
    deleted: Number(document.getElementById('trash-count')?.textContent || 0),
  }));

  await openSettings(A, 'account');
  await s(A, '34-export-1-settings');
  await A.click('#settings-export');
  await until(A, () => /^Exported/.test(document.getElementById('settings-export-status').textContent), undefined, 30000);
  const status = await A.$eval('#settings-export-status', (e) => e.textContent);
  await s(A, '34-export-2-exported');
  const zip = await saved(/^plim-notes-\d{4}-\d\d-\d\d\.zip$/);
  // (Read back with unzip, as anyone would: it checks every file's CRC too.)
  execFileSync('unzip', ['-tq', zip]);
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const file = (name) => execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8' });
  const kept = names.filter((n) => !n.startsWith('deleted/'));
  if (status !== `Exported ${names.length} ${names.length === 1 ? 'note' : 'notes'}.`) throw new Error(`export said "${status}" for ${names.length} files`);
  if (!names.every((n) => n.endsWith('.md')) || new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new Error(`the zip's files: ${names.join(', ')}`);
  // Every note in the list has its file (titles, made safe as file names, may differ: by count, then the plain ones by name).
  if (kept.length < listed.titles.length) throw new Error(`${listed.titles.length} notes listed, ${kept.length} files: ${kept.join(', ')}`);
  const plain = listed.titles.filter((t) => /^[\w ,.'-]+$/.test(t) && !/^\.|\.$/.test(t));
  const missing = plain.filter((t) => !kept.some((n) => n === `${t}.md` || n.startsWith(`${t} (`)));
  if (missing.length) throw new Error(`no file for ${missing.join(', ')}: ${kept.join(', ')}`);
  const inDeleted = names.filter((n) => n.startsWith('deleted/'));
  if (!inDeleted.some((n) => file(n).includes(`\nid: ${gone.id}\n`))) throw new Error(`${gone.title}, deleted, isn't in deleted/: ${names.join(', ')}`);
  if (kept.some((n) => file(n).includes(`\nid: ${gone.id}\n`))) throw new Error(`${gone.title}, deleted, is with the notes too`);
  // Each file: the note's text, with its dates and id in its frontmatter.
  for (const n of names) {
    const text = file(n);
    if (!/^---\n[\s\S]*?\nid: [0-9a-f-]{8,}\n[\s\S]*?---\n/.test(text) || !/\ncreated: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n/.test(text)) {
      throw new Error(`${n}: no id and dates in its frontmatter: ${JSON.stringify(text.slice(0, 200))}`);
    }
  }
  await closeSettings(A);

  // One note, from its menu: the same file as in the zip.
  await backToList(A);
  const first = await A.$eval('#note-list li[data-id]', (li) => ({ id: li.dataset.id, title: li.querySelector('.title').textContent }));
  const inZip = names.find((n) => file(n).includes(`\nid: ${first.id}\n`));
  if (!inZip) throw new Error(`the zip has no file for ${first.title} (${first.id})`);
  await rowMenu(A, `#note-list li[data-id="${first.id}"]`);
  await s(A, '34-export-3-note-menu', { focused: true });
  await A.click('#note-menu-download');
  const one = await saved(/\.md$/);
  if (!one.endsWith(`/${inZip}`)) throw new Error(`Download saved ${one}, the zip has ${inZip}`);
  const got = readFileSync(one, 'utf8'), want = file(inZip);
  // (Its "updated" can be later than the zip's if the note was saved between the two.)
  const sansUpdated = (t) => t.replace(/\nupdated: .*\n/, '\n');
  if (sansUpdated(got) !== sansUpdated(want)) throw new Error(`Download and the zip differ for ${inZip}:\n${got}\n---\n${want}`);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', browserContextId });
  await cdp.detach();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  console.log(`  export: ${names.length} files (${names.length - kept.length} in deleted/), and ${inZip} by itself`);
}
