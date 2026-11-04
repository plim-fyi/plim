//! A shared note's link (#130; as web/core/share.js): `<server>/s/<id>#e.<seed>` (edit) or
//! `#r.<key>[.<pubkey>]` (view), base64url without padding. The keys are in the part
//! after `#`, which browsers never send: with only a link, `plim` can read (and with an
//! edit link, write) that one note, with no account or passphrase.
//!
//! And a note's own address (#299; web/core/noteurl.js): `<server>/n/<note id>`, a name for one
//! of your notes, taken anywhere a title or an id is (`plim cat https://…/n/<id>`), and
//! printed after a write, so a script or an agent can point at the note. No key in it: it
//! opens for whoever is signed in to the note's vault.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};

use crate::notes::ShareRef;
use crate::sync::ShareHome;

#[derive(Debug, PartialEq)]
pub struct Link {
    /// The server it's on, e.g. `https://plim.fyi`.
    pub server: String,
    pub share_id: String,
    /// The note's id, from a link on its address (#299: `/n/<id>#k=<share id>.…`); None from a `/s/` link.
    pub note_id: Option<String>,
    pub keys: LinkKeys,
}

#[derive(Debug, PartialEq)]
pub enum LinkKeys {
    Edit { seed: [u8; 32] },
    /// A view link; links from before #77 have no public key (nothing to check with).
    View { enc_key: [u8; 32], pubkey: Option<[u8; 32]> },
}

/// A link, or None if `s` isn't one (then it's a note's title, id or address).
pub fn parse(s: &str) -> Option<Link> {
    let (before, fragment) = s.trim().split_once('#')?;
    let share_id_ok = |id: &str| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit());
    // On the note's address: /n/<note id>#k=<share id>.<key part>; before #299: /s/<share id>#<key part>.
    let (server, share_id, note_id, fragment) = match fragment.strip_prefix("k=") {
        Some(keyed) => {
            let n = parse_note_url(before)?;
            let (share_id, rest) = keyed.split_once('.')?;
            (n.server, share_id.to_string(), Some(n.id), rest)
        }
        None => {
            let (server, id) = before.rsplit_once("/s/")?;
            (server.trim_end_matches('/').to_string(), id.to_string(), None, fragment)
        }
    };
    if !share_id_ok(&share_id) || !(server.starts_with("https://") || server.starts_with("http://")) {
        return None;
    }
    let key = |b64: &str| -> Option<[u8; 32]> { (b64.len() == 43).then(|| B64URL.decode(b64).ok()?.try_into().ok()).flatten() };
    let mut parts = fragment.split('.');
    let keys = match (parts.next()?, parts.next(), parts.next(), parts.next()) {
        ("e", Some(seed), None, None) => LinkKeys::Edit { seed: key(seed)? },
        ("r", Some(enc), pubkey, None) => LinkKeys::View { enc_key: key(enc)?, pubkey: match pubkey { Some(p) => Some(key(p)?), None => None } },
        _ => return None,
    };
    Some(Link { server, share_id: share_id.to_ascii_lowercase(), note_id, keys })
}

/// A link of someone's own to a shared note (#369; web/core/share.js holderLink): the note's address
/// with `#h=<holder id>.<secret>` after it (or `/s/<holder id>#h=…`, as the guest page takes it).
/// The holder's row on the server says which share the note is in now, and holds its keys.
#[derive(Debug, PartialEq)]
pub struct HolderLink {
    pub server: String,
    pub holder_id: String,
    pub note_id: Option<String>,
    pub secret: [u8; 32],
}

pub fn parse_holder(s: &str) -> Option<HolderLink> {
    let (before, fragment) = s.trim().split_once('#')?;
    let (holder_id, secret) = fragment.strip_prefix("h=")?.split_once('.')?;
    let id_ok = holder_id.len() == 32 && holder_id.bytes().all(|b| b.is_ascii_hexdigit());
    let (server, note_id) = match parse_note_url(before) {
        Some(n) => (n.server, Some(n.id)),
        None => {
            let (server, id) = before.rsplit_once("/s/")?;
            if id.trim_end_matches('/') != holder_id {
                return None;
            }
            (server.trim_end_matches('/').to_string(), None)
        }
    };
    if !id_ok || !(server.starts_with("https://") || server.starts_with("http://")) || secret.len() != 43 {
        return None;
    }
    let secret: [u8; 32] = B64URL.decode(secret).ok()?.try_into().ok()?;
    Some(HolderLink { server, holder_id: holder_id.to_ascii_lowercase(), note_id, secret })
}

/// Someone's own link to a note of yours, or your own to someone's.
pub fn holder_url(server: &str, note_id: &str, holder_id: &str, secret: &[u8; 32]) -> String {
    format!("{}#h={holder_id}.{}", note_url(server, note_id), B64URL.encode(secret))
}

/// A note's address: the server it's on and the note's id, or None if `s` isn't one.
#[derive(Debug, PartialEq)]
pub struct NoteUrl {
    pub server: String,
    pub id: String,
}

pub fn parse_note_url(s: &str) -> Option<NoteUrl> {
    let s = s.trim();
    let s = s.split_once('#').map_or(s, |(before, _)| before); // (a fragment: not the server's, ignored here)
    let (server, id) = s.rsplit_once("/n/")?;
    let id = id.trim_end_matches('/');
    if !(server.starts_with("https://") || server.starts_with("http://")) || !is_note_id(id) {
        return None;
    }
    Some(NoteUrl { server: server.trim_end_matches('/').to_string(), id: id.to_ascii_lowercase() })
}

/// A note's id as the apps make them: a UUID, `8-4-4-4-12` hex.
fn is_note_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A note's address on `server`.
pub fn note_url(server: &str, id: &str) -> String {
    format!("{}/n/{id}", server.trim_end_matches('/'))
}

impl Link {
    pub fn home(&self) -> ShareHome {
        match &self.keys {
            LinkKeys::Edit { seed } => ShareHome::from_seed(&self.share_id, seed),
            LinkKeys::View { enc_key, pubkey } => ShareHome::read_only(&self.share_id, *enc_key, *pubkey),
        }
    }

    /// As the note list keeps it (web/app.js `{ id, seed | encKey (+ pubkey) }`), to add it there.
    pub fn share_ref(&self) -> ShareRef {
        match &self.keys {
            LinkKeys::Edit { seed } => ShareRef { id: self.share_id.clone(), seed: Some(B64.encode(seed)), enc_key: None, pubkey: None, role: None, ..Default::default() },
            LinkKeys::View { enc_key, pubkey } => ShareRef {
                id: self.share_id.clone(),
                seed: None,
                enc_key: Some(B64.encode(enc_key)),
                pubkey: pubkey.map(|p| B64.encode(p)),
                role: None, ..Default::default()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_and_view_links_and_not_links() {
        let seed = [7u8; 32];
        let e = format!("https://plim.example/s/0123456789abcdef0123456789abcdef#e.{}", B64URL.encode(seed));
        let l = parse(&e).unwrap();
        assert_eq!((l.server.as_str(), l.share_id.as_str(), l.note_id.as_deref()), ("https://plim.example", "0123456789abcdef0123456789abcdef", None));
        assert_eq!(l.keys, LinkKeys::Edit { seed });
        assert!(l.home().writable());
        let k = plim_core::crypto::share_keys(&seed);
        let v = format!("http://localhost:3000/s/0123456789abcdef0123456789abcdef#r.{}.{}", B64URL.encode(k.enc_key), B64URL.encode(k.pubkey));
        let l = parse(&v).unwrap();
        assert_eq!(l.keys, LinkKeys::View { enc_key: k.enc_key, pubkey: Some(k.pubkey) });
        assert!(!l.home().writable());
        // The same as web/core/share.js makes: what the note list keeps, decoded back.
        assert!(l.share_ref().home().is_ok());
        for not in ["Groceries", "https://plim.example/s/xyz#e.abc", "https://plim.example/s/0123456789abcdef0123456789abcdef", "ftp://x/s/0123456789abcdef0123456789abcdef#e.AAAA"] {
            assert!(parse(not).is_none(), "{not}");
        }
        assert!(parse(&format!("{e}.extra")).is_none(), "an edit link has one key");
    }

    #[test]
    fn links_on_the_notes_address() {
        let seed = [7u8; 32];
        let note = "0d4c6f2e-1b7a-4c3d-9e8f-123456789abc";
        let share = "0123456789abcdef0123456789abcdef";
        let r = ShareRef { id: share.into(), seed: Some(B64.encode(seed)), enc_key: None, pubkey: None, role: None, ..Default::default() };
        let links = crate::sharing::links("https://plim.example/", note, &r).unwrap();
        let e = links.edit.unwrap();
        assert_eq!(e, format!("https://plim.example/n/{note}#k={share}.e.{}", B64URL.encode(seed)));
        let l = parse(&e).unwrap();
        assert_eq!((l.server.as_str(), l.share_id.as_str(), l.note_id.as_deref()), ("https://plim.example", share, Some(note)));
        assert_eq!(l.keys, LinkKeys::Edit { seed });
        let v = links.view.unwrap();
        assert!(v.starts_with(&format!("https://plim.example/n/{note}#k={share}.r.")));
        let k = plim_core::crypto::share_keys(&seed);
        assert_eq!(parse(&v).unwrap().keys, LinkKeys::View { enc_key: k.enc_key, pubkey: Some(k.pubkey) });
        // The address alone is a note's, not a share's; a bad share id or key part is nothing.
        assert!(parse(&format!("https://plim.example/n/{note}")).is_none());
        assert_eq!(parse_note_url(&e).unwrap().id, note, "the address part still names the note");
        for not in [format!("https://plim.example/n/{note}#k=xyz.e.{}", B64URL.encode(seed)), format!("https://plim.example/n/{note}#k={share}.e.short"), format!("https://plim.example/s/{share}#k={share}.e.{}", B64URL.encode(seed))] {
            assert!(parse(&not).is_none(), "{not}");
        }
    }

    #[test]
    fn a_link_of_someones_own() {
        let note = "0d4c6f2e-1b7a-4c3d-9e8f-123456789abc";
        let holder = "fedcba9876543210fedcba9876543210";
        let secret = [9u8; 32];
        let url = holder_url("https://plim.example/", note, holder, &secret);
        assert_eq!(url, format!("https://plim.example/n/{note}#h={holder}.{}", B64URL.encode(secret)));
        let l = parse_holder(&url).unwrap();
        assert_eq!((l.server.as_str(), l.holder_id.as_str(), l.note_id.as_deref(), l.secret), ("https://plim.example", holder, Some(note), secret));
        assert!(parse(&url).is_none(), "not a share link");
        assert!(parse_note_url(&url).is_some(), "the address part still names the note");
        // As the guest page has it, and what isn't one.
        let g = parse_holder(&format!("https://plim.example/s/{holder}#h={holder}.{}", B64URL.encode(secret))).unwrap();
        assert_eq!((g.holder_id.as_str(), g.note_id), (holder, None));
        for not in [
            format!("https://plim.example/s/{}#h={holder}.{}", "0".repeat(32), B64URL.encode(secret)),
            format!("https://plim.example/n/{note}#h={holder}.short"),
            format!("https://plim.example/n/{note}#h=xyz.{}", B64URL.encode(secret)),
            format!("https://plim.example/n/{note}#k={holder}.e.{}", B64URL.encode(secret)),
        ] {
            assert!(parse_holder(&not).is_none(), "{not}");
        }
    }

    #[test]
    fn a_notes_address_and_what_isnt_one() {
        let id = "0d4c6f2e-1b7a-4c3d-9e8f-123456789abc";
        let url = note_url("https://plim.example/", id);
        assert_eq!(url, format!("https://plim.example/n/{id}"));
        let n = parse_note_url(&url).unwrap();
        assert_eq!((n.server.as_str(), n.id.as_str()), ("https://plim.example", id));
        assert_eq!(parse_note_url(&format!(" {url}/ ")).unwrap().id, id, "a slash, spaces");
        assert_eq!(parse_note_url(&format!("https://plim.example/n/{}", id.to_ascii_uppercase())).unwrap().id, id, "in capitals");
        assert_eq!(parse_note_url(&format!("{url}#k=later")).unwrap().id, id, "a fragment is ignored");
        assert_eq!(parse_note_url("http://localhost:3000/n/0d4c6f2e-1b7a-4c3d-9e8f-123456789abc").unwrap().server, "http://localhost:3000");
        for not in ["Groceries", id, "0d4c6f2e", "https://plim.example/s/0123456789abcdef0123456789abcdef#e.AAAA", "https://plim.example/n/0d4c6f2e", "ftp://x/n/0d4c6f2e-1b7a-4c3d-9e8f-123456789abc", &format!("https://plim.example/n/{id}/more")] {
            assert!(parse_note_url(not).is_none(), "{not}");
        }
        assert!(parse(&url).is_none(), "not a share link");
    }
}
