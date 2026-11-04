//! Live sync: one WebSocket per client, pushing stored updates and snapshots
//! of the docs it has open, so other devices see edits at once instead of at
//! the next poll. Uploads stay on the HTTP endpoints (signatures, quota and
//! size limits unchanged); after committing, they publish here.
//!
//! Text frames, JSON:
//!   client → server  {"auth": token}           first, within 10 s; again whenever the token changes
//!                    {"sub": doc, "after": n}  history after n (as GET /docs/{doc}), then live
//!                    {"unsub": doc}
//!                    {"presence": "share:<id>", "data"}  a shared note's presence (encrypted by
//!                                              the client), for the others following it; never stored
//!   server → client  {"type": "ready", "v"}         "v": the web files' version, as API responses' X-Tiro-Version
//!                    {"type": "doc", "doc", "snapshot", "updates", "head"}   the history
//!                    {"type": "update", "doc", "seq", "key_version", "nonce", "ciphertext"}
//!                    {"type": "snapshot", "doc", "covers_seq", "key_version", "nonce", "ciphertext"}
//!                    {"type": "resync", "doc"}   fell behind: fetch it over HTTP
//!                    {"type": "ping", "v"}       every 30 s (proxies drop idle connections)
//!                    {"type": "reauth"}          the session expired: send a fresh {"auth"} within 60 s (two pings)
//!                    {"type": "presence", "doc", "data"}   someone else in a shared note
//! Close codes: 4400 bad message, 4401 not signed in (or the session ended), 4429 too many sockets.
//!
//! Events can reach a socket out of seq order (two uploads commit, then each
//! publishes), so a socket only skips events already sent as history, and
//! clients put updates back in order themselves.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::AppState;
use crate::auth::{ClientIp, session_account};
use crate::store::Doc;

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(30);
const PRESENCE_PER_SECOND: u32 = 10;
const MAX_PRESENCE_BYTES: usize = 4096;
/// Socket IDs, so a presence message isn't sent back to where it came from (0 is "stored data").
static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);
pub const MAX_SOCKETS_PER_ACCOUNT: usize = 20;
const MAX_SUBS_PER_SOCKET: usize = 50;
const CHANNEL_SIZE: usize = 256;

/// Something to send to a doc's sockets, ready to go: a stored update
/// (`seq`), a snapshot (`seq` 0), or a shared note's presence message, which
/// goes to every socket but the one it came from (`from`; 0 for stored data).
/// `last`: a shared note's links stopped working, so its subscriptions end
/// after passing this on (no more presence either way).
#[derive(Clone)]
pub struct Event {
    seq: i64,
    from: u64,
    json: Arc<str>,
    last: bool,
}

impl Event {
    fn stored(seq: i64, json: Value) -> Self {
        Event { seq, from: 0, json: json.to_string().into(), last: false }
    }
}

/// Which of an account's sockets to close: all (None), or one session's (its token's SHA-256).
type Kick = Option<Arc<[u8]>>;

pub struct Hub {
    docs: Mutex<HashMap<(String, String), broadcast::Sender<Event>>>,
    /// Sockets to close, by account: all of them (None), or one session's (its token's hash, #146).
    kicks: Mutex<HashMap<String, broadcast::Sender<Kick>>>,
    sockets: Mutex<HashMap<String, usize>>,
    /// How often sockets are pinged (and the session re-checked); a client
    /// asked for a fresh token has two of these to send it.
    ping_every: Mutex<Duration>,
    /// Presence messages relayed since the server started (admin dashboard).
    presence_relayed: AtomicU64,
}

impl Default for Hub {
    fn default() -> Self {
        Hub {
            docs: Mutex::default(),
            kicks: Mutex::default(),
            sockets: Mutex::default(),
            ping_every: Mutex::new(PING_EVERY),
            presence_relayed: AtomicU64::new(0),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    fn doc(&self, account: &str, doc: &str) -> broadcast::Sender<Event> {
        let mut docs = lock(&self.docs);
        docs.retain(|_, tx| tx.receiver_count() > 0);
        docs.entry((account.into(), doc.into())).or_insert_with(|| broadcast::channel(CHANNEL_SIZE).0).clone()
    }

    /// After an update is committed: send it to the sockets that have the doc open.
    pub fn publish_update(&self, account: &str, doc: &str, seq: i64, key_version: u64, nonce: &str, ciphertext: &str) {
        let json = json!({ "type": "update", "doc": doc, "seq": seq, "key_version": key_version, "nonce": nonce, "ciphertext": ciphertext });
        self.publish(account, doc, Event::stored(seq, json));
    }

    pub fn publish_snapshot(&self, account: &str, doc: &str, covers_seq: i64, key_version: u64, nonce: &str, ciphertext: &str) {
        let json = json!({ "type": "snapshot", "doc": doc, "covers_seq": covers_seq, "key_version": key_version, "nonce": nonce, "ciphertext": ciphertext });
        self.publish(account, doc, Event::stored(0, json));
    }

    // Shared notes are channels too, under the pseudo-account "share" and the
    // doc name "share:<id>" (what clients subscribe to).
    /// With its signature: clients check it themselves (#77).
    pub fn publish_share_update(&self, share_id: &str, seq: i64, nonce: &str, ciphertext: &str, sig: &str) {
        let doc = format!("share:{share_id}");
        let json = json!({ "type": "update", "doc": doc, "seq": seq, "nonce": nonce, "ciphertext": ciphertext, "sig": sig });
        self.publish(SHARE, &doc, Event::stored(seq, json));
    }

    pub fn publish_share_snapshot(&self, share_id: &str, covers_seq: i64, nonce: &str, ciphertext: &str, sig: &str) {
        let doc = format!("share:{share_id}");
        let json = json!({ "type": "snapshot", "doc": doc, "covers_seq": covers_seq, "nonce": nonce, "ciphertext": ciphertext, "sig": sig });
        self.publish(SHARE, &doc, Event::stored(0, json));
    }

    /// The link stopped working: tell everyone who has it open.
    pub fn publish_share_revoked(&self, share_id: &str) {
        let doc = format!("share:{share_id}");
        let json = json!({ "type": "revoked", "doc": doc });
        self.publish(SHARE, &doc, Event { last: true, ..Event::stored(0, json) });
    }

    /// A shared note's presence (who's in it, where their cursor is): encrypted
    /// by the clients, relayed to the share's other sockets, never stored.
    fn publish_presence(&self, doc: &str, from: u64, data: &str) {
        self.presence_relayed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let json = json!({ "type": "presence", "doc": doc, "data": data });
        self.publish(SHARE, doc, Event { seq: 0, from, json: json.to_string().into(), last: false });
    }

    fn publish(&self, account: &str, doc: &str, ev: Event) {
        let tx = lock(&self.docs).get(&(account.to_string(), doc.to_string())).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(ev);
        }
    }

    /// Close every socket of an account (its sessions were revoked, e.g. a phrase change).
    pub fn kick(&self, account: &str) {
        if let Some(tx) = lock(&self.kicks).get(account) {
            let _ = tx.send(None);
        }
    }

    /// Close one session's sockets (it signed out, #146): those signed in with the token whose
    /// SHA-256 is `token_hash`. The account's other sessions keep theirs.
    pub fn kick_session(&self, account: &str, token_hash: &[u8]) {
        if let Some(tx) = lock(&self.kicks).get(account) {
            let _ = tx.send(Some(token_hash.into()));
        }
    }

    fn kicks(&self, account: &str) -> broadcast::Receiver<Kick> {
        let mut kicks = lock(&self.kicks);
        kicks.retain(|_, tx| tx.receiver_count() > 0);
        kicks.entry(account.into()).or_insert_with(|| broadcast::channel(4).0).subscribe()
    }

    /// For tests: ping (and re-check sessions) more often than every 30 s.
    pub fn set_ping_every(&self, every: Duration) {
        *lock(&self.ping_every) = every;
    }

    /// Open sockets right now (for the admin dashboard).
    pub fn connections(&self) -> usize {
        lock(&self.sockets).values().sum()
    }

    /// For the admin dashboard: open sockets (and how many are guests on a
    /// shared note's link), shared notes someone has open, presence relayed.
    pub fn stats(&self) -> Value {
        let (all, guests) = lock(&self.sockets)
            .iter()
            .fold((0, 0), |(a, g), (k, n)| (a + n, g + if k.starts_with("guest:") { *n } else { 0 }));
        let shared_open = lock(&self.docs).iter().filter(|((owner, _), tx)| owner == SHARE && tx.receiver_count() > 0).count();
        json!({
            "connections": all,
            "guest_connections": guests,
            "shared_notes_open": shared_open,
            "presence_relayed": self.presence_relayed.load(std::sync::atomic::Ordering::Relaxed),
        })
    }

    fn acquire(self: &Arc<Self>, account: &str) -> Option<SocketSlot> {
        let mut sockets = lock(&self.sockets);
        let n = sockets.entry(account.into()).or_default();
        if *n >= MAX_SOCKETS_PER_ACCOUNT {
            return None;
        }
        *n += 1;
        Some(SocketSlot { hub: self.clone(), account: account.into() })
    }
}

/// Counts a socket against its account's limit while it lives.
struct SocketSlot {
    hub: Arc<Hub>,
    account: String,
}

impl Drop for SocketSlot {
    fn drop(&mut self) {
        let mut sockets = lock(&self.hub.sockets);
        if let Some(n) = sockets.get_mut(&self.account) {
            *n -= 1;
            if *n == 0 {
                sockets.remove(&self.account);
            }
        }
    }
}

/// The pseudo-account shared notes' channels live under (account IDs are hex, so it can't clash).
const SHARE: &str = "share";

#[derive(Deserialize)]
#[serde(untagged)]
enum ClientMsg {
    Auth { auth: String },
    /// No account: only shared notes (with their read token) can be subscribed.
    Guest { #[allow(dead_code)] guest: bool },
    Sub { sub: String, #[serde(default)] after: i64, #[serde(default)] token: String },
    Unsub { unsub: String },
    /// Presence for a shared note this socket follows (opaque to the server).
    Presence { presence: String, data: String },
}

pub async fn live(State(st): State<AppState>, ClientIp(ip): ClientIp, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(64 * 1024).on_upgrade(move |socket| session(st, ip, socket))
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
}

fn account_for(st: &AppState, token: &str) -> Option<String> {
    let token = hex::decode(token).ok()?;
    session_account(&st.db(), &token).ok().flatten()
}

async fn send(socket: &mut WebSocket, v: Value) -> bool {
    socket.send(Message::Text(v.to_string().into())).await.is_ok()
}

async fn session(st: AppState, ip: std::net::IpAddr, mut socket: WebSocket) {
    // Sign in with the first message (not the URL, which ends up in logs) —
    // or, for someone opening a shared note without an account, say "guest".
    let first = tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else { return close(socket, 4401, "sign in first").await };
    let (mut token, account) = match serde_json::from_str(&text) {
        Ok(ClientMsg::Auth { auth }) => match account_for(&st, &auth) {
            Some(account) => (auth, Some(account)),
            None => return close(socket, 4401, "not signed in").await,
        },
        Ok(ClientMsg::Guest { .. }) => (String::new(), None),
        _ => return close(socket, 4401, "sign in first").await,
    };
    let hub = st.live_hub();
    // Guests have no account: their sockets count against their address.
    let slot_key = account.clone().unwrap_or_else(|| format!("guest:{ip}"));
    let Some(_slot) = hub.acquire(&slot_key) else { return close(socket, 4429, "too many connections").await };
    // (The version too: with live sync up, a page makes few API requests to learn it from.)
    if !send(&mut socket, json!({ "type": "ready", "v": crate::assets::current_version(&st).await })).await {
        return;
    }

    let (out_tx, mut out_rx) = mpsc::channel::<Arc<str>>(CHANNEL_SIZE);
    let mut subs: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut kicked = account.as_deref().map(|a| hub.kicks(a));
    let me = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
    // Presence messages this second (at most PRESENCE_PER_SECOND are relayed).
    let mut presence_window = (Instant::now(), 0u32);
    let ping_every = *lock(&hub.ping_every);
    let mut ping = tokio::time::interval(ping_every);
    ping.tick().await;
    let opened = Instant::now();
    // Set when the session expired: the client has until then to send a fresh token.
    let mut reauth_by: Option<Instant> = None;

    // Why it ended: a close code to send (None when the connection is already gone), and a word for the log.
    let (code, why): (Option<u16>, &str) = loop {
        tokio::select! {
            msg = socket.recv() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(_)) => break (None, "connection error"),
                    None => break (None, "client went away"),
                };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => break (None, "client closed"),
                    _ => continue,
                };
                match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(ClientMsg::Auth { auth }) => {
                        if account.is_none() || account_for(&st, &auth) != account { break (Some(4401), "not signed in") }
                        token = auth;
                        reauth_by = None;
                    }
                    Ok(ClientMsg::Guest { .. }) => continue,
                    Ok(ClientMsg::Sub { sub, after, token: share_token }) => {
                        if !subs.contains_key(&sub) && subs.len() >= MAX_SUBS_PER_SOCKET { continue }
                        // A shared note ("share:<id>", with its read token), or one of the account's own docs.
                        let channel = if let Some(share_id) = sub.strip_prefix("share:") {
                            // Each checks a read token, so they count with GET /shares/{id}.
                            if st.rate_limit(ip, "share-read", crate::shares::READS_PER_MINUTE).is_err() { break (Some(4429), "too many requests") }
                            let access = crate::shares::with_read_token(&st.db(), share_id, &share_token); // (lock released here)
                            match access {
                                Ok(share) if share.revoked => {
                                    if !send(&mut socket, json!({ "type": "revoked", "doc": sub })).await { break (None, "send failed") }
                                    continue;
                                }
                                Ok(_) => (SHARE.to_string(), share_id.to_string()),
                                Err(_) => {
                                    if !send(&mut socket, json!({ "type": "denied", "doc": sub })).await { break (None, "send failed") }
                                    continue;
                                }
                            }
                        } else {
                            match &account {
                                Some(a) if crate::valid_doc_id(&sub) => (a.clone(), sub.clone()),
                                _ => break (Some(4400), "invalid doc"),
                            }
                        };
                        if let Some(old) = subs.remove(&sub) { old.abort() }
                        // Subscribe before reading the history, so nothing committed in between is missed.
                        let (owner, doc) = channel;
                        let shared = owner == SHARE;
                        let mut rx = hub.doc(&owner, if shared { &sub } else { &doc }).subscribe();
                        let stored = if shared { Doc::Shared { share: &doc } } else { Doc::Private { account: &owner, doc: &doc } };
                        let history = stored.since(&st.db(), after.max(0));
                        let history = match history { Ok(h) => h, Err(_) => break (Some(1011), "server error") };
                        let up_to = history_up_to(&history, after);
                        let mut msg = history;
                        msg["type"] = "doc".into();
                        msg["doc"] = sub.clone().into();
                        if !send(&mut socket, msg).await { break (None, "send failed") }
                        let out = out_tx.clone();
                        let doc = sub.clone();
                        subs.insert(sub, tokio::spawn(async move {
                            loop {
                                match rx.recv().await {
                                    // Only skip what the history already had (see the module comment).
                                    Ok(ev) if ev.from != me && (ev.seq == 0 || ev.seq > up_to) => {
                                        if out.send(ev.json).await.is_err() || ev.last { break }
                                    }
                                    Ok(_) => {}
                                    Err(broadcast::error::RecvError::Lagged(_)) => {
                                        let resync: Arc<str> = json!({ "type": "resync", "doc": doc }).to_string().into();
                                        if out.send(resync).await.is_err() { break }
                                    }
                                    Err(broadcast::error::RecvError::Closed) => break,
                                }
                            }
                        }));
                    }
                    Ok(ClientMsg::Unsub { unsub }) => { if let Some(h) = subs.remove(&unsub) { h.abort() } }
                    Ok(ClientMsg::Presence { presence, data }) => {
                        // Only for a shared note this socket follows (so it showed the read token), small, and not too often.
                        // (A subscription that ended, its links turned off, doesn't count.)
                        let following = subs.get(&presence).is_some_and(|h| !h.is_finished());
                        if !presence.starts_with("share:") || !following || data.len() > MAX_PRESENCE_BYTES { continue }
                        if presence_window.0.elapsed() >= Duration::from_secs(1) { presence_window = (Instant::now(), 0) }
                        presence_window.1 += 1;
                        if presence_window.1 > PRESENCE_PER_SECOND { continue }
                        hub.publish_presence(&presence, me, &data);
                    }
                    Err(_) => break (Some(4400), "bad message"),
                }
            }
            Some(json) = out_rx.recv() => {
                if socket.send(Message::Text(json.as_ref().into())).await.is_err() { break (None, "send failed") }
            }
            _ = ping.tick() => {
                // Sessions expire after 15 minutes: rather than closing the socket (and
                // making the client reconnect through any proxy in between), ask for a
                // fresh token and give it a minute. A revoked session is kicked at once.
                // (Guests have no session.)
                if account.is_none() || account_for(&st, &token) == account {
                    reauth_by = None;
                } else if reauth_by.is_some_and(|by| Instant::now() > by) {
                    break (Some(4401), "session ended");
                } else if reauth_by.is_none() {
                    reauth_by = Some(Instant::now() + 2 * ping_every);
                    if !send(&mut socket, json!({ "type": "reauth" })).await { break (None, "send failed") }
                }
                if !send(&mut socket, json!({ "type": "ping", "v": crate::assets::current_version(&st).await })).await { break (None, "send failed") }
            }
            Some(which) = async { match kicked.as_mut() { Some(k) => k.recv().await.ok(), None => std::future::pending().await } } => {
                // Every session of the account, or this one's (signed out: #146); another's isn't ours.
                let ours = match &which {
                    None => true,
                    Some(hash) => hex::decode(&token).is_ok_and(|t| crate::sig::sha256(&t).as_slice() == &hash[..]),
                };
                if ours { break (Some(4401), if which.is_some() { "signed out" } else { "session revoked" }) }
            }
        }
    };
    for (_, h) in subs {
        h.abort();
    }
    // No account in the log: just how long it lived and why it ended (for checking proxies and tunnels).
    println!("live: socket closed after {}s ({why})", opened.elapsed().as_secs());
    if let Some(code) = code {
        close(socket, code, why).await;
    }
}

/// The highest seq a history response covers (its last update, or its snapshot).
fn history_up_to(history: &Value, after: i64) -> i64 {
    let last_update = history["updates"].as_array().and_then(|u| u.last()).and_then(|u| u["seq"].as_i64());
    let snapshot = history["snapshot"]["covers_seq"].as_i64();
    last_update.into_iter().chain(snapshot).fold(after, i64::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_count_sockets_guests_open_shared_notes_and_presence() {
        let hub = Arc::new(Hub::default());
        let _a = hub.acquire("account-a").unwrap();
        let _g = hub.acquire("guest:203.0.113.5").unwrap();
        let _rx = hub.doc(SHARE, "share:abc").subscribe();
        let _private = hub.doc("account-a", "index").subscribe();
        hub.publish_presence("share:abc", 1, "x");
        let s = hub.stats();
        assert_eq!((s["connections"].as_u64(), s["guest_connections"].as_u64()), (Some(2), Some(1)));
        assert_eq!((s["shared_notes_open"].as_u64(), s["presence_relayed"].as_u64()), (Some(1), Some(1)));
        drop(_g);
        assert_eq!(hub.stats()["guest_connections"], 0);
    }
}
