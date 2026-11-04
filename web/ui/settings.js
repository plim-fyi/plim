// Settings (#259): its sections and your passkeys; the recovery phrase (shown, marked saved,
// the banner asking for that) and changing it; deleting the account. The rest of the app it
// needs comes through init().
import { entropyToMnemonic, generateMnemonic } from '../core/bip39.js';
import { unb64 } from '../core/crypto.js';
import { isOffline, whenOutdated } from '../core/api.js';
import { deleteAccount, listPasskeys, removePasskey } from '../core/account.js';
import { fallbackName } from '../core/names.js';
import { NAME_MAX, cleanName, forgetCredential, passkeySupported } from '../core/passkey.js';
import { clearOfflineData, kvPut, passkeyCache } from '../core/vault.js';
import { profile } from './shares.js';
import { dropOutbox } from './trash.js';
import { setSplitEnabled, splitEnabled } from './reading.js';
import { $, relTime, setError, state, tell } from './shared.js';
import { confirmationDone, pendingPasskey, phraseFor } from './flow.js';
import { PASSKEY_SUB, addPasskey, createOrConfirm, showPhrase, startFlow } from './onboarding.js';
import { isPhraseSaved, markPhraseSaved, passkeyNames } from './vault-data.js';

let phraseBannerLater = false; // "Later" on the save-your-phrase banner, until the next unlock

// From app.js (init): the server, this device's keys in storage, auto-lock, saving everything,
// leaving (the account deleted), this device's passkeys changed, the storage meter and the
// offline state. (The passkey screen and the phrase's flow: imported, ui/onboarding.js.)
let api, AUTO_LOCK_KEY, DELETED_KEY, autoLockMinutes, flushAll, leaving, passkeysChanged, refreshStorage, renderOffline;
export function init(deps) {
  ({ api, AUTO_LOCK_KEY, DELETED_KEY, autoLockMinutes, flushAll, leaving, passkeysChanged, refreshStorage, renderOffline } = deps);
}


/** The account's passkeys, from the server; the ones this device has used are marked. */
async function renderPasskeySettings() {
  const supported = await passkeySupported();
  confirmationDone(); // (a passkey left half made: Add starts over)
  setError('settings-passkey-error');
  $('settings-add-passkey').textContent = 'Add';
  $('settings-add-passkey').hidden = !supported;
  $('settings-passkey-sub').textContent = supported ? PASSKEY_SUB : 'Passkeys aren’t supported in this browser.';
  let list;
  try {
    list = await listPasskeys(api);
  } catch (err) {
    if (!isOffline(err)) throw err;
    const row = settingRow('Your passkeys', 'Shown when you’re back online.');
    return $('settings-passkey-list').replaceChildren(row);
  }
  const here = new Set(state.passkeys.map((r) => r.credHash));
  $('settings-passkey-list').replaceChildren(...list.map((p) => {
    const used = p.last_used_at ? ` · last sign-in ${relTime(p.last_used_at * 1000)}` : '';
    const thisDevice = here.has(p.cred_hash) ? 'This device · ' : '';
    const row = settingRow(passkeyNames().get(p.cred_hash) || 'Passkey', `${thisDevice}Added ${relTime(p.created_at * 1000)}${used}`);
    const button = (text, onClick) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: text });
      b.addEventListener('click', onClick);
      return b;
    };
    row.querySelector('.setting-actions').append(
      button('Rename', () => renamePasskey(row, p.cred_hash)),
      button('Remove', () => removePasskeyFromSettings(p, list.length === 1)),
    );
    return row;
  }));
}

/**
 * Passkey names, by cred_hash: in the encrypted note index, so they sync to
 * every device, the server never sees them, and they outlast a phrase change.
 */
/** Edit a passkey's name in place: Enter or leaving the field saves, Escape cancels, empty clears it. */
function renamePasskey(row, hash) {
  const title = row.querySelector('.setting-title');
  const input = Object.assign(document.createElement('input'), {
    value: passkeyNames().get(hash) ?? '', maxLength: NAME_MAX, placeholder: 'Passkey', className: 'rename',
  });
  input.setAttribute('aria-label', 'Passkey name');
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = cleanName(input.value);
    if (save) {
      if (name) passkeyNames().set(hash, name);
      else passkeyNames().delete(hash);
    }
    title.textContent = passkeyNames().get(hash) || 'Passkey';
    input.replaceWith(title);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(), finish(true);
    if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), finish(false); // not the dialog's Escape
  });
  input.addEventListener('blur', () => finish(true));
  title.replaceWith(input);
  input.focus();
  input.select();
}

/** A settings row: title and line under it on the left, an (empty) actions area on the right. */
function settingRow(title, sub) {
  const row = Object.assign(document.createElement('div'), { className: 'setting' });
  const text = document.createElement('div');
  text.append(
    Object.assign(document.createElement('div'), { className: 'setting-title', textContent: title }),
    Object.assign(document.createElement('div'), { className: 'setting-sub', textContent: sub }),
  );
  row.append(text, Object.assign(document.createElement('div'), { className: 'setting-actions' }));
  return row;
}

async function removePasskeyFromSettings(p, last) {
  const warning = last ? '\n\nIt’s your last passkey: after this you’ll need your recovery phrase to sign in. Make sure you’ve saved it.' : '';
  if (!confirm(`Remove this passkey? It will stop signing in to Plim on every device.${warning}`)) return;
  setError('settings-passkey-error');
  try {
    await removePasskey(state.ctx, p.cred_hash);
  } catch (err) {
    return setError('settings-passkey-error', isOffline(err) ? 'Removing a passkey needs a connection.' : err);
  }
  passkeyNames().delete(p.cred_hash);
  const cached = state.passkeys.find((r) => r.credHash === p.cred_hash);
  if (cached) {
    await passkeyCache.remove((r) => r.credHash === p.cred_hash);
    await passkeysChanged();
    // Known on this device: the password manager can drop it too.
    await forgetCredential(unb64(cached.credentialId));
  }
  await renderPasskeySettings();
}

$('settings-split').addEventListener('change', (e) => setSplitEnabled(e.target.checked));
// The theme (#21): boot.js keeps it, and applies it at once (here and in other tabs).
const THEMES = { system: 'System', light: 'Light', dark: 'Dark' };
const theme = () => window.plimTheme?.get() ?? 'system';
$('settings-theme').addEventListener('change', (e) => {
  window.plimTheme?.set(e.target.value);
  renderSettingsNav();
});
$('settings-autolock').addEventListener('change', async (e) => {
  const minutes = Number(e.target.value);
  await kvPut(AUTO_LOCK_KEY, minutes);
  state.autoLock?.setMinutes(minutes);
  tell({ type: 'auto-lock', minutes });
});

// Settings is in sections (index.html): the list and the chosen one side by side, or on a
// phone the list, then one section on its own with ‹ Settings.
const phoneLayout = () => matchMedia('(max-width: 720px)').matches;

/** Show a section (`page`: on a phone, open it; otherwise just mark it, with the list showing). */
function showSettingsSection(name, { page = true } = {}) {
  const d = $('settings');
  d.dataset.section = name;
  d.dataset.level = page ? 'page' : 'list';
  for (const b of d.querySelectorAll('.settings-nav button')) b.setAttribute('aria-current', String(b.dataset.section === name));
  for (const s of d.querySelectorAll('.settings-section')) s.hidden = s.dataset.section !== name;
  d.querySelector('.settings-pages').scrollTop = 0;
  markMore();
}

/**
 * Whether the section shown goes on past the pane's top or bottom edge (#393): style.css fades
 * that edge, so a row cut by it reads as more to scroll to, not clipped. Again when it scrolls,
 * and when what's in it changes size (a passkey added, a connection's page drawn).
 */
function markMore() {
  const pane = $('settings').querySelector('.settings-pages');
  const above = pane.scrollTop > 1;
  const below = pane.scrollTop + pane.clientHeight < pane.scrollHeight - 1;
  const more = above && below ? 'both' : above ? 'above' : below ? 'below' : '';
  if (more) pane.dataset.more = more;
  else delete pane.dataset.more;
}
{
  const pane = $('settings').querySelector('.settings-pages');
  pane.addEventListener('scroll', markMore, { passive: true });
  const sized = new ResizeObserver(markMore);
  sized.observe(pane);
  for (const s of pane.querySelectorAll('.settings-section')) sized.observe(s);
}
for (const b of $('settings').querySelectorAll('.settings-nav button')) {
  b.addEventListener('click', () => showSettingsSection(b.dataset.section));
}
$('settings-back').addEventListener('click', () => ($('settings').dataset.level = 'list'));

/** The list's second lines: your name, the theme, storage used. */
export function renderSettingsNav() {
  $('settings-nav-profile').textContent = profile().get('name') || 'Your name';
  $('settings-nav-appearance').textContent = THEMES[theme()];
  $('settings-nav-storage').textContent = $('storage-text').textContent;
}

/** Open Settings (at `section`, or the first; on a phone, at the list unless a section is asked for). */
async function openSettings(section) {
  showSettingsSection(section ?? 'profile', { page: Boolean(section) || !phoneLayout() });
  $('settings-account').textContent = state.ctx.accountId;
  refreshStorage(); // fresh numbers while it's on screen (offline: the last ones stay)
  renderOffline();
  hideSettingsPhrase();
  $('settings-name').value = profile().get('name') ?? '';
  $('settings-name').placeholder = fallbackName(); // what others see until you set one
  $('settings-autolock').value = String(await autoLockMinutes());
  $('settings-split').checked = splitEnabled();
  $('settings-theme').value = theme();
  await renderPasskeySettings().catch((err) => setError('settings-passkey-error', err));
  renderSettingsNav();
  $('settings').showModal();
}

$('btn-settings').addEventListener('click', () => openSettings());

$('settings-add-passkey').addEventListener('click', async () => {
  setError('settings-passkey-error');
  try {
    const got = await createOrConfirm(state.ctx.accountId, $('settings-add-passkey'), (t) => ($('settings-passkey-sub').textContent = t));
    if (!got) return; // waiting for the confirming tap
    await addPasskey(got);
    await renderPasskeySettings();
  } catch (err) {
    if (!pendingPasskey()) $('settings-add-passkey').textContent = 'Add';
    setError('settings-passkey-error', err);
  }
});

// ---------- recovery phrase: show, saved, banner ----------

async function showSettingsPhrase() {
  const words = (await entropyToMnemonic(state.entropy)).split(' ');
  $('settings-phrase-words').replaceChildren(...words.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  $('settings-phrase-saved').hidden = (await isPhraseSaved()) === true;
  $('settings-phrase').hidden = false;
  $('settings-show-phrase').textContent = 'Hide';
}

function hideSettingsPhrase() {
  $('settings-phrase').hidden = true;
  $('settings-phrase-words').replaceChildren();
  $('settings-show-phrase').textContent = 'Show';
}

$('settings-show-phrase').addEventListener('click', () => {
  if ($('settings-phrase').hidden) showSettingsPhrase();
  else hideSettingsPhrase();
});

$('settings-phrase-saved').addEventListener('click', async () => {
  await markPhraseSaved(true);
  $('settings-phrase-saved').hidden = true;
  renderPhraseBanner();
});

// Don't leave the words in the page once Settings is closed.
$('settings').addEventListener('close', hideSettingsPhrase);

// "I've saved my recovery phrase" (#46): kept for the account, in the
// encrypted note list's profile (so every device agrees, and the server can't
// see it), and on this device for the moments before the list is loaded
// (signing in, creating a vault). The two are merged once it is: saved
// anywhere wins; "not yet" (a vault made with a passkey) is carried over.

/** A vault created with a passkey asks for its 12 words to be saved, until they are (on any device). */
export async function renderPhraseBanner() {
  const saved = await isPhraseSaved();
  $('phrase-banner').hidden = phraseBannerLater || saved !== false || !$('update-banner').hidden; // (one at a time)
}

// Running an older (or newer) Plim than the server's (api.js): offer to reload.
whenOutdated(() => {
  $('phrase-banner').hidden = true;
  $('update-banner').hidden = false;
});
$('update-reload').addEventListener('click', () => {
  flushAll(true); // (unsent edits are kept on this device anyway, and go after the reload)
  location.reload();
});

$('phrase-banner-later').addEventListener('click', () => {
  phraseBannerLater = true;
  renderPhraseBanner();
});

$('phrase-banner-show').addEventListener('click', async () => {
  await openSettings('security');
  await showSettingsPhrase();
  // Its row at the top, the words under it (not the section above cut off at the edge).
  $('settings-show-phrase').closest('.setting').scrollIntoView({ block: 'start' });
});

// ---------- change the recovery phrase ----------

$('settings-rotate').addEventListener('click', async () => {
  if (!confirm('Create a new recovery phrase? Your current phrase and your passkeys will stop working on every device, and other open devices will be signed out. You can set up a passkey again afterwards.')) return;
  $('settings').close();
  phraseFor('rotate');
  startFlow('rotate', { passkey: await passkeySupported() });
  await showPhrase(await generateMnemonic());
});

// ---------- delete the account (#51) ----------
// ---------- delete the account (#51) ----------

$('settings-delete').addEventListener('click', () => {
  $('delete-confirm').value = '';
  $('delete-go').disabled = true;
  setError('delete-error');
  $('delete-dialog').showModal();
  $('delete-confirm').focus();
});
$('delete-confirm').addEventListener('input', (e) => ($('delete-go').disabled = e.target.value.trim() !== 'DELETE'));

$('delete-go').addEventListener('click', async () => {
  if ($('delete-confirm').value.trim() !== 'DELETE') return;
  const go = $('delete-go');
  go.disabled = true;
  go.textContent = 'Deleting…';
  $('delete-dialog').dataset.busy = 'true'; // (a click outside doesn't close it meanwhile)
  setError('delete-error');
  const { accountId, identity, outbox } = state.ctx;
  try {
    await deleteAccount(api, identity, accountId);
  } catch (err) {
    go.textContent = 'Delete my account';
    go.disabled = false;
    delete $('delete-dialog').dataset.busy;
    return setError('delete-error', isOffline(err) ? 'You’re offline. Deleting your account needs a connection.' : err);
  }
  // Nothing of it left on this device either: its copies, sign-in, passkey copy and unsent
  // edits. Then a reload, which drops its keys from memory (as locking does).
  leaving();
  await clearOfflineData().catch((e) => console.warn('could not clear this device', e));
  for (const doc of await outbox.docs().catch(() => [])) await dropOutbox(doc).catch(() => {});
  try {
    sessionStorage.setItem(DELETED_KEY, '1');
  } catch {
    /* the note is optional */
  }
  location.reload();
});
