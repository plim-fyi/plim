// The map of every screen and flow (tools/screens-map): what the screenshot tools record for it.
// Each tool writes its device's screens to screens-<profile>.json, a WebP of each to
// images/<profile>/, and then screens.json, all devices' screens together, for the page.
// In tools/screenshots/out/map (or MAP_DIR), not in git.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MAP = process.env.MAP_DIR ?? join(ROOT, 'tools/screenshots/out/map');
// The devices, in the order the page offers them.
const ORDER = ['desktop', 'ios', 'safari', 'ipad', 'mac'];

/** "03-notes-4-row-menu" → "Row menu". */
export function titleOf(name) {
  const rest = name.replace(/^\d\d-[a-z]+(?:-[a-z]+)*?-\d+-/, '').replace(/-/g, ' ');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** A screen for the map, from its screenshot (`png`): a WebP of it, and its entry. */
export function mapScreen({ profile, name, png, flow, device = null, via = null, title = titleOf(name) }) {
  const file = `images/${profile}/${name}.webp`;
  mkdirSync(dirname(join(MAP, file)), { recursive: true });
  spawnSync('magick', [png, '-quality', '82', join(MAP, file)]);
  return { id: `${profile}/${name}`, profile, flow, name, title, device, via, file };
}

/** A device's earlier screens gone, before a run that takes them all again. */
export function clearProfile(profile) {
  rmSync(join(MAP, 'images', profile), { recursive: true, force: true });
}

/**
 * A device's screens, for screens.json: `flows` titles the flows they're in. `partial`: a run of
 * only some flows, so the screens of the others stay as they were.
 */
export function writeProfile({ profile, label, flows, screens, partial = false }) {
  mkdirSync(MAP, { recursive: true });
  const path = join(MAP, `screens-${profile}.json`);
  const ran = new Set(screens.map((s) => s.flow));
  const kept = partial && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).screens.filter((s) => !ran.has(s.flow)) : [];
  writeFileSync(path, JSON.stringify({ profile, label, flows, screens: [...kept, ...screens] }));
}

/** screens.json: every device's screens, the page's to draw. */
export function writeMap() {
  const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const devices = readdirSync(MAP)
    .filter((f) => /^screens-.+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(MAP, f), 'utf8')))
    .filter((d) => d.profile)
    .sort((a, b) => (ORDER.indexOf(a.profile) + 1 || 99) - (ORDER.indexOf(b.profile) + 1 || 99));
  // What each flow is about, a caption for each screen (tools/screens-map/captions.json, once the
  // gallery's), and what you do to get to it: the map's arrow to it (unless the tool says).
  const captions = JSON.parse(readFileSync(join(ROOT, 'tools/screens-map/captions.json'), 'utf8'));
  const map = {
    taken: new Date().toISOString(),
    commit: git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--', 'web', 'admin') ? ' (and changes)' : ''),
    flows: Object.assign({}, ...devices.map((d) => d.flows)),
    about: Object.fromEntries(Object.entries(captions.flows).map(([flow, f]) => [flow, f.about])),
    profiles: Object.fromEntries(devices.map((d) => [d.profile, d.label])),
    screens: devices.flatMap((d) => d.screens).map((s) => ({ ...s, caption: captions.screens[s.name] ?? null, via: s.via ?? captions.via?.[s.name] ?? null })),
  };
  writeFileSync(join(MAP, 'screens.json'), JSON.stringify(map, null, 1));
  console.log(`\nThe map's screens: ${map.screens.length} (${devices.map((d) => `${d.label} ${d.screens.length}`).join(', ')}), in ${MAP}`);
}
