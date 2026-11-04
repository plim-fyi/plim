import { closeSettings, mobile, openSettings, s, until } from './harness.mjs';

/** Flow 5: Settings. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow5(shared) {
  const { A } = shared;
  // 5. Settings: in sections (on a phone, their list first), then the account's passkeys
  await openSettings(A, null);
  await s(A, '05-settings-0-sections');
  if (mobile(A)) {
    // The list, then a section on its own, and back.
    if (!(await A.$eval('#settings', (d) => d.dataset.level === 'list'))) throw new Error('on a phone, Settings should open on its list of sections');
    await A.click('.settings-nav button[data-section="storage"]');
    await until(A, () => !document.querySelector('.settings-section[data-section="storage"]').hidden && document.getElementById('settings-back').offsetParent !== null);
    await A.click('#settings-back');
    await until(A, () => document.getElementById('settings').dataset.level === 'list');
  }
  await A.click('.settings-nav button[data-section="security"]');
  await until(A, () => !document.querySelector('.settings-section[data-section="security"]').hidden);
  await s(A, '05-settings-2-passkeys');

  // The theme (#21): light, dark or the system's, this device only, at once and before a page is
  // drawn. (These checks run in dark mode: the system's is dark.)
  const look = (p) => p.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return { theme: document.documentElement.dataset.theme ?? 'system', light: r + g + b > 3 * 128,
             bar: document.querySelector('meta[name="theme-color"]')?.content, nav: document.getElementById('settings-nav-appearance')?.textContent };
  });
  if (mobile(A)) {
    await A.click('#settings-back'); // (a phone shows one section at a time: back to the list)
    await until(A, () => document.getElementById('settings').dataset.level === 'list');
  }
  await A.click('.settings-nav button[data-section="appearance"]');
  await until(A, () => !document.querySelector('.settings-section[data-section="appearance"]').hidden);
  if ((await A.$eval('#settings-theme', (el) => el.value)) !== 'system') throw new Error('the theme should start as the system\'s');
  await A.select('#settings-theme', 'light');
  let l = await look(A);
  if (l.theme !== 'light' || !l.light || l.nav !== 'Light') throw new Error(`light chosen: ${JSON.stringify(l)}`);
  await s(A, '05-settings-3-appearance');
  // Another tab of this device: light from its first paint (boot.js, in <head>), not after the app starts.
  const tab = await A.browserContext().newPage();
  await tab.goto(A.url(), { waitUntil: 'domcontentloaded' });
  const early = await tab.evaluate(() => ({ theme: document.documentElement.dataset.theme, started: Boolean(window.plimStarted) }));
  await tab.close();
  if (early.theme !== 'light') throw new Error(`a new page should be light before the app runs: ${JSON.stringify(early)}`);
  await A.select('#settings-theme', 'dark');
  l = await look(A);
  if (l.theme !== 'dark' || l.light || l.nav !== 'Dark') throw new Error(`dark chosen: ${JSON.stringify(l)}`);
  await A.select('#settings-theme', 'system');
  l = await look(A);
  if (l.theme !== 'system' || l.light || l.nav !== 'System') throw new Error(`back to the system's (dark here): ${JSON.stringify(l)}`);
  if (await A.evaluate(() => localStorage.getItem('plim-theme')) !== null) throw new Error('the system\'s theme should leave nothing stored');
  await closeSettings(A);
}
