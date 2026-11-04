// The Mac the iOS checks drive (ios.mjs, ../bench/ios.mjs): its settings are that machine's, not
// the repository's. Each comes from the environment, else from ~/.config/plim/ios.env (or the file
// PLIM_IOS_ENV names), one KEY=value a line:
//
//   WDA_BUILD=/Users/<you>/wda-build      WebDriverAgent's derived data on the Mac (see ios.mjs)
//   UDID=<iPhone simulator's UDID>        xcrun simctl list devices
//   UDID_IPAD=<iPad simulator's UDID>     (DEVICE=ipad)
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = process.env.PLIM_IOS_ENV ?? join(homedir(), '.config/plim/ios.env');
const saved = existsSync(file)
  ? Object.fromEntries(readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {};

/** A setting of the Mac: the environment's, else the file's; missing, it says where to put it. */
export function macSetting(name) {
  const v = process.env[name] ?? saved[name];
  if (!v) throw new Error(`${name} isn't set: put ${name}=… in ${file} (see tools/screenshots/mac-env.mjs), or in the environment`);
  return v;
}
