// Build web/vendor/ from the versions pinned in package.json (see README.md):
//   yjs.mjs         Yjs, the notes' data format
//   codemirror.mjs  CodeMirror 6 and y-codemirror.next, using ./yjs.mjs (one Yjs instance)
// Each is one ES module, not minified (so it reads like the packages' own code), starting
// with a line naming what's in it. LICENSES.txt holds the bundled packages' licenses.
// `node build.mjs <dir>` builds into another folder
// (check.mjs uses that to compare with what's committed).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '../../web/vendor'));
const pkg = (name) => JSON.parse(readFileSync(join(here, 'node_modules', name, 'package.json'), 'utf8'));
const named = (deps) => deps.map((d) => `${d}@${pkg(d).version}`).join(', ');

/**
 * y-codemirror.next colours other people's cursors, name tags and selections
 * with inline style="" attributes, which the app's CSP (no 'unsafe-inline')
 * refuses: they'd all come out uncoloured. Instead, put the colour (a palette
 * name, see the app's style.css) in a data-ycolor attribute that CSS styles.
 * Each replacement must match exactly as many times as expected, so an
 * upgrade that changes this code fails here rather than in the browser.
 */
const CSP_SAFE_COLOURS = [
  [
    "pair.create('style', `background-color: ${this.color}; border-color: ${this.color}`)",
    "pair.create('data-ycolor', this.color)",
    1,
  ],
  ["attributes: { style: `background-color: ${colorLight}` },", "attributes: { 'data-ycolor': colorLight },", 3],
  [
    "attributes: { style: `background-color: ${colorLight}`, class: 'cm-yLineSelection' }",
    "attributes: { 'data-ycolor': colorLight, class: 'cm-yLineSelection' }",
    1,
  ],
];

const cspSafeColours = {
  name: 'csp-safe-cursor-colours',
  setup: (b) =>
    b.onLoad({ filter: /y-codemirror\.next[/\\]src[/\\]y-remote-selections\.js$/ }, ({ path }) => {
      let code = readFileSync(path, 'utf8');
      for (const [from, to, times] of CSP_SAFE_COLOURS) {
        const found = code.split(from).length - 1;
        if (found !== times) throw new Error(`y-remote-selections.js: expected ${times}× ${from}, found ${found}`);
        code = code.replaceAll(from, to);
      }
      if (code.includes("style: `") || code.includes("'style'")) throw new Error('y-remote-selections.js: an inline style is left');
      return { contents: code, loader: 'js' };
    }),
};

// Use the app's own Yjs, so CodeMirror and the sync engine share one instance.
const appYjs = { name: 'app-yjs', setup: (b) => b.onResolve({ filter: /^yjs$/ }, () => ({ path: './yjs.mjs', external: true })) };

const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: false, legalComments: 'none', logLevel: 'warning', metafile: true };
const banner = (what) => ({ js: `// ${what} — MIT licensed (see LICENSES.txt). Built by tools/vendor (README.md); don't edit.` });

/** The packages a build bundled, from esbuild's metafile: `node_modules/<name>/…` inputs. */
const bundled = ({ metafile }) =>
  Object.keys(metafile.inputs).flatMap((p) => p.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1] ?? []);

const yjs = named(['yjs']);
const y = await build({ ...common, entryPoints: [join(here, 'node_modules/yjs/dist/yjs.mjs')], outfile: join(out, 'yjs.mjs'), banner: banner(yjs) });

const cm = named(['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-markdown', '@lezer/markdown', 'y-codemirror.next', 'y-protocols']);
const c = await build({
  ...common,
  entryPoints: [join(here, 'entry.mjs')],
  outfile: join(out, 'codemirror.mjs'),
  banner: banner(`${cm}; Yjs from ./yjs.mjs`),
  plugins: [appYjs, cspSafeColours],
});

// The MIT license asks for its notice to go with every copy: each bundled package's own
// LICENSE file, in one LICENSES.txt beside the bundles.
const packages = [...new Set([...bundled(y), ...bundled(c)])].sort();
const licenses = packages.map((name) => {
  const dir = join(here, 'node_modules', name);
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`${name}: no LICENSE file to ship with it`);
  const { version, license } = pkg(name);
  return `${'='.repeat(78)}\n${name}@${version} (${license})\n${'='.repeat(78)}\n\n${readFileSync(join(dir, file), 'utf8').trim()}\n`;
});
writeFileSync(
  join(out, 'LICENSES.txt'),
  `The licenses of the packages bundled into yjs.mjs and codemirror.mjs.\nBuilt by tools/vendor (README.md); don't edit.\n\n${licenses.join('\n')}`,
);

console.log(`${out}/yjs.mjs: ${yjs}\n${out}/codemirror.mjs: ${cm}\n${out}/LICENSES.txt: ${packages.length} packages`);
