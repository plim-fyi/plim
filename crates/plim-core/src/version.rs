//! A version's text as it's encrypted (#60): compressed, since every version is kept now and
//! each is a whole copy of the note (the server can't keep the differences: it can't read them).
//! The web app does the same (web/core/history.js packText); web/tests/fixtures/versions.json
//! holds what both must read.
//!
//! Packed: MAGIC, then the text's UTF-8, raw-deflated. A version without MAGIC is the text as it
//! is (saved before versions were packed): text that starts with a NUL byte is no note's.
//!
//! One that says who wrote it (#505): MAGIC_WRITER, then raw-deflated: the writer as JSON (its
//! length first, a u32 big-endian), then the text's UTF-8. The writer is inside the encryption,
//! so the server never learns who writes in which note. A writer that can't be read is left out;
//! the text still reads.

use miniz_oxide::deflate::compress_to_vec;
use miniz_oxide::inflate::decompress_to_vec_with_limit;
use serde::{Deserialize, Serialize};

/// What a packed version starts with: NUL, "TZ", and the format (1).
pub const MAGIC: &[u8; 4] = b"\0TZ\x01";
/// …and one that names its writer (format 2).
pub const MAGIC_WRITER: &[u8; 4] = b"\0TZ\x02";

/// The most a version may unpack to (a note is at most a few MB: this bounds a hostile one).
const MAX_TEXT: usize = 64 << 20;
/// The most a writer may take (it's a few short names).
const MAX_WRITER: usize = 4096;

/// Who wrote a version (#505): the app ("Claude", "You"), through what ("plim mcp", a
/// connection's name), in which session ("amber fox"), and that session's id (not shown; it tells
/// apart two sessions that drew the same name). Each may be missing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Writer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
}

/// A version's text, packed to be encrypted.
pub fn pack(text: &str) -> Vec<u8> {
    let mut out = MAGIC.to_vec();
    out.extend(compress_to_vec(text.as_bytes(), 6));
    out
}

/// A version's text and who wrote it, packed to be encrypted.
pub fn pack_by(text: &str, writer: &Writer) -> Vec<u8> {
    let w = serde_json::to_vec(writer).expect("a writer is JSON");
    let mut raw = (w.len() as u32).to_be_bytes().to_vec();
    raw.extend(w);
    raw.extend(text.as_bytes());
    let mut out = MAGIC_WRITER.to_vec();
    out.extend(compress_to_vec(&raw, 6));
    out
}

/// A version's text from its decrypted bytes: packed, or as it was saved before packing.
pub fn unpack(bytes: &[u8]) -> Result<String, String> {
    unpack_version(bytes).map(|(text, _)| text)
}

/// A version's text and, if it says, who wrote it.
pub fn unpack_version(bytes: &[u8]) -> Result<(String, Option<Writer>), String> {
    let inflate = |packed: &[u8]| decompress_to_vec_with_limit(packed, MAX_TEXT + MAX_WRITER + 4).map_err(|e| format!("a version that doesn't unpack: {e:?}"));
    let text = |raw: Vec<u8>| String::from_utf8(raw).map_err(|_| "a version that isn't text".to_string());
    if let Some(packed) = bytes.strip_prefix(MAGIC_WRITER.as_slice()) {
        let raw = inflate(packed)?;
        let len = raw.get(..4).map(|b| u32::from_be_bytes(b.try_into().unwrap()) as usize).ok_or("a version cut short")?;
        let body = raw.get(4 + len..).ok_or("a version cut short")?;
        let writer = if len <= MAX_WRITER { serde_json::from_slice::<Writer>(&raw[4..4 + len]).ok() } else { None };
        return Ok((text(body.to_vec())?, writer));
    }
    let raw = match bytes.strip_prefix(MAGIC.as_slice()) {
        Some(packed) => inflate(packed)?,
        None => bytes.to_vec(),
    };
    Ok((text(raw)?, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_packs_smaller_and_unpacks_to_itself_and_an_old_one_reads_as_it_is() {
        let text = "Trip to Lisbon\n\n".to_string() + &"- Tram 28 early, before the crowds\n".repeat(50);
        let packed = pack(&text);
        assert!(packed.starts_with(MAGIC));
        assert!(packed.len() * 4 < text.len(), "{} → {}", text.len(), packed.len());
        assert_eq!(unpack(&packed).unwrap(), text);
        assert_eq!(unpack("Café ☕".as_bytes()).unwrap(), "Café ☕", "saved before versions were packed");
        assert_eq!(unpack(&pack("")).unwrap(), "");
        assert!(unpack(&[MAGIC.as_slice(), b"not deflate"].concat()).is_err());
    }

    /// What the web app packs, this reads; and what this packs, it reads (web/tests/fixtures/versions.json).
    #[test]
    fn the_web_apps_versions_unpack_the_same() {
        use base64::Engine;
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/tests/fixtures/versions.json");
        let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in f["cases"].as_array().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(case["packed"].as_str().unwrap()).unwrap();
            let (text, writer) = unpack_version(&bytes).unwrap();
            assert_eq!(text, case["text"].as_str().unwrap(), "{case}");
            let want: Option<Writer> = case.get("writer").map(|w| serde_json::from_value(w.clone()).unwrap());
            assert_eq!(writer, want, "{case}");
        }
    }

    /// A version that names its writer (#505) reads back with it; one whose writer can't be read
    /// still gives its text; one cut short doesn't read.
    #[test]
    fn a_version_names_its_writer() {
        let w = Writer { name: Some("Claude".into()), connection: Some("plim mcp".into()), session: Some("amber fox".into()), sid: Some("9f2c41d07a3b".into()) };
        let packed = pack_by("Plan\n\n- one\n- two", &w);
        assert!(packed.starts_with(MAGIC_WRITER));
        assert_eq!(unpack_version(&packed).unwrap(), ("Plan\n\n- one\n- two".to_string(), Some(w.clone())));
        assert_eq!(unpack(&packed).unwrap(), "Plan\n\n- one\n- two");
        assert_eq!(unpack_version(&pack_by("", &Writer::default())).unwrap(), (String::new(), Some(Writer::default())));
        assert_eq!(unpack_version(&pack("old")).unwrap(), ("old".to_string(), None), "format 1: no writer");
        let pack_raw = |raw: &[u8]| [MAGIC_WRITER.as_slice(), &compress_to_vec(raw, 6)].concat();
        let bad_writer = [&5u32.to_be_bytes()[..], b"{nope", b"the text"].concat();
        assert_eq!(unpack_version(&pack_raw(&bad_writer)).unwrap(), ("the text".to_string(), None), "a writer that isn't JSON: left out");
        let extra = [&(br#"{"name":"Codex","colour":"green"}"#.len() as u32).to_be_bytes()[..], br#"{"name":"Codex","colour":"green"}"#, b"t"].concat();
        assert_eq!(unpack_version(&pack_raw(&extra)).unwrap().1.unwrap().name.as_deref(), Some("Codex"), "fields it doesn't know: ignored");
        assert!(unpack_version(&pack_raw(&[0, 0])).is_err(), "no room for the writer's length");
        assert!(unpack_version(&pack_raw(&[&99u32.to_be_bytes()[..], b"{}"].concat())).is_err(), "a writer longer than what's there");
    }
}
