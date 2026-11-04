//! Sharing a note from the terminal (#130), as the web app does (web/app.js createShare
//! and stopSharing): a share is made with the note's text and history, the note list
//! points at it, and the old home goes. Stopping brings the text and history back.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use serde_json::json;
use plim_core::crypto::{HeldKeys, holder_keys, open_held_keys, random_bytes, seal_held_keys, share_keys};
use plim_core::sig::action;

use crate::api::{Api, ApiError};
use crate::notes::{self, Holder, NoteMeta, ShareRef};
use crate::session::Session;
use crate::sync::{DocSync, NoEvents, ShareHome};

pub struct Links {
    /// Only with the share's seed (its owner, or someone given the edit link).
    pub edit: Option<String>,
    pub view: Option<String>,
    /// Shared with you through a link of your own (#369): that link.
    pub own: Option<String>,
}

/// A share's links, as web/core/share.js makes them: the note's address (#299), the share's id and key after the `#`.
pub fn links(server: &str, note_id: &str, r: &ShareRef) -> Result<Links> {
    let key = |s: &str| -> Result<[u8; 32]> { B64.decode(s)?.try_into().map_err(|_| anyhow::anyhow!("a key isn't 32 bytes")) };
    if let Some(h) = &r.holder {
        return Ok(Links { edit: None, view: None, own: Some(crate::link::holder_url(server, note_id, &h.id, &key(&h.secret)?)) });
    }
    let at = |frag: String| format!("{}#k={}.{frag}", crate::link::note_url(server, note_id), r.id);
    if let Some(seed) = &r.seed {
        let seed = key(seed)?;
        let k = share_keys(&seed);
        return Ok(Links {
            edit: Some(at(format!("e.{}", B64URL.encode(seed)))),
            view: Some(at(format!("r.{}.{}", B64URL.encode(k.enc_key), B64URL.encode(k.pubkey)))),
            own: None,
        });
    }
    let view = r.enc_key.as_deref().map(|e| -> Result<String> {
        let pubkey = r.pubkey.as_deref().map(key).transpose()?.map(|p| format!(".{}", B64URL.encode(p))).unwrap_or_default();
        Ok(at(format!("r.{}{pubkey}", B64URL.encode(key(e)?))))
    });
    Ok(Links { edit: None, view: view.transpose()?, own: None })
}

/// What a link of someone's own opens now (#369): its holder's row, fetched with its token, and
/// the share's keys opened from it: the share's id, and its home.
pub async fn resolve_holder(api: &Api, holder_id: &str, secret: &[u8; 32]) -> Result<(String, ShareHome)> {
    resolve_holder_at(api, holder_id, secret).await.map(|(id, home, _)| (id, home))
}

/// The same, and when the holder was made (seconds, if the server says: #505, an AI reads a note's
/// history only from when it was given it).
pub async fn resolve_holder_at(api: &Api, holder_id: &str, secret: &[u8; 32]) -> Result<(String, ShareHome, Option<u64>)> {
    let hk = holder_keys(secret);
    let row = api.get_holder(holder_id, &hex::encode(hk.token)).await.map_err(|e| match e.status() {
        Some(410) => anyhow::anyhow!("this link was turned off (taken back, or the note's sharing stopped)"),
        Some(404) => anyhow::anyhow!("this link doesn't work (taken back, or the note deleted)"),
        _ => anyhow::Error::from(e),
    })?;
    let share_id = row["share_id"].as_str().context("the holder's row names no share")?.to_string();
    let field = |k: &str| -> Result<Vec<u8>> { Ok(B64.decode(row[k].as_str().context("a bad holder row")?)?) };
    let held = open_held_keys(&hk.seal_key, holder_id, &share_id, &field("nonce")?, &field("ciphertext")?)
        .map_err(|_| anyhow::anyhow!("this link's keys don't open: is the link complete?"))?;
    let home = match held {
        HeldKeys::Edit { seed } => ShareHome::from_seed(&share_id, &seed),
        HeldKeys::Read { enc_key, pubkey } => ShareHome::read_only(&share_id, enc_key, Some(pubkey)),
    };
    Ok((share_id, home, row["created_at"].as_u64()))
}

fn key32(b64: &str) -> Result<[u8; 32]> {
    B64.decode(b64)?.try_into().map_err(|_| anyhow::anyhow!("a key isn't 32 bytes"))
}

/// Where a shared note of the list is, and its keys: from its ref; shared with you through a link
/// of your own (#369), from the holder's row (the note's links may have been replaced since).
pub async fn home_of(sess: &Session, r: &ShareRef) -> Result<ShareHome> {
    match &r.holder {
        Some(h) => Ok(resolve_holder(&sess.api, &h.id, &key32(&h.secret)?).await?.1),
        None => r.home(),
    }
}

/// A link of their own for `label` (#369): a holder registered with the share's keys sealed to
/// it (the seed to edit, the read keys to view), kept in the note's entry; the caller saves the list.
pub async fn add_holder(sess: &Session, index: &DocSync, meta: &NoteMeta, label: &str, edit: bool) -> Result<Holder> {
    let r = meta.share.as_ref().with_context(|| format!("\"{}\" isn't shared", meta.title))?;
    if r.role.as_deref() != Some("owner") {
        bail!("only whoever shared \"{}\" can give out links to it", meta.title);
    }
    let seed = key32(r.seed.as_deref().context("this share's seed isn't here")?)?;
    let k = share_keys(&seed);
    let secret = random_bytes::<32>();
    let id = hex::encode(random_bytes::<16>());
    let hk = holder_keys(&secret);
    let held = if edit { HeldKeys::Edit { seed } } else { HeldKeys::Read { enc_key: k.enc_key, pubkey: k.pubkey } };
    let sealed = seal_held_keys(&hk.seal_key, &id, &r.id, &held);
    sess.api
        .post(
            "/holders",
            &json!({
                "holder_id": id, "share_id": r.id, "role": held.role(),
                "token_hash": B64.encode(plim_core::sig::sha256(&hk.token)),
                "nonce": B64.encode(sealed.nonce), "ciphertext": B64.encode(&sealed.ciphertext),
            }),
        )
        .await?;
    let holder = Holder { id, secret: B64.encode(secret), role: held.role().into(), label: label.into(), created: notes::now_ms() };
    let mut next = r.clone();
    next.holders.push(holder.clone());
    notes::set_share(&index.doc, &meta.id, Some(&next));
    Ok(holder)
}

/// People's own links follow the note (#369): each holder's row re-sealed to the new share. One
/// that fails is told (its link says "turned off" until the links are replaced again).
async fn reseal_holders(sess: &Session, r: &ShareRef) {
    let Some(seed) = r.seed.as_deref().and_then(|s| key32(s).ok()) else { return };
    let k = share_keys(&seed);
    for h in &r.holders {
        let Ok(secret) = key32(&h.secret) else { continue };
        let hk = holder_keys(&secret);
        let held = if h.role == "edit" { HeldKeys::Edit { seed } } else { HeldKeys::Read { enc_key: k.enc_key, pubkey: k.pubkey } };
        let sealed = seal_held_keys(&hk.seal_key, &h.id, &r.id, &held);
        let body = json!({ "share_id": r.id, "role": h.role, "nonce": B64.encode(sealed.nonce), "ciphertext": B64.encode(&sealed.ciphertext) });
        if let Err(e) = sess.api.request(reqwest::Method::PUT, &format!("/holders/{}", h.id), Some(&body)).await {
            eprintln!("warning: {}'s link couldn't follow the new links ({e}); replace the links again to fix it", h.label);
        }
    }
}

/// A new share (random id and seed) for `state`, with `from`'s history copied in.
async fn new_share(sess: &Arc<Session>, state: &[u8], from: &DocSync) -> Result<(ShareRef, DocSync)> {
    let seed = random_bytes::<32>();
    let id = hex::encode(random_bytes::<16>());
    let share = DocSync::new_share(sess.clone(), Arc::new(ShareHome::from_seed(&id, &seed)), Arc::new(NoEvents))?;
    share.create_share(state).await?;
    // Its history comes along. A failure only loses history, so it doesn't stop the move.
    if let Err(e) = from.copy_versions_to(&share).await {
        eprintln!("warning: couldn't bring the note's history along: {e:#}");
    }
    let r = ShareRef { id, seed: Some(B64.encode(seed)), enc_key: None, pubkey: None, role: Some("owner".into()), ..Default::default() };
    Ok((r, share))
}

/// A destructive request, signed with the account's key (#144): `action` on `target`.
async fn signed(sess: &Session, method: reqwest::Method, path: &str, action: &str, target: &str) -> Result<serde_json::Value, ApiError> {
    sess.api.signed(&sess.identity, &sess.account_id, method, path, action, target).await
}

/// A private note closed to writes ("close") or open to them again ("reopen"). Signed (#144).
async fn close_or_reopen(sess: &Session, note_id: &str, what: &str) -> Result<serde_json::Value, ApiError> {
    let act = if what == "close" { action::CLOSE_DOC } else { action::REOPEN_DOC };
    signed(sess, reqwest::Method::POST, &format!("/docs/{note_id}/{what}"), act, note_id).await
}

/// Delete a share for good (its links stop working). Already gone counts as done.
async fn delete_share(sess: &Session, id: &str) -> Result<()> {
    match signed(sess, reqwest::Method::DELETE, &format!("/shares/{id}"), action::DELETE_SHARE, id).await {
        Ok(_) | Err(ApiError::Http(404, _)) => Ok(()),
        Err(e) => Err(e).context("couldn't turn off the links, so nothing changed; try again"),
    }
}

/// Share a note (`new_links`: replace a shared note's links). Returns where it lives now;
/// the caller saves the note list.
pub async fn share(sess: &Arc<Session>, index: &DocSync, meta: &NoteMeta, new_links: bool) -> Result<ShareRef> {
    match &meta.share {
        Some(r) if !new_links => Ok(r.clone()),
        Some(old) => {
            if old.role.as_deref() != Some("owner") {
                bail!("only whoever shared \"{}\" can replace its links", meta.title);
            }
            let mut from = DocSync::new_share(sess.clone(), Arc::new(old.home()?), Arc::new(NoEvents))?;
            from.load().await?;
            from.flush().await?;
            let (r, _) = new_share(sess, &from.state(), &from).await?;
            // The old links stop working first, for sure, or nothing changes.
            if let Err(e) = delete_share(sess, &old.id).await {
                let _ = delete_share(sess, &r.id).await;
                return Err(e);
            }
            let mut r = r;
            r.holders = old.holders.clone();
            notes::set_share(&index.doc, &meta.id, Some(&r));
            reseal_holders(sess, &r).await;
            Ok(r)
        }
        None => {
            let mut private = DocSync::new(sess.clone(), &meta.id, Arc::new(NoEvents))?;
            private.load().await?;
            private.flush().await?;
            if private.has_pending()? {
                bail!("couldn't upload its latest edits first (offline?)");
            }
            // Closed to writes first, then its final text read: what other devices send from
            // now is refused, kept there, and moved into the share once they hear (#119).
            close_or_reopen(sess, &meta.id, "close").await?;
            let made = async {
                private.pull().await?;
                new_share(sess, &private.state(), &private).await
            }
            .await;
            let (r, _) = match made {
                Ok(m) => m,
                Err(e) => {
                    let _ = close_or_reopen(sess, &meta.id, "reopen").await;
                    return Err(e);
                }
            };
            notes::set_share(&index.doc, &meta.id, Some(&r));
            // (The private copy goes once the list says where the note is: the caller's
            // remove_private, after saving the list.)
            Ok(r)
        }
    }
}

/// After sharing a private note and saving the list: its private copy on the server goes.
pub async fn remove_private(sess: &Session, note_id: &str) {
    if let Err(e) = signed(sess, reqwest::Method::DELETE, &format!("/docs/{note_id}"), action::DELETE_DOC, note_id).await {
        eprintln!("warning: couldn't remove the note's private copy: {e}");
    }
}

/// Stop sharing a note: its text and history back in its own doc, then the share deleted
/// (its links stop working). Returns nothing to print; the caller saves the note list.
pub async fn unshare(sess: &Arc<Session>, index: &DocSync, meta: &NoteMeta) -> Result<()> {
    let r = meta.share.as_ref().with_context(|| format!("\"{}\" isn't shared", meta.title))?;
    if r.role.as_deref() != Some("owner") {
        bail!("only whoever shared \"{}\" can stop sharing it (you can remove it from your list: plim rm)", meta.title);
    }
    let mut from = DocSync::new_share(sess.clone(), Arc::new(r.home()?), Arc::new(NoEvents))?;
    from.load().await?;
    from.flush().await?;
    close_or_reopen(sess, &meta.id, "reopen").await?; // (closed when it was shared)
    let mut private = DocSync::new(sess.clone(), &meta.id, Arc::new(NoEvents))?;
    private.load().await?;
    private.apply_local(&from.state())?;
    private.flush().await?;
    if private.has_pending()? {
        bail!("couldn't save the note (offline?); it's still shared");
    }
    if let Err(e) = from.copy_versions_to(&private).await {
        eprintln!("warning: couldn't bring the note's history back: {e:#}");
    }
    // The links stop working first, for sure, or the note stays shared. (The private copy
    // left behind holds the same text: trying again merges into it.)
    delete_share(sess, &r.id).await?;
    notes::set_share(&index.doc, &meta.id, None);
    // People's own links (#369): their rows go too (pointing at a share that's gone, they'd only say so).
    for h in &r.holders {
        if let Err(e) = signed(sess, reqwest::Method::DELETE, &format!("/holders/{}", h.id), action::DELETE_HOLDER, &h.id).await
            && !matches!(e, ApiError::Http(404, _))
        {
            eprintln!("warning: couldn't remove {}'s link's row: {e}", h.label);
        }
    }
    Ok(())
}
