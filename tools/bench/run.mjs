// node tools/bench/run.mjs — the note index at 100…10,000 notes (#262), in Node.
import { all } from './index-bench.mjs';

const kb = (b) => `${(b / 1024).toFixed(1)} KiB`;
console.log('notes  edits/note  state     blob      one edit  encode  encrypt  decrypt  apply   list    build');
await all(undefined, (r) => {
  console.log(
    [String(r.notes).padStart(5), String(r.edits).padStart(10), kb(r.stateBytes).padStart(9), kb(r.blobBytes).padStart(9),
      `${r.oneEditBytes} B`.padStart(9), `${r.encodeMs}`.padStart(7), `${r.encryptMs}`.padStart(8), `${r.decryptMs}`.padStart(8),
      `${r.applyMs}`.padStart(7), `${r.listMs}`.padStart(7), `${r.buildMs}`.padStart(7)].join(' '),
  );
});
console.log('(times in ms)');
