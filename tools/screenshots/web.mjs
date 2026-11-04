// Every web flow, checked, in dark mode, on a desktop and an (emulated) iPhone;
// with SHOTS=1, screenshotted too.
//
//   cargo build --release -p plim-server -p plim-cli     (flow 32 runs the connector too)
//   cd tools/screenshots && npm ci
//   npm run web               the checks (both profiles at once, ~1.5 min)
//   SHOTS=1 npm run web       and the screenshots
//
// Starts its own plim-server on a throwaway database and drives Chromium
// through each flow with a virtual passkey authenticator. With SHOTS=1, it
// takes a screenshot of each screen for the map of the screens (map.mjs,
// tools/screens-map), and updates the few the README shows, in
// docs/screenshots/web (whichever README.md points at, notes-light.png
// included: the README's light-mode one). Each page's randomness is
// seeded, so the recovery words, names and IDs are the same every run, and
// each screenshot is taken with transitions and animations at their end.
// Env: PLIM_BIN (server binary), CHROME (browser executable),
// ONLY=desktop|ios (one profile, in this process), FLOWS=17,12b (those flows, with what they
// need first: harness.mjs NEEDS), CONSOLE=1 (the pages' own console).
//
// Each flow is a file of its own, web/NN-name.mjs (#428), run in the order below; what they share
// (driving the app, the server, the screenshots) is web/harness.mjs. What one flow leaves for the
// next (its pages, the recovery words) is in `shared`, each set where it's made.
//
// The iPhone profile is Chromium at iPhone size with the notch and home
// indicator insets, as Plim looks when added to the home screen. Layout is
// faithful; fonts differ slightly from real iOS. Desktop shots are framed as a
// macOS window.

import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearProfile, writeMap, writeProfile } from './map.mjs';
import { CHROME, FLOWS, LABELS, OUT, PROFILES, SHOTS, browser, flow, launch, screens, shiftProblems, shiftsSoFar, startAll, stopAll, stopAndClean, wantedFlows } from './web/harness.mjs';
import flow1 from './web/01-create-a-vault.mjs';
import flow3 from './web/03-notes.mjs';
import flow12 from './web/12-recently-deleted.mjs';
import flow12b from './web/12b-history.mjs';
import flow4 from './web/04-lock-and-unlock.mjs';
import flow5 from './web/05-settings.mjs';
import flow2 from './web/02-sign-in-on-another-device.mjs';
import flow13 from './web/13-share-a-note.mjs';
import flow10 from './web/10-rollback-warning.mjs';
import flow8 from './web/08-offline.mjs';
import flow14 from './web/14-a-shared-notes-page.mjs';
import flow17 from './web/17-editing-markdown.mjs';
import flow18 from './web/18-when-somethings-wrong.mjs';
import flow28 from './web/28-a-shortened-note-reopened.mjs';
import flow6 from './web/06-change-the-recovery-phrase.mjs';
import flow7 from './web/07-forget-this-device.mjs';
import flow9 from './web/09-a-passkey-without-prf.mjs';
import flow19 from './web/19-many-notes.mjs';
import flow11 from './web/11-admin-dashboard.mjs';
import flow20 from './web/20-a-long-note-measured-whole.mjs';
import flow21 from './web/21-a-note-as-a-page.mjs';
import flow22 from './web/22-a-notes-address.mjs';
import flow23 from './web/23-split.mjs';
import flow24 from './web/24-tags.mjs';
import flow25 from './web/25-type-for-a-menu.mjs';
import flow26 from './web/26-a-new-note-dated.mjs';
import flow27 from './web/27-tag-suggestions.mjs';
import flow32 from './web/32-connect-claude.mjs';
import flow31 from './web/31-a-note-worth-showing.mjs';
import flow29 from './web/29-line-breaks-on-the-page.mjs';
import flow33 from './web/33-search.mjs';
import flow34 from './web/34-export.mjs';

/** Every flow, in the order they run (one may need what an earlier one left: harness.mjs NEEDS). */
const RUN = [
  ['1', flow1],
  ['3', flow3],
  ['12', flow12],
  ['12b', flow12b],
  ['4', flow4],
  ['5', flow5],
  ['2', flow2],
  ['13', flow13],
  ['10', flow10],
  ['8', flow8],
  ['14', flow14],
  ['17', flow17],
  ['18', flow18],
  ['28', flow28],
  ['6', flow6],
  ['7', flow7],
  ['9', flow9],
  ['19', flow19],
  ['11', flow11],
  ['20', flow20],
  ['21', flow21],
  ['22', flow22],
  ['23', flow23],
  ['24', flow24],
  ['25', flow25],
  ['26', flow26],
  ['27', flow27],
  ['32', flow32],
  ['31', flow31],
  ['29', flow29],
  ['33', flow33],
  ['34', flow34],
];

async function run(profile) {
  console.log(`\n${profile}`);
  await startAll();
  // (Shared between flows, each set where it is made: a flow run alone gets what it needs from the flows it depends on.)
  const shared = { profile };
  for (const [id, fn] of RUN) await flow(id, () => fn(shared));
  const errors = [shared.A, shared.B, shared.C, shared.D].filter(Boolean).flatMap((p) => p.errors);
  writeFileSync(join(OUT, `../shifts-${profile}.json`), JSON.stringify(shiftsSoFar(), null, 1));
  // Something moved under the finger, with nothing done to move it (#442; harness.mjs shiftProblems).
  const shifts = shiftProblems(shiftsSoFar()).map((s) => `flow ${s.flow}, ${s.device ?? ''} at ${s.at}: ${s.moved.join(' | ')}`);
  if (shifts.length) errors.push(`layout shifts (the page moved, no input; out/shifts-${profile}.json has them all):\n  ${shifts.join('\n  ')}`);
  await stopAndClean();
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

// ---------- main ----------

/** Each profile in a process of its own, both at once (#221), its output lines marked with its name. */
async function runBoth() {
  const children = [];
  // Stopped from outside (a timeout, Ctrl-C): the children too, so their servers go with them.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      for (const c of children) c.kill(signal);
      process.exit(130);
    });
  }
  const codes = await Promise.all(Object.keys(PROFILES).map((profile) => new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ONLY: profile }, // (each picks its own free ports)
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) console.log(`${profile.padEnd(7)}| ${line}`);
      });
      stream.on('end', () => rest && console.log(`${profile.padEnd(7)}| ${rest}`));
    }
    child.on('exit', (code) => done(code));
  })));
  return codes.every((c) => c === 0);
}

if (!CHROME) throw new Error('No Chromium found; set CHROME to its path.');
if (!process.env.ONLY) {
  const ok = await runBoth();
  if (SHOTS) writeMap();
  console.log(ok ? '\ndone' : '\nfailed');
  process.exit(ok ? 0 : 1);
}
await launch();
const profile = process.env.ONLY;
try {
  if (!PROFILES[profile]) throw new Error(`ONLY=${profile}: not a profile (${Object.keys(PROFILES).join(', ')})`);
  if (SHOTS && !wantedFlows) {
    rmSync(join(OUT, profile), { recursive: true, force: true });
    clearProfile(profile);
  }
  await run(profile);
} finally {
  // (The screens taken, even if a check failed partway; some flows only: the others' screens kept.)
  if (SHOTS) writeProfile({ profile, label: LABELS[profile], flows: FLOWS, screens, partial: Boolean(wantedFlows) });
  await browser.close();
  await stopAll();
}
console.log('\ndone');
