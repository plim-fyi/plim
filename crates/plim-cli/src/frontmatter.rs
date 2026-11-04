//! A note's frontmatter (#584): a YAML block at its very start, between two `---` lines, holding
//! its title and its tags. As the web app reads and writes it (web/core/frontmatter.js, line for
//! line); web/tests/fixtures/frontmatter.json holds the cases both pass.
//!
//! Only what Plim needs of YAML is read: `key: value` lines, a value plain, "double-" or
//! 'single-quoted', or a list (written on one line, `[a, b]`; a `- a` list under the key read
//! too). Other lines are kept as they are. Setting a field edits only its line: made if missing,
//! gone when emptied (and the block with it, if nothing is left).

use crate::tags::tag_name;

struct Field {
    key: String,
    value: String,
    from: usize,
    to: usize,
    items: Option<Vec<String>>,
}

struct Block {
    end: usize,
    inner: Vec<String>,
    fields: Vec<Field>,
}

fn is_fence(line: &str) -> bool {
    line.strip_prefix("---").is_some_and(|rest| rest.chars().all(|c| c == ' ' || c == '\t'))
}

/// `key: value` (or `key:`): the key and the value, trimmed.
fn key_line(line: &str) -> Option<(String, String)> {
    let colon = line.find(':')?;
    let key = &line[..colon];
    let mut chars = key.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let rest = &line[colon + 1..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some((key.to_string(), rest.trim().to_string()))
}

/// `- item` (indented or not): the item, trimmed.
fn item_line(line: &str) -> Option<String> {
    let rest = line.trim_start_matches([' ', '\t']).strip_prefix('-')?;
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some(rest.trim().to_string())
}

fn parse_block(text: &str) -> Option<Block> {
    let first = text.split('\n').next()?;
    if !is_fence(first) || first.len() < 3 || (text.len() > first.len() && !text[first.len()..].starts_with('\n')) {
        return None;
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let close = (1..lines.len()).find(|&i| is_fence(lines[i]))?;
    let end = (lines[..=close].iter().map(|l| l.len() + 1).sum::<usize>()).min(text.len());
    let inner: Vec<String> = lines[1..close].iter().map(|s| s.to_string()).collect();
    let mut fields: Vec<Field> = Vec::new();
    for (i, line) in inner.iter().enumerate() {
        if let Some((key, value)) = key_line(line) {
            fields.push(Field { key, value, from: i, to: i + 1, items: None });
            continue;
        }
        if let (Some(item), Some(last)) = (item_line(line), fields.last_mut())
            && last.to == i
            && last.value.is_empty()
        {
            last.items.get_or_insert_with(Vec::new).push(scalar(&item));
            last.to = i + 1;
        }
    }
    Some(Block { end, inner, fields })
}

/// A plain or quoted scalar's text.
fn scalar(v: &str) -> String {
    let n = v.chars().count();
    if n >= 2 && v.starts_with('"') && v.ends_with('"') {
        let inner = &v[1..v.len() - 1];
        let mut out = String::new();
        let mut it = inner.chars().peekable();
        while let Some(c) = it.next() {
            if c == '\\'
                && let Some(&next) = it.peek()
                && matches!(next, '"' | '\\' | 'n')
            {
                it.next();
                out.push(if next == 'n' { '\n' } else { next });
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if n >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    // (A plain one without a ` #comment`.)
    let mut cut = v.len();
    let b = v.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'#' && i > 0 && (b[i - 1] == b' ' || b[i - 1] == b'\t') {
            cut = i;
            break;
        }
    }
    v[..cut].trim().to_string()
}

/// A one-line list's items: `[a, "b, c", 'd']`. None if `v` isn't one.
fn flow_list(v: &str) -> Option<Vec<String>> {
    let body = v.strip_prefix('[')?.strip_suffix(']')?;
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut it = body.chars();
    while let Some(c) = it.next() {
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' && q == '"' {
                if let Some(n) = it.next() {
                    cur.push(n);
                }
            } else if c == q {
                quote = None;
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            cur.push(c);
        } else if c == ',' {
            out.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    Some(out.into_iter().filter(|s| !s.is_empty()).map(|s| scalar(&s)).collect())
}

fn list_of(f: &Field) -> Vec<String> {
    if let Some(items) = &f.items {
        return items.clone();
    }
    if f.value.is_empty() {
        return Vec::new();
    }
    flow_list(&f.value).unwrap_or_else(|| scalar(&f.value).split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

fn tags_from(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for it in items {
        if let Some(n) = tag_name(it)
            && !out.contains(&n)
        {
            out.push(n);
        }
    }
    out
}

/// The note's title and tags as its block has them (each None without a block or that field).
pub fn read(text: &str) -> (Option<String>, Option<Vec<String>>) {
    let Some(b) = parse_block(text) else { return (None, None) };
    let title = b.fields.iter().find(|f| f.key == "title").filter(|f| f.items.is_none()).map(|f| scalar(&f.value).trim().to_string()).filter(|t| !t.is_empty());
    let tags = b.fields.iter().find(|f| f.key == "tags").map(|f| tags_from(&list_of(f)));
    (title, tags)
}

/// Where the note's text after its block starts (0 without one).
pub fn body_start(text: &str) -> usize {
    parse_block(text).map_or(0, |b| b.end)
}

/// The note's text after its block.
pub fn body_of(text: &str) -> &str {
    &text[body_start(text)..]
}

fn reserved(s: &str) -> bool {
    let l = s.to_lowercase();
    if matches!(l.as_str(), "true" | "false" | "yes" | "no" | "on" | "off" | "null" | "~" | ".inf" | ".nan") {
        return true;
    }
    if (l.starts_with("0x") && l.len() > 2 && l[2..].chars().all(|c| c.is_ascii_hexdigit())) || (l.starts_with("0o") && l.len() > 2 && l[2..].chars().all(|c| ('0'..='7').contains(&c))) {
        return true;
    }
    // A number: [-+]? (digits[_digits]* (. digits*)? | . digits) (e[-+]?digits)?
    let t = l.strip_prefix(['-', '+']).unwrap_or(&l);
    let (mant, exp) = match t.find('e') {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let mant_ok = if let Some(rest) = mant.strip_prefix('.') {
        !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
    } else {
        let (int, frac) = match mant.find('.') {
            Some(i) => (&mant[..i], Some(&mant[i + 1..])),
            None => (mant, None),
        };
        int.starts_with(|c: char| c.is_ascii_digit()) && int.chars().all(|c| c.is_ascii_digit() || c == '_') && frac.is_none_or(|f| f.chars().all(|c| c.is_ascii_digit()))
    };
    let exp_ok = exp.is_none_or(|e| {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
    });
    mant_ok && exp_ok
}

/// `s` as a YAML scalar: plain where that reads back as `s`, else double-quoted. In a list (`flow`), no `, [ ] { }` plain.
pub fn yaml_scalar(s: &str, flow: bool) -> String {
    let first_ok = s.chars().next().is_some_and(|c| !c.is_whitespace() && !"-?:,[]{}#&*!|>'\"%@`".contains(c));
    let plain = first_ok
        && !s.ends_with([' ', '\t'])
        && !s.contains(": ")
        && !s.ends_with(':')
        && !s.contains(" #")
        && !s.contains(['\n', '"', '\\'])
        && !reserved(s)
        && !(flow && s.contains([',', '[', ']', '{', '}']));
    if plain { s.to_string() } else { format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")) }
}

/// `text` with its block's `key` set to `value` (a YAML value as written; None: taken out), as the
/// web app's setField (export.rs sets created, updated and id with it).
pub fn set_field(text: &str, key: &str, value: Option<String>) -> String {
    let Some(b) = parse_block(text) else {
        return match value {
            Some(v) => format!("---\n{key}: {v}\n---\n{text}"),
            None => text.to_string(),
        };
    };
    let mut inner = b.inner.clone();
    match (b.fields.iter().find(|f| f.key == key), value) {
        (Some(f), None) => {
            inner.drain(f.from..f.to);
        }
        (Some(f), Some(v)) => {
            inner.splice(f.from..f.to, [format!("{key}: {v}")]);
        }
        (None, Some(v)) => {
            if key == "title" {
                inner.insert(0, format!("{key}: {v}"));
            } else {
                inner.push(format!("{key}: {v}"));
            }
        }
        (None, None) => return text.to_string(),
    }
    let rest = &text[b.end..];
    if inner.iter().all(|l| l.trim().is_empty()) {
        return rest.to_string();
    }
    let closed = if text[..b.end].ends_with('\n') { "---\n" } else { "---" };
    format!("---\n{}\n{closed}{rest}", inner.join("\n"))
}

/// `text` with its title `title` (empty: no title field).
pub fn set_title(text: &str, title: &str) -> String {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    set_field(text, "title", (!t.is_empty()).then(|| yaml_scalar(&t, false)))
}

/// `text` with its tags `tags` (each as tag_name takes it, once, in this order; none: no field), on one line.
pub fn set_tags(text: &str, tags: &[String]) -> String {
    let names = tags_from(tags);
    let v = (!names.is_empty()).then(|| format!("[{}]", names.iter().map(|t| yaml_scalar(t, true)).collect::<Vec<_>>().join(", ")));
    set_field(text, "tags", v)
}

/// `text` with `tag` among its tags, after the others; None if it has it already (or it isn't a tag).
pub fn add_tag(text: &str, tag: &str) -> Option<String> {
    let n = tag_name(tag)?;
    let mut have = read(text).1.unwrap_or_default();
    if have.contains(&n) {
        return None;
    }
    have.push(n);
    Some(set_tags(text, &have))
}

/// `text` without `tag` among its tags; None if it isn't there.
pub fn remove_tag(text: &str, tag: &str) -> Option<String> {
    let n = tag_name(tag).unwrap_or_else(|| tag.to_lowercase());
    let have = read(text).1.unwrap_or_default();
    if !have.contains(&n) {
        return None;
    }
    let kept: Vec<String> = have.into_iter().filter(|t| *t != n).collect();
    Some(set_tags(text, &kept))
}

/// A note's title: its block's, else its first non-empty line after the block, without its marks.
pub fn note_title(text: &str) -> String {
    if let Some(t) = read(text).0 {
        return t;
    }
    let line = body_of(text).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    crate::notes::title_from_line(line)
}

/// A note's tags (sorted, each once): its block's; without a block, none.
pub fn note_tags(text: &str) -> Vec<String> {
    let mut t = read(text).1.unwrap_or_default();
    t.sort();
    t
}

/// A note as it was before frontmatter (#582), moved into a block: its first non-empty line its
/// title (out of the text), the lines of only tags right under it out too, and every tag it had
/// its tags; a `#word` in a sentence stays, as text. One with a block, or nothing: as it is.
/// (As web/core/frontmatter.js toFrontmatter.)
pub fn to_frontmatter(text: &str) -> String {
    if parse_block(text).is_some() {
        return text.to_string();
    }
    let tags = crate::tags::tags_in(text);
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(i) = lines.iter().position(|l| !l.trim().is_empty()) else { return text.to_string() };
    let title = crate::notes::title_from_line(lines[i].trim());
    let mut j = i + 1;
    while j < lines.len() && crate::tags::tag_line(lines[j]) {
        j += 1;
    }
    while j < lines.len() && lines[j].trim().is_empty() && j < lines.len() - 1 {
        j += 1;
    }
    let body = lines[j.min(lines.len())..].join("\n");
    set_tags(&set_title(&body, &title), &tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../web/tests/fixtures/frontmatter.json")).unwrap()
    }
    fn s(v: &Value) -> &str {
        v.as_str().unwrap()
    }
    fn strings(v: &Value) -> Option<Vec<String>> {
        v.as_array().map(|a| a.iter().map(|x| s(x).to_string()).collect())
    }

    /// Only the block's tags count, and tags go in one (#584): a `#word` in the text is text.
    #[test]
    fn only_the_block() {
        let old = "Leg day\n#gym\n\nSquat #knee";
        assert_eq!(note_tags(old), Vec::<String>::new(), "#word is text");
        assert_eq!(add_tag(old, "legs").as_deref(), Some("---\ntags: [legs]\n---\nLeg day\n#gym\n\nSquat #knee"));
        assert_eq!(to_frontmatter(old), "---\ntitle: Leg day\ntags: [gym, knee]\n---\nSquat #knee", "a new note's first line and #tag line, into its block");
        assert_eq!(remove_tag("---\ntags: [gym]\n---\nx #y", "gym").as_deref(), Some("x #y"));
    }

    /// The same as the web app, from the same cases (web/tests/fixtures/frontmatter.json).
    #[test]
    fn as_the_web_app_reads_and_writes_it() {
        let f = fixture();
        for c in f["read"].as_array().unwrap() {
            assert_eq!(read(s(&c[0])), (c[1].as_str().map(str::to_string), strings(&c[2])), "read {:?}", s(&c[0]));
        }
        for c in f["body"].as_array().unwrap() {
            assert_eq!(body_of(s(&c[0])), s(&c[1]), "body {:?}", s(&c[0]));
        }
        for c in f["title"].as_array().unwrap() {
            assert_eq!(note_title(s(&c[0])), s(&c[1]), "title {:?}", s(&c[0]));
        }
        for c in f["set"].as_array().unwrap() {
            let text = s(&c[0]);
            let got = match s(&c[1]) {
                "title" => Some(set_title(text, s(&c[2]))),
                "tags" => Some(set_tags(text, &strings(&c[2]).unwrap())),
                "add" => add_tag(text, s(&c[2])),
                "remove" => remove_tag(text, s(&c[2])),
                op => panic!("{op}"),
            };
            let got = got.filter(|g| !(g == text && c[3].is_null()));
            assert_eq!(got.as_deref(), c[3].as_str(), "{c}");
        }
        for c in f["convert"].as_array().unwrap() {
            assert_eq!(to_frontmatter(s(&c[0])), s(&c[1]), "convert {:?}", s(&c[0]));
        }
        for c in f["scalar"].as_array().unwrap() {
            assert_eq!(yaml_scalar(s(&c[0]), c[1].as_bool().unwrap()), s(&c[2]), "scalar {c}");
        }
    }
}
