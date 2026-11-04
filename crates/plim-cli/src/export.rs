//! `plim export <dir>` (#47): every note as a Markdown file, as the web app's Export all notes
//! (web/core/export.js) makes them: the same names and the same text. The cases both pass are in
//! web/tests/fixtures/export.json.

use std::collections::{HashMap, HashSet};

use crate::frontmatter::{note_title, set_field, yaml_scalar};

/// A time (ms) as the export writes it: UTC to the second, `2026-11-02T14:03:05Z`; None for none.
pub fn iso_time(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms <= 0.0 {
        return None;
    }
    let secs = (ms / 1000.0).floor() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60))
}

/// What a note's file says about it besides its text.
#[derive(Clone, Debug, Default)]
pub struct FileMeta {
    pub created: f64,
    pub updated: f64,
    pub id: String,
    pub shared: bool,
}

/// A note's text as its file holds it: as written, with `created`, `updated` and `id` (and
/// `shared: true` for a note someone shared with you) in its frontmatter.
pub fn export_text(text: &str, m: &FileMeta) -> String {
    let at = |ms: f64| iso_time(ms).map(|t| yaml_scalar(&t, false));
    let t = set_field(text, "created", at(m.created));
    let t = set_field(&t, "updated", at(m.updated));
    let t = set_field(&t, "id", (!m.id.is_empty()).then(|| yaml_scalar(&m.id, false)));
    set_field(&t, "shared", m.shared.then(|| "true".to_string()))
}

const MAX_BYTES: usize = 120;

fn reserved(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    matches!(l.as_str(), "con" | "prn" | "aux" | "nul")
        || ((l.starts_with("com") || l.starts_with("lpt")) && l.len() == 4 && l.as_bytes()[3].is_ascii_digit())
}

/// A note's title as the start of a file name (without `.md`): safe on every system.
pub fn file_base(title: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mapped: String = title
        .nfc()
        .filter_map(|c| match c {
            '\u{0}'..='\u{1f}' | '\u{7f}' => Some(' '),
            '\\' | '/' | ':' => Some('-'),
            '*' | '?' | '"' | '<' | '>' | '|' => None,
            c => Some(c),
        })
        .collect();
    let joined = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s = joined.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if s.len() > MAX_BYTES {
        let mut cut = MAX_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s = s.trim_end_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    }
    if s.is_empty() {
        return "Untitled".into();
    }
    if reserved(&s) { format!("{s}_") } else { s }
}

/// A note to name: its id, title (for the file), when it was made, and whether it's deleted.
pub struct Named<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub created: f64,
    pub deleted: bool,
}

/// The file each note goes in: id → path (`Name.md`, `deleted/Name.md`); the older of two with one
/// name (letter case aside) keeps it, the next is `Name (2).md`.
pub fn file_paths(notes: &[Named]) -> HashMap<String, String> {
    let mut order: Vec<&Named> = notes.iter().collect();
    order.sort_by(|a, b| a.created.total_cmp(&b.created).then_with(|| a.id.cmp(b.id)));
    let mut taken = HashSet::new();
    let mut out = HashMap::new();
    for n in order {
        let dir = if n.deleted { "deleted/" } else { "" };
        let base = file_base(n.title);
        let mut path = format!("{dir}{base}.md");
        let mut i = 2;
        while taken.contains(&path.to_lowercase()) {
            path = format!("{dir}{base} ({i}).md");
            i += 1;
        }
        taken.insert(path.to_lowercase());
        out.insert(n.id.to_string(), path);
    }
    out
}

/// A note's title for its file name: its own (frontmatter, else first line), else the list's.
pub fn export_title(text: &str, list_title: &str) -> String {
    let t = note_title(text);
    if t.is_empty() { list_title.to_string() } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../web/tests/fixtures/export.json")).unwrap()
    }

    /// The same as the web app, from the same cases (web/tests/fixtures/export.json).
    #[test]
    fn file_names_as_the_app_makes_them() {
        for c in fixture()["base"].as_array().unwrap() {
            assert_eq!(file_base(c[0].as_str().unwrap()), c[1].as_str().unwrap(), "{:?}", c[0]);
        }
    }

    #[test]
    fn paths_as_the_app_makes_them() {
        for c in fixture()["paths"].as_array().unwrap() {
            let notes: Vec<Named> = c[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| Named { id: n["id"].as_str().unwrap(), title: n["title"].as_str().unwrap(), created: n["created"].as_f64().unwrap(), deleted: n["deleted"].as_bool().unwrap() })
                .collect();
            let got = file_paths(&notes);
            for (id, want) in c[1].as_object().unwrap() {
                assert_eq!(got[id], want.as_str().unwrap(), "{id}");
            }
        }
    }

    #[test]
    fn file_text_as_the_app_makes_it() {
        for c in fixture()["text"].as_array().unwrap() {
            let m = &c[1];
            let meta = FileMeta { created: m["created"].as_f64().unwrap(), updated: m["updated"].as_f64().unwrap(), id: m["id"].as_str().unwrap().into(), shared: m["shared"].as_bool().unwrap() };
            assert_eq!(export_text(c[0].as_str().unwrap(), &meta), c[2].as_str().unwrap(), "{:?}", c[0]);
        }
        assert_eq!(iso_time(0.0), None);
        assert_eq!(iso_time(951_782_400_000.0).as_deref(), Some("2000-02-29T00:00:00Z")); // (a leap day)
    }
}
