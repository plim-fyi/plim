// Read-only dashboard. Every number comes from /admin/api/* (metadata only).
import { columns, line } from './charts.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30_000;
const state = { days: 30, sort: 'created', timer: null };

// ---------- formatting ----------

const compact = (n) => Intl.NumberFormat(undefined, { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) (v /= 1024), u++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

function ago(secs) {
  if (secs == null) return '—';
  const s = Date.now() / 1000 - secs;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

function duration(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const dayLabel = (secs) => new Date(secs * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const absolute = (secs) => (secs == null ? '' : new Date(secs * 1000).toLocaleString());

function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- data ----------

async function api(path) {
  const res = await fetch(`/admin/api/${path}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function load() {
  const main = $('main');
  main.classList.add('loading');
  try {
    const [overview, series, storage, accounts] = await Promise.all([
      api('overview'),
      api(`timeseries?days=${state.days}`),
      api('storage'),
      api(`accounts?sort=${state.sort}&limit=200`),
    ]);
    renderOverview(overview);
    renderHealth(overview.counters, overview.live);
    renderCharts(series.days, storage);
    renderAccounts(accounts);
    renderConfig(overview.config);
    $('uptime').textContent = `Up ${duration(overview.uptime_secs)}`;
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    $('error').hidden = true;
  } catch (e) {
    // Keep the previous render; just say what failed.
    $('error').textContent = `Couldn't load stats — ${e.message}`;
    $('error').hidden = false;
  } finally {
    main.classList.remove('loading', 'first-load');
  }
}

// ---------- tiles ----------

function tile({ label, value, sub, meter, status }) {
  const t = node('div', 'card tile');
  t.append(node('span', 'label', label), node('span', 'value', value));
  if (sub) t.append(node('span', 'sub', sub));
  if (meter != null) {
    const m = node('div', 'meter');
    const fill = node('div');
    fill.style.width = `${Math.min(100, Math.max(0, meter))}%`;
    m.append(fill);
    t.append(m);
  }
  if (status) t.append(node('span', `status ${status.level}`, status.text));
  return t;
}

function renderOverview(o) {
  const pct = o.quota_total_bytes ? (o.used_bytes / o.quota_total_bytes) * 100 : 0;
  const max = o.config.max_accounts;
  const limit = max != null ? `of ${max.toLocaleString()} · ` : '';
  const sh = o.shares;
  const cn = o.connections ?? { active: 0, revoked: 0, owners: 0, used_week: 0, holders: 0 };
  const ver = o.versions;
  const live = o.live;
  const rotated = o.rotated_accounts ? ` · ${plural(o.rotated_accounts, 'phrase change')}` : '';
  $('tiles').replaceChildren(
    tile({ label: 'Accounts', value: compact(o.accounts), sub: `${limit}+${o.new_accounts.week.toLocaleString()} this week${rotated}`,
      ...(max != null && { meter: (o.accounts / Math.max(max, 1)) * 100 }),
      status: max != null && o.accounts >= max ? { level: 'warning', text: 'Signups closed (PLIM_MAX_ACCOUNTS)' } : null }),
    tile({ label: 'Active this week', value: compact(o.active_accounts.week), sub: `${o.active_accounts.day.toLocaleString()} today · wrote or signed in` }),
    tile({ label: 'Storage used', value: bytes(o.used_bytes), sub: `${pct.toFixed(pct < 1 ? 2 : 1)}% of ${bytes(o.quota_total_bytes)} total quota`, meter: pct }),
    tile({ label: 'Documents', value: compact(o.documents), sub: `private · ${plural(o.updates, 'update')} · ${plural(o.snapshots, 'snapshot')}` }),
    tile({ label: 'Shared notes', value: compact(sh.active), sub: `${plural(sh.owners, 'owner')} · ${bytes(sh.bytes)} · +${sh.new_week.toLocaleString()} this week${sh.revoked ? ` · ${sh.revoked.toLocaleString()} turned off` : ''}` }),
    // Apps connected (#392): its list note is one of its holders, so the notes it reaches are the rest.
    tile({ label: 'Connections', value: compact(cn.active),
      sub: `${cn.used_week.toLocaleString()} used this week · ${plural(Math.max(0, cn.holders - cn.active), 'note')} reached · ${plural(cn.owners, 'account')}${cn.revoked ? ` · ${cn.revoked.toLocaleString()} disconnected` : ''}` }),
    tile({ label: 'History', value: compact(ver.private + ver.shared), sub: `versions of ${plural(ver.notes, 'note')} · ${bytes(ver.bytes)}${ver.shared ? ` · ${ver.shared.toLocaleString()} in shared notes` : ''}` }),
    tile({ label: 'Signed in now', value: compact(o.active_sessions), sub: `${plural(live.connections, 'live connection')}${live.guest_connections ? ` (${live.guest_connections.toLocaleString()} guests)` : ''} · ${plural(live.shared_notes_open, 'shared note')} open` }),
    tile({ label: 'Size on disk', value: bytes(o.db_bytes), sub: 'database, including WAL' }),
  );
}

function renderHealth(c, live) {
  const okPct = c.requests ? (c.ok / c.requests) * 100 : 100;
  const watch = (n, text, level = 'warning') => (n > 0 ? { level, text } : null);
  $('health').replaceChildren(
    tile({ label: 'API requests', value: compact(c.requests), sub: `${okPct.toFixed(1)}% succeeded` }),
    tile({ label: 'Server errors', value: compact(c.server_errors), status: watch(c.server_errors, 'Investigate', 'critical') }),
    tile({ label: 'Client errors', value: compact(c.client_errors), sub: 'bad requests, expired sessions' }),
    tile({ label: 'Rate-limited', value: compact(c.rate_limited), status: watch(c.rate_limited, 'Watch') }),
    tile({ label: 'Failed sign-ins', value: compact(c.failed_logins), status: watch(c.failed_logins, 'Watch') }),
    tile({ label: 'Storage full', value: compact(c.storage_full), status: watch(c.storage_full, 'Accounts at quota') }),
    tile({ label: 'Presence relayed', value: compact(live.presence_relayed), sub: 'cursors and names in shared notes' }),
  );
}

// ---------- charts ----------

function dayTicks(n) {
  return n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
}

function renderChart(id, render, points, opts, sub) {
  const card = $(id);
  card.querySelector('[data-sub]').textContent = sub;
  render(card.querySelector('.plot'), points, opts);
}

function renderCharts(days, storage) {
  const sum = (k) => days.reduce((a, d) => a + d[k], 0);
  const range = `last ${state.days} days`;
  const ticks = dayTicks(days.length);
  const xText = (i) => dayLabel(days[i].day);

  renderChart('c-signups', columns,
    days.map((d) => ({ label: dayLabel(d.day), value: d.signups, display: d.signups.toLocaleString(), detail: `new accounts · ${dayLabel(d.day)}` })),
    { xTicks: ticks, xText, valueHeader: 'New accounts', describe: `New accounts per day, ${range}` },
    `${sum('signups').toLocaleString()} in the ${range}`);

  renderChart('c-updates', columns,
    days.map((d) => ({ label: dayLabel(d.day), value: d.updates, display: d.updates.toLocaleString(), detail: `updates · ${bytes(d.bytes)} · ${dayLabel(d.day)}` })),
    { xTicks: ticks, xText, valueHeader: 'Updates', describe: `Encrypted updates written per day, ${range}` },
    `${sum('updates').toLocaleString()} updates, ${bytes(sum('bytes'))} written in the ${range}`);

  renderChart('c-shared', columns,
    days.map((d) => ({ label: dayLabel(d.day), value: d.share_updates, display: d.share_updates.toLocaleString(), detail: `shared-note updates · ${bytes(d.share_bytes)} · ${plural(d.new_shares, 'new share')} · ${dayLabel(d.day)}` })),
    { xTicks: ticks, xText, valueHeader: 'Updates', describe: `Shared notes' updates written per day, ${range}` },
    `${sum('share_updates').toLocaleString()} updates, ${plural(sum('new_shares'), 'note')} shared in the ${range}`);

  renderChart('c-versions', columns,
    days.map((d) => ({ label: dayLabel(d.day), value: d.versions, display: d.versions.toLocaleString(), detail: `versions saved · ${dayLabel(d.day)}` })),
    { xTicks: ticks, xText, valueHeader: 'Versions', describe: `Versions saved per day (still kept), ${range}` },
    `${sum('versions').toLocaleString()} kept from the ${range}; older ones are thinned out`);

  renderChart('c-writers', line,
    days.map((d) => ({ label: dayLabel(d.day), value: d.active_writers, display: d.active_writers.toLocaleString(), detail: `accounts writing · ${dayLabel(d.day)}` })),
    { xTicks: ticks, xText, valueHeader: 'Accounts', describe: `Distinct accounts writing per day, ${range}` },
    `Distinct accounts that saved at least one change`);

  const b = storage.buckets;
  renderChart('c-storage', columns,
    b.map((x) => ({ label: `${x.from_pct}–${x.to_pct}% of quota`, value: x.accounts, display: x.accounts.toLocaleString(), detail: `accounts using ${x.from_pct}–${x.to_pct}% of quota` })),
    { xTicks: [0, 4, 9], xText: (i) => `${b[i].from_pct}–${b[i].to_pct}%`, valueHeader: 'Accounts', describe: 'Accounts by share of storage quota used' },
    `Quota is ${bytes(storage.quota_bytes)} per account`);
}

// ---------- accounts table ----------

function renderAccounts({ total, accounts }) {
  $('accounts-count').textContent = accounts.length < total ? `showing ${accounts.length} of ${total.toLocaleString()}` : `${total.toLocaleString()}`;
  for (const th of document.querySelectorAll('#accounts th')) {
    const b = th.querySelector('button');
    if (b?.dataset.sort === state.sort) th.setAttribute('aria-sort', 'descending');
    else th.removeAttribute('aria-sort');
  }
  const body = $('accounts').tBodies[0];
  if (!accounts.length) {
    const row = body.insertRow();
    const c = row.insertCell();
    c.colSpan = 10;
    c.className = 'empty';
    c.textContent = 'No accounts yet.';
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(
    ...accounts.map((a) => {
      const tr = document.createElement('tr');
      const cell = (text, cls, title) => {
        const td = node('td', cls, text);
        if (title) td.title = title;
        tr.append(td);
        return td;
      };
      cell(a.id_short, 'id');
      cell(ago(a.created_at), '', absolute(a.created_at));
      const st = cell(null);
      const wrap = node('div', 'storage');
      const m = node('div', 'meter');
      const fill = node('div');
      fill.style.width = `${Math.min(100, a.quota_pct)}%`;
      m.append(fill);
      wrap.append(m, node('span', '', `${bytes(a.used_bytes)} · ${a.quota_pct}%`));
      st.append(wrap);
      cell(a.docs.toLocaleString(), 'num');
      cell(a.updates.toLocaleString(), 'num');
      cell(a.shares.toLocaleString(), 'num');
      cell(a.versions.toLocaleString(), 'num');
      cell(ago(a.last_write_at), '', absolute(a.last_write_at));
      cell(ago(a.last_login_at), '', absolute(a.last_login_at));
      cell(a.key_version != null ? `v${a.key_version}` : '—', 'num');
      return tr;
    }),
  );
}

function renderConfig(c) {
  const rows = [
    ['Signup proof-of-work', `${c.pow_bits} bits`],
    ['Accounts', c.max_accounts != null ? `at most ${c.max_accounts.toLocaleString()} (PLIM_MAX_ACCOUNTS): then signing up is closed` : 'no limit (PLIM_MAX_ACCOUNTS unset)'],
    ['Storage quota', `${bytes(c.quota_bytes)} per account`],
    ['Largest update or snapshot', bytes(c.max_blob_bytes)],
    ['Prune history after snapshots', c.prune_on_snapshot ? 'on' : 'off (PLIM_PRUNE_ON_SNAPSHOT=0: full encrypted history kept)'],
    ['Versions of a note', `at most one every ${duration(c.version_every_secs)} while it's edited`],
    ['Trusted proxies', c.trusted_proxies],
    ['Database', c.db_path],
  ];
  $('config').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dd = node('dd');
      dd.append(k === 'Database' ? node('code', '', v) : document.createTextNode(v));
      return [node('dt', '', k), dd];
    }),
  );
}

// ---------- controls ----------

for (const b of document.querySelectorAll('[data-days]')) {
  b.addEventListener('click', () => {
    state.days = Number(b.dataset.days);
    for (const o of document.querySelectorAll('[data-days]')) o.setAttribute('aria-pressed', String(o === b));
    load();
  });
}

for (const b of document.querySelectorAll('[data-sort]')) {
  b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    load();
  });
}

$('refresh').addEventListener('click', load);

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(() => !document.hidden && load(), REFRESH_MS);
}
document.addEventListener('visibilitychange', () => !document.hidden && load());

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(load, 200);
});

load();
schedule();
