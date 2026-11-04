import { ADMIN_PORT, mobile, newPage, s } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 11: Admin dashboard. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow11(shared) {
  const { A, profile } = shared;
  // 11. Admin dashboard (desktop only)
  if (!mobile(A)) {
    const admin = await newPage(profile, { device: 'The admin dashboard' });
    await admin.goto(`http://localhost:${ADMIN_PORT}/`);
    await wait(2500);
    // Shared notes and History are counted (#105): the flow shared and restored notes above.
    const tiles = await admin.evaluate(() => Object.fromEntries([...document.querySelectorAll('#tiles .tile')]
      .map((t) => [t.querySelector('.label').textContent, Number(t.querySelector('.value').textContent.replace(/\D/g, ''))])));
    if (!(tiles['Shared notes'] >= 1 && tiles.History >= 1)) throw new Error(`admin tiles: ${JSON.stringify(tiles)}`);
    const charts = await admin.evaluate(() => ({ error: document.getElementById('error').hidden ? '' : document.getElementById('error').textContent,
      shared: document.querySelector('#c-shared [data-sub]').textContent, versions: document.querySelector('#c-versions [data-sub]').textContent }));
    if (charts.error || !/^[1-9]/.test(charts.shared) || !/^[1-9]/.test(charts.versions)) throw new Error(`admin charts: ${JSON.stringify(charts)}`);
    await s(admin, '11-admin-1-overview');
  }
}
