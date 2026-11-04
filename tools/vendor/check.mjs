// Rebuild web/vendor/ into a temporary folder and compare: the committed files must be
// exactly what the pinned versions build (README.md). Exits 1 if they differ.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '../../web/vendor');
const tmp = mkdtempSync(join(tmpdir(), 'plim-vendor-'));
try {
  execFileSync(process.execPath, [join(here, 'build.mjs'), tmp], { stdio: 'inherit' });
  const built = readdirSync(tmp).sort();
  const committed = readdirSync(vendor).sort();
  const problems = [];
  if (built.join() !== committed.join()) problems.push(`files: built ${built.join(', ')}; committed ${committed.join(', ')}`);
  for (const f of built.filter((f) => committed.includes(f))) {
    if (!readFileSync(join(tmp, f)).equals(readFileSync(join(vendor, f)))) problems.push(`${f} differs from what package.json builds`);
  }
  if (problems.length) {
    console.error(`web/vendor is out of date (run npm run build):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('web/vendor matches package.json');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
