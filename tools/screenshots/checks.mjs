// The standalone checks, all at once (#458): what the flows don't cover (recover.mjs: out of
// date, a script or a note that fails; share-stress.mjs: a shared note under load and offline;
// live-resilience.mjs: live sync through an expired session and a dropped connection). Each
// runs its own server on its own ports, so they run side by side: about 4 minutes, the
// slowest's time. Fails if any does; a failing one's output is printed in full.
//
//   cargo build --release && cd tools/screenshots && npm run checks      (ONLY=recover: some)

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS = ['recover', 'share-stress', 'live-resilience'];
const only = process.env.ONLY?.split(',');

function run(name) {
  const t0 = Date.now();
  return new Promise((done) => {
    let out = '';
    const child = spawn(process.execPath, [join(HERE, `${name}.mjs`)], { cwd: HERE, env: process.env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => done({ name, ok: code === 0, out, s: Math.round((Date.now() - t0) / 1000) }));
  });
}

const results = await Promise.all(CHECKS.filter((c) => !only || only.includes(c)).map(run));
for (const r of results.filter((r) => !r.ok)) console.log(`\n---- ${r.name} ----\n${r.out}`);
console.log();
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.s}s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
