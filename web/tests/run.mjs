// Client test suite. Runs in Node (uses its WebCrypto):
//   node web/tests/run.mjs                    unit tests
//   node web/tests/run.mjs --write-fixture    regenerate the JS-side fixtures (sig.json, interop-js.json)
//   cargo run -p plim-core --example interop_fixture   regenerates interop-rust.json
//   PLIM_URL=http://127.0.0.1:3000 node web/tests/run.mjs
//                                             also run end-to-end tests against a live server
//                                             (start it with PLIM_POW_BITS=8 to keep it quick)
//
// The tests are in a file per module they check (*.test.mjs, #428), registered with lib.mjs's
// test() as each file is imported, and run here in that order.
import { writeFileSync } from 'node:fs';
import { here, tests } from './lib.mjs';
import './authorship.test.mjs';
import { makeFixture } from './crypto.test.mjs';
import './sync.test.mjs';
import './sync-cases.test.mjs';
import './state.test.mjs';
import './keyed.test.mjs';
import './layers.test.mjs';
import './share.test.mjs';
import './trash.test.mjs';
import './live.test.mjs';
import './clock.test.mjs';
import './history.test.mjs';
import './notes.test.mjs';
import './frontmatter.test.mjs';
import './export.test.mjs';
import './offline.test.mjs';
import './large.test.mjs';
import './passkey.test.mjs';
import './idle.test.mjs';
import './render.test.mjs';
import './markdown.test.mjs';
import './textpos.test.mjs';
import './search.test.mjs';
import './slash.test.mjs';
import { makeInteropFixture } from './interop.test.mjs';
import './rollback.test.mjs';
import './e2e.test.mjs';
import './editor-ios.test.mjs';
import './connections.test.mjs';

if (process.argv.includes('--write-fixture')) {
  writeFileSync(new URL('fixtures/sig.json', here), JSON.stringify(await makeFixture(), null, 2) + '\n');
  writeFileSync(new URL('fixtures/interop-js.json', here), JSON.stringify(await makeInteropFixture(), null, 2) + '\n');
  console.log('wrote fixtures/sig.json and fixtures/interop-js.json');
  process.exit(0);
}

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n${e.stack}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
