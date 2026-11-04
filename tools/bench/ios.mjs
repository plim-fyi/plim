// The note index benchmark in Safari on the iPhone simulator (#262), through Appium on a Mac,
// wired as tools/screenshots/ios.mjs is: appium on the Mac, `ssh -L 4723 -R 3980`, and here
// `node tools/bench/serve.mjs 3980`. Prints the page's results as JSON.
import { macSetting } from '../screenshots/mac-env.mjs';

const APPIUM = process.env.APPIUM ?? 'http://127.0.0.1:4723';
const URL_ = process.env.BENCH_URL ?? 'http://localhost:3980/tools/bench/';
// (The Mac's own: its simulator and WebDriverAgent build, from ../screenshots/mac-env.mjs.)
const UDID = macSetting('UDID');
const WDA_BUILD = macSetting('WDA_BUILD');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function wd(method, path, body) {
  const res = await fetch(APPIUM + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const { value } = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${value?.message ?? res.status}`);
  return value;
}

const { sessionId } = await wd('POST', '/session', {
  capabilities: {
    alwaysMatch: {
      platformName: 'iOS', browserName: 'Safari', 'appium:automationName': 'XCUITest', 'appium:udid': UDID,
      'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': WDA_BUILD, 'appium:wdaLaunchTimeout': 600_000, 'appium:newCommandTimeout': 600,
    },
  },
});
const s = (path) => `/session/${sessionId}${path}`;
const run = (script, ...args) => wd('POST', s('/execute/sync'), { script, args });
try {
  await wd('POST', s('/url'), { url: URL_ });
  for (let i = 0; i < 120; i++) {
    await wait(2000);
    const { done, status, out } = await run('const o = document.getElementById("out"); return { done: o?.dataset.done, status: document.getElementById("status")?.textContent, out: o?.textContent }');
    if (done) {
      console.error(status);
      console.log(out);
      break;
    }
  }
} finally {
  await wd('DELETE', s(''));
}
