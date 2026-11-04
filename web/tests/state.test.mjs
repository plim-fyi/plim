// The app's shared state (ui/shared.js `state`, #446): every field declared there with its owner,
// and only its owner writing it. A module that needs another's field changed asks the owner (a
// function it exports, or one app.js hands it).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { here, test } from './lib.mjs';

const web = new URL('../', here);
const read = (path) => readFileSync(new URL(path, web), 'utf8');
/** A module's code without its comments (which mention fields and files freely). */
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const modules = ['app.js', ...readdirSync(new URL('ui/', web)).filter((f) => f.endsWith('.js')).map((f) => `ui/${f}`)];

/** ui/shared.js's `state`: field → its owners (the files in brackets after it). */
function declared() {
  const block = read('ui/shared.js').match(/export const state = \{([\s\S]*?)\n\};/)[1];
  const owners = new Map();
  for (const m of block.matchAll(/^ {2}(\w+): .*?\/\/ \[([^\]]+)\]/gm)) owners.set(m[1], m[2].split(/\s+/));
  return owners;
}

/** Where each module writes a field: `state.x = …`, `state.x.y = …`, `state.x.set(…)` and the like. */
function writes() {
  const out = [];
  for (const file of modules) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const m of code.matchAll(/state\.(\w+)(?:\.\w+)?\s*(?:=(?!=)|\?\?=|\+\+|--|\+=|-=)|state\.(\w+)\.(?:set|delete|clear|push|splice|add)\(/g)) {
        out.push({ field: m[1] ?? m[2], file, line: i + 1 });
      }
    });
  }
  return out;
}

test('state: every field used is declared in ui/shared.js, with its owner', () => {
  const owners = declared();
  const used = new Set(modules.flatMap((f) => [...code(f).matchAll(/state\.(\w+)/g)].map((m) => m[1])));
  const undeclared = [...used].filter((f) => !owners.has(f));
  assert.deepEqual(undeclared, [], `declare these in ui/shared.js, each with its owner: ${undeclared.join(', ')}`);
  const unused = [...owners.keys()].filter((f) => !used.has(f));
  assert.deepEqual(unused, [], `declared but never used: ${unused.join(', ')}`);
  for (const [field, files] of owners) {
    for (const f of files) assert.ok(modules.includes(f), `${field}: its owner ${f} isn't a module of the app`);
    assert.equal(files.length, 1, `${field}: one owner, not ${files.join(' and ')}`);
  }
});

test('state: only a field\'s owner writes it', () => {
  const owners = declared();
  const wrong = writes().filter((w) => owners.has(w.field) && !owners.get(w.field).includes(w.file));
  assert.deepEqual(wrong.map((w) => `${w.file}:${w.line} writes ${w.field} (${owners.get(w.field).join(', ')}'s)`), []);
});

test('state: only app.js writes into a session\'s ctx (others are handed it, and ask)', () => {
  const others = readdirSync(web).filter((f) => f.endsWith('.js')).concat(modules).filter((f) => f !== 'app.js');
  const wrong = others.flatMap((f) => code(f).split('\n').flatMap((l, i) => (/\bctx\.\w+(\.\w+)?\s*(=(?!=)|\?\?=)/.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])));
  assert.deepEqual(wrong, []);
});
