// The web app's layers: core/ (data, sync, crypto: no page), editor/ (the editors and what
// renders a note), ui/ (the screens), and the pages' entry points (app.js, guest.js). Each
// imports only from its own layer and those below it; every import resolves to a file.
// (vendor/ and wasm/, the libraries and the app's WebAssembly, are below them all.)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './lib.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAYERS = { core: 0, editor: 1, ui: 2, '.': 3 }; // ('.': app.js, guest.js, boot.js, sw.js)
const layerOf = (file) => {
  const top = relative(WEB, file).split('/')[0];
  return top in LAYERS && top !== '.' ? top : '.';
};
const sources = [
  ...readdirSync(WEB).filter((f) => f.endsWith('.js')).map((f) => resolve(WEB, f)),
  ...['core', 'editor', 'ui'].flatMap((d) => readdirSync(resolve(WEB, d)).filter((f) => f.endsWith('.js')).map((f) => resolve(WEB, d, f))),
];
/** Each relative import a file makes (static, dynamic, or a worker's URL), resolved. */
function importsOf(file) {
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...code.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*|^\s*import\s+)'(\.{1,2}\/[^']+)'/gm)].map((m) => resolve(dirname(file), m[1]));
}

test('layers: every import in the web app resolves to a file', () => {
  const missing = sources.flatMap((f) => importsOf(f).filter((t) => !existsSync(t)).map((t) => `${relative(WEB, f)} → ${relative(WEB, t)}`));
  assert.deepEqual(missing, []);
});

test('layers: core/ imports nothing above it, editor/ nothing from ui/ or the pages', () => {
  const upward = sources.flatMap((f) => importsOf(f)
    .filter((t) => !/^(vendor|wasm)\//.test(relative(WEB, t)) && LAYERS[layerOf(t)] > LAYERS[layerOf(f)])
    .map((t) => `${relative(WEB, f)} imports ${relative(WEB, t)}`));
  assert.deepEqual(upward, []);
});

test('layers: no module imports itself back through others (#521)', () => {
  // (Static imports only: a dynamic import() runs later, once everything has loaded. A cycle works
  // only while every use is at call time; one use at load, and the page throws.)
  const staticImports = (file) => {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    return [...code.matchAll(/(?:from\s*|^\s*import\s+)'(\.{1,2}\/[^']+)'/gm)].map((m) => resolve(dirname(file), m[1])).filter((t) => sources.includes(t));
  };
  const graph = new Map(sources.map((f) => [f, staticImports(f)]));
  const cycles = [];
  const state = new Map(); // (1: on the path being walked, 2: done)
  const walk = (f, path) => {
    state.set(f, 1);
    for (const t of graph.get(f)) {
      if (state.get(t) === 1) cycles.push([...path.slice(path.indexOf(t)), t].map((x) => relative(WEB, x)).join(' → '));
      else if (!state.has(t)) walk(t, [...path, t]);
    }
    state.set(f, 2);
  };
  for (const f of sources) if (!state.has(f)) walk(f, [f]);
  assert.deepEqual(cycles, []);
});
