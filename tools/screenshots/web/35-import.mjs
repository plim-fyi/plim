import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipFiles } from '../../../web/core/export.js';
import { backToList, closeSettings, OUT, openSettings, s, until } from './harness.mjs';

/** Flow 35: Import. `shared`: what one flow leaves for the next (web.mjs); flow 34's zip. */
export default async function flow35(shared) {
  const { A, profile } = shared;
  // 35. Import (g87d): Settings → Account → Import notes. Flow 34's export, brought back: every
  // note is here already, so nothing comes in twice. Then a vault from elsewhere, in a zip: its
  // notes listed, titled from their names or headings, its folders their tags, a picture left out.
  await A.bringToFront();
  await backToList(A);
  const dir = join(OUT, `../import-${profile}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const status = () => A.$eval('#settings-import-status', (e) => e.textContent);
  const pick = async (path) => {
    const input = await A.$('#settings-import-files');
    await input.uploadFile(path);
  };

  await openSettings(A, 'account');
  if (shared.exportZip) {
    const back = join(dir, 'plim-notes.zip');
    writeFileSync(back, shared.exportZip.bytes);
    await pick(back);
    await until(A, () => /^Nothing to import/.test(document.getElementById('settings-import-status').textContent), undefined, 15000);
    const said = await status();
    const n = shared.exportZip.count;
    if (!said.includes(`${n} ${n === 1 ? 'note' : 'notes'} here already`)) throw new Error(`re-importing the export said "${said}" (${n} files)`);
    if (!(await A.$eval('#settings-import-confirm', (e) => e.hidden))) throw new Error('nothing to import, yet Import is offered');
  }

  const vault = join(dir, 'Vault.zip');
  writeFileSync(vault, zipFiles([
    { path: 'Vault/Ideas.md', text: 'A thought about #reading/books here.\n', time: Date.parse('2025-03-04T05:06:07Z') },
    { path: 'Vault/Work/Clients/Acme.md', text: '# Acme kickoff\n\n- [ ] Send the contract\n![[diagram.png]]\n' },
    { path: 'Vault/Work/diagram.png', text: 'not really a png' },
    { path: 'Vault/.obsidian/workspace.md', text: '{}' },
  ]));
  await pick(vault);
  await until(A, () => !document.getElementById('settings-import-confirm').hidden, undefined, 15000);
  const plan = await status();
  if (!/^2 notes to import\./.test(plan) || !/1 note shows pictures/.test(plan) || /Left out/.test(plan)) throw new Error(`the plan said "${plan}"`);
  await s(A, '35-import-1-plan');
  await A.click('#settings-import-go');
  await until(A, () => /^Imported/.test(document.getElementById('settings-import-status').textContent), undefined, 30000);
  const done = await status();
  if (!/^Imported 2 notes\./.test(done) || /saved on this device/.test(done)) throw new Error(`the import said "${done}"`);
  await s(A, '35-import-2-done');
  await closeSettings(A);

  await backToList(A);
  // (Both dated now, so at the list's top: a long list shows only its first rows.)
  const rows = await A.$$eval('#note-list li[data-id]', (lis) => lis.slice(0, 2).map((li) => ({
    title: li.querySelector('.title').textContent, tags: li.querySelector('.row-tags')?.textContent ?? '',
  })));
  // (Titled from its name, its #tag its tag; titled from its heading, its folders its tag.)
  for (const [title, tag] of [['Ideas', '#reading/books'], ['Acme kickoff', '#work/clients']]) {
    const r = rows.find((x) => x.title === title);
    if (!r || r.tags !== tag) throw new Error(`no note ${title} tagged ${tag}: ${JSON.stringify(rows)}`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`  import: the export back (all here already), then 2 notes from a vault`);
}
