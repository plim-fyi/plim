// The map of every screen and flow: page.html with React Flow's styles inlined, written beside
// the screens it shows (screens.json and images/, from `npm run web:shots` in tools/screenshots).
//
//   node tools/screens-map/build.mjs               → tools/screenshots/out/map/index.html
//   node tools/screens-map/build.mjs --standalone  → the same as a whole HTML document, to host anywhere
//
// Without --standalone, the page is the body of a claude.ai page (which adds the <html>, <head>
// and <body> around it). Env: MAP_DIR (where the screens are, and the page goes).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = process.env.MAP_DIR ?? resolve(HERE, '../screenshots/out/map');
const CSS = 'vendor/xyflow-react-12.12.0.css';

let page = readFileSync(join(HERE, 'page.html'), 'utf8').replace('/*XYFLOW_CSS*/', () => readFileSync(join(HERE, CSS), 'utf8'));
if (process.argv.includes('--standalone')) {
  page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n${page.replace(/<div id="app">/, '</head>\n<body>\n<div id="app">')}\n</body>\n</html>\n`;
  page = page.replace('<style>', '<style>\nbody { margin: 0; }');
}
writeFileSync(join(MAP, 'index.html'), page);
console.log(`${join(MAP, 'index.html')} (${Math.round(page.length / 1024)} KB)`);
