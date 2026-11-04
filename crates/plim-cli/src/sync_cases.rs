//! The sync cases (web/tests/fixtures/sync-cases.json, #441), played with the terminal client's
//! engine (sync.rs) against the real server in process. The web app plays the same cases with
//! its engine (web/tests/sync-cases.test.mjs), against a fake these keep honest.
//!
//! Where a case has the server lose or forge something, its rows are changed directly, as a
//! server that misbehaves would.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use yrs::{Text, Transact};

use plim_core::crypto::{Identity, random_bytes, share_keys};
use plim_core::sig::{action, share_aad};

use crate::api::ApiError;
use crate::notes;
use crate::session::Session;
use crate::sync::{DocSync, Events, Rollback, ShareHome, Status};
use crate::sync_tests::{Server, device, make_share, server_with, text_state, vault};

/// The note the cases are about (a private one's id: hex, as the server takes).
const DOC: &str = "c0ffee";

#[tokio::test]
async fn the_sync_cases() {
    let fixture: Value = serde_json::from_str(include_str!("../../../web/tests/fixtures/sync-cases.json")).unwrap();
    let mut failed = Vec::new();
    for c in fixture["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        match play(c).await {
            Ok(()) => println!("  ok   sync case: {name}"),
            Err(e) => failed.push(format!("  FAIL sync case: {name}\n       {e:#}")),
        }
    }
    assert!(failed.is_empty(), "\n{}", failed.join("\n"));
}

/// What a device's engine said since it last opened the note.
#[derive(Default)]
struct Said {
    rollbacks: Mutex<Vec<Rollback>>,
    status: Mutex<Option<Status>>,
    forged: Mutex<usize>,
}

impl Events for Said {
    fn status(&self, _: &str, s: Status) {
        *self.status.lock().unwrap() = Some(s);
    }
    fn rollback(&self, r: Rollback) {
        self.rollbacks.lock().unwrap().push(r);
    }
    fn forged(&self, _: &str) {
        *self.forged.lock().unwrap() += 1;
    }
}

/// A device: its own session and storage (outbox, what it saw the server confirm), kept across opens.
struct Device {
    sess: Arc<Session>,
    sync: Option<DocSync>,
    said: Arc<Said>,
}

struct Play {
    srv: Server,
    id: Arc<Identity>,
    /// The account's own session, for what another device of it does (close a note, turn off links).
    owner: Arc<Session>,
    /// What the device thinks the server takes (a case's clientMaxBlob: an older limit).
    client_max_blob: usize,
    /// Requests the server had refused (4xx) when the case began.
    refused_before: u64,
    /// A shared note's id and seed (an edit link's secret).
    share: Option<(String, [u8; 32])>,
    shared: bool,
    devices: HashMap<String, Device>,
}

/// The steps, with each { repeat, steps } spelled out ('{i}' in their text: the count).
fn expand(steps: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for s in steps {
        match s.get("repeat").and_then(Value::as_u64) {
            None => out.push(s.clone()),
            Some(n) => {
                let inner = expand(s["steps"].as_array().map(Vec::as_slice).unwrap_or_default());
                for i in 0..n {
                    for x in &inner {
                        out.push(serde_json::from_str(&x.to_string().replace("{i}", &i.to_string())).unwrap());
                    }
                }
            }
        }
    }
    out
}

async fn play(c: &Value) -> Result<()> {
    let max_blob = c["maxBlob"].as_u64().map_or(1 << 20, |n| n as usize);
    let srv = server_with(max_blob).await;
    let id = vault(&srv).await;
    let owner = device(&srv, &id).await;
    let client_max_blob = c["clientMaxBlob"].as_u64().map_or(max_blob, |n| n as usize);
    let refused_before = refused(&srv);
    let mut p = Play { srv, id, owner, client_max_blob, refused_before, share: None, shared: c["note"] == "shared", devices: HashMap::new() };
    for (n, step) in expand(c["steps"].as_array().context("no steps")?).iter().enumerate() {
        let short: String = step.to_string().chars().take(120).collect();
        let at = format!("step {} ({short})", n + 1);
        if let Some(expect) = step.get("expect") {
            p.check(expect).with_context(|| at.clone())?;
            continue;
        }
        let refused = match p.step(step).await {
            Ok(()) => None,
            Err(e) => match e.downcast_ref::<ApiError>().and_then(ApiError::status) {
                Some(status) => Some(status),
                None => return Err(e.context(at)),
            },
        };
        if let Some(want) = step["refused"].as_u64() {
            ensure!(refused == Some(want as u16), "{at}: should be refused with {want}, was {refused:?}");
        } else if let Some(status) = refused {
            let tolerated = step["tolerate"].as_array().is_some_and(|t| t.iter().any(|s| s.as_u64() == Some(u64::from(status))));
            ensure!(tolerated, "{at}: refused with {status}");
        }
    }
    Ok(())
}

impl Play {
    async fn step(&mut self, step: &Value) -> Result<()> {
        if let Some(op) = step["server"].as_str() {
            return self.server_step(op, step).await;
        }
        let name = step["on"].as_str().context("a step needs `on` or `server`")?.to_string();
        let what = step["do"].as_str().context("a device step needs `do`")?;
        if what == "open" {
            return self.open(&name, step["link"].as_str().unwrap_or("edit")).await;
        }
        let d = self.devices.get_mut(&name).with_context(|| format!("{name} hasn't opened the note"))?;
        let s = d.sync.as_mut().with_context(|| format!("{name} hasn't opened the note"))?;
        let text = step["text"].as_str().unwrap_or_default().repeat(step["times"].as_u64().unwrap_or(1) as usize);
        match what {
            "type" => {
                let t = notes::body_text(&s.doc);
                let mut txn = s.doc.transact_mut();
                let at = match step["at"].as_u64() {
                    Some(n) => n as u32,
                    None => t.len(&txn),
                };
                t.insert(&mut txn, at, &text);
                Ok(())
            }
            // (The terminal client's whole-text write: what `plim` and the connector use.)
            "replace" => {
                notes::set_body(&s.doc, &text);
                Ok(())
            }
            "flush" => s.flush().await,
            "pull" => s.pull().await.map(|_| ()),
            "compact" => {
                s.maybe_compact().await;
                Ok(())
            }
            "snapshot" => s.snapshot().await,
            "acknowledge" => s.accept_server_state(),
            other => bail!("no such step: {other}"),
        }
    }

    /// A new engine for the note on this device (the last one dropped, unflushed), loaded.
    async fn open(&mut self, name: &str, link: &str) -> Result<()> {
        if !self.devices.contains_key(name) {
            let sess = device(&self.srv, &self.id).await;
            sess.set_max_blob(self.client_max_blob);
            self.devices.insert(name.into(), Device { sess, sync: None, said: Arc::default() });
        }
        let d = self.devices.get_mut(name).unwrap();
        d.sync = None;
        d.said = Arc::default();
        let mut sync = if self.shared {
            let (share, seed) = self.share.as_ref().context("open a shared note: make it first ({ server: 'share' })")?;
            let home = if link == "view" {
                let k = share_keys(seed);
                ShareHome::read_only(share, k.enc_key, Some(k.pubkey))
            } else {
                ShareHome::from_seed(share, seed)
            };
            DocSync::new_share(d.sess.clone(), Arc::new(home), d.said.clone())?
        } else {
            DocSync::new(d.sess.clone(), DOC, d.said.clone())?
        };
        let loaded = sync.load().await;
        d.sync = Some(sync);
        loaded
    }

    async fn server_step(&mut self, op: &str, step: &Value) -> Result<()> {
        let (updates, snapshots, key) = self.tables();
        match op {
            "share" => {
                let seed = random_bytes::<32>();
                let id = make_share(&self.owner, &seed, &text_state(step["text"].as_str().unwrap_or_default())).await;
                self.share = Some((id, seed));
            }
            "drop-update" => {
                let seq = step["seq"].as_i64().context("drop-update needs `seq`")?;
                self.srv.state.db().execute(&format!("DELETE FROM {updates} WHERE {key} = ?1 AND seq = ?2"), params![self.key_value(), seq])?;
            }
            "drop-updates" => {
                self.srv.state.db().execute(&format!("DELETE FROM {updates} WHERE {key} = ?1"), params![self.key_value()])?;
            }
            "close" => {
                let o = &self.owner;
                o.api.signed(&o.identity, &o.account_id, reqwest::Method::POST, &format!("/docs/{DOC}/close"), action::CLOSE_DOC, DOC).await?;
            }
            "turn-off-links" => {
                let o = &self.owner;
                let share = self.key_value();
                o.api.signed(&o.identity, &o.account_id, reqwest::Method::POST, &format!("/shares/{share}/revoke"), action::REVOKE_SHARE, &share).await?;
            }
            "forge-update" => {
                // Encrypted with the share's key (anyone with a view link has it), not signed with its signing key.
                let (share, seed) = self.share.as_ref().context("forge-update: no shared note")?;
                let k = share_keys(seed);
                let s = plim_core::crypto::encrypt(&k.enc_key, &text_state(step["text"].as_str().unwrap_or_default()), &share_aad(share, "update"));
                let db = self.srv.state.db();
                let head: i64 = db.query_row(
                    &format!("SELECT MAX((SELECT COALESCE(MAX(seq), 0) FROM {updates} WHERE {key} = ?1), (SELECT COALESCE(MAX(covers_seq), 0) FROM {snapshots} WHERE {key} = ?1))"),
                    [share],
                    |r| r.get(0),
                )?;
                db.execute(
                    &format!("INSERT INTO {updates} (share_id, seq, nonce, ciphertext, sig, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0)"),
                    params![share, head + 1, s.nonce.to_vec(), s.ciphertext, vec![0u8; 64]],
                )?;
            }
            other => bail!("no such server step: {other}"),
        }
        Ok(())
    }

    /// Where the note's history is: its tables and the column naming it.
    fn tables(&self) -> (&'static str, &'static str, &'static str) {
        if self.shared { ("share_updates", "share_snapshots", "share_id") } else { ("updates", "snapshots", "doc_id") }
    }

    fn key_value(&self) -> String {
        match &self.share {
            Some((id, _)) => id.clone(),
            None => DOC.into(),
        }
    }

    fn server_state(&self) -> Result<Value> {
        let (updates, snapshots, key) = self.tables();
        let db = self.srv.state.db();
        let n: i64 = db.query_row(&format!("SELECT COUNT(*) FROM {updates} WHERE {key} = ?1"), [self.key_value()], |r| r.get(0))?;
        let covers: Option<i64> = db
            .query_row(&format!("SELECT MAX(covers_seq) FROM {snapshots} WHERE {key} = ?1"), [self.key_value()], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(json!({ "updates": n, "snapshot": covers, "refused": refused(&self.srv) - self.refused_before }))
    }

    fn device_state(&self, name: &str) -> Result<Value> {
        let d = self.devices.get(name).with_context(|| format!("no device {name}"))?;
        let s = d.sync.as_ref().with_context(|| format!("{name} hasn't opened the note"))?;
        let rollbacks: Vec<Value> =
            d.said.rollbacks.lock().unwrap().iter().map(|r| json!({ "missing": r.missing, "incomplete": r.incomplete })).collect();
        let status = d.said.status.lock().unwrap().map(|s| match s {
            Status::Saved => "saved",
            Status::Saving => "saving",
            Status::Offline => "offline",
            Status::Error => "error",
            Status::TooLarge => "too-large",
            Status::Full => "full",
            Status::LinkOff => "link-off",
        });
        Ok(json!({
            "text": notes::body(&s.doc),
            "pending": d.sess.store.outbox_list(&s.doc_id)?.len(),
            "rollbacks": rollbacks,
            "forged": *d.said.forged.lock().unwrap(),
            "status": status,
            "gone": s.is_gone(),
            "writable": s.writable(),
            "lastSeq": s.last_seq,
            "snapshotSeq": s.snapshot_seq,
        }))
    }

    fn check(&self, expect: &Value) -> Result<()> {
        for (who, want) in expect.as_object().context("expect: an object")? {
            let got = if who == "server" { self.server_state()? } else { self.device_state(who)? };
            for (k, v) in want.as_object().context("expect: an object per device")? {
                let v = match v.get("sameAs").and_then(Value::as_str) {
                    Some(other) => self.device_state(other)?[k].clone(),
                    None => v.clone(),
                };
                matches(&got[k], &v).map_err(|e| anyhow!("{who}.{k}: {e}"))?;
            }
        }
        Ok(())
    }
}

/// Requests the server refused (4xx) since it started (a body over its limit too).
fn refused(srv: &Server) -> u64 {
    srv.refused.load(std::sync::atomic::Ordering::Relaxed)
}

fn matches(got: &Value, want: &Value) -> Result<()> {
    let short = |v: &Value| match v.as_str() {
        Some(s) if s.chars().count() > 80 => format!("{:?}… ({} chars)", s.chars().take(80).collect::<String>(), s.chars().count()),
        _ => v.to_string(),
    };
    if let Some(min) = want.get("atLeast").and_then(Value::as_f64) {
        ensure!(got.as_f64().is_some_and(|g| g >= min), "expected at least {min}, got {}", short(got));
        return Ok(());
    }
    ensure!(got == want, "expected {}, got {}", short(want), short(got));
    Ok(())
}
