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
  await closeSettings(A);
}
