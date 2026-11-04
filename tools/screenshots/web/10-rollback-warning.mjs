import { lock, openNote, s, server, typeAtEnd, unlockWithPasskey, until } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Flow 10: Rollback warning. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow10(shared) {
  const { B } = shared;
  // 10. Rollback warning: B saves an edit (A never sees it), then the server loses it
  await openNote(B, 'Groceries');
  await typeAtEnd(B, '\n- coffee beans');
  await until(B, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
  await wait(1500);
  {
    const db = new DatabaseSync(server.db);
    const row = db.prepare("SELECT rowid AS id FROM updates WHERE doc_id != 'index' ORDER BY rowid DESC LIMIT 1").get();
    db.prepare('DELETE FROM updates WHERE rowid = ?').run(row.id);
    db.close();
  }
  await lock(B);
  await unlockWithPasskey(B);
  await openNote(B, 'Groceries');
  await until(B, () => !document.querySelector('#rollback-banner').hidden, undefined, 20000);
  await s(B, '10-rollback-1-warning');
  await B.click('#rollback-ack');
}
