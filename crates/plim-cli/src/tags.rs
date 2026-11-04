//! Tags (#308): `#gym` written in a note's text, nested as `#gym/legs`, by convention on one line
//! under the title. The web app reads them the same way (web/core/tags.js); the cases both pass are
//! in web/tests/fixtures/tags.json.
//!
//! A tag is `#` and a name: letters, digits, `_` and `-`, in segments joined by single `/`, with
//! at least one letter (`#3` isn't a tag), at most 64 characters, `_` and `-` at its end left out
//! (`_#u_` is `u`). Before the `#`: a line's start, whitespace, or one of `( [ { * _ ~ " '` (so a
//! URL's `#fragment`, `C#` and `&#169;` aren't tags). Not tags: a heading's `# ` (a space after
//! it: no name), anything in a fenced code block, in inline code or in a link's address, and an
//! escaped `\#`. (Indented code isn't told from an indented line: fence code to keep its `#`s out.)
//! Tags are compared, and kept, in lower case.

const NAME_MAX: usize = 64;

fn name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

fn boundary(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(c) => c.is_whitespace() || "([{*_~\"'".contains(c),
    }
}

/// The name of a tag starting at `chars[at]` (after its `#`), and where it ends; None if there's none there.
fn name_at(chars: &[char], at: usize) -> (Option<String>, usize) {
    let mut j = at;
    // (A "/" only between two segments: "gym/legs", not "gym/" nor "gym//legs".)
    let nests = |j: usize| chars[j] == '/' && j > at && chars[j - 1] != '/' && j + 1 < chars.len() && name_char(chars[j + 1]);
    while j < chars.len() && (name_char(chars[j]) || nests(j)) {
        j += 1;
    }
    let end = j;
    // (`_` and `-` at the end aren't the name's: "_#u_" is "u".)
    while j > at && matches!(chars[j - 1], '_' | '-') {
        j -= 1;
    }
    let name: String = chars[at..j].iter().collect();
    let ok = !name.is_empty() && name.chars().count() <= NAME_MAX && name.chars().any(char::is_alphabetic) && !name.ends_with('/');
    (ok.then(|| name.to_lowercase()), end)
}

/// The tags in a line that isn't code: its `#name`s, outside inline code and link addresses.
fn line_tags(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            i += 2; // (an escaped character: "\#" isn't a tag)
            continue;
        }
        if c == '`' {
            // Inline code: from a run of backticks to the next run as long (none: just backticks).
            let run = chars[i..].iter().take_while(|&&ch| ch == '`').count();
            let mut k = i + run;
            let mut closed = None;
            while k < chars.len() {
                if chars[k] == '`' {
                    let r = chars[k..].iter().take_while(|&&ch| ch == '`').count();
                    if r == run {
                        closed = Some(k + r);
                        break;
                    }
                    k += r;
                } else {
                    k += 1;
                }
            }
            i = closed.unwrap_or(i + run);
            continue;
        }
        if c == ']' && chars.get(i + 1) == Some(&'(') {
            // A link's address: to its closing parenthesis.
            match chars[i + 2..].iter().position(|&ch| ch == ')') {
                Some(p) => i = i + 2 + p + 1,
                None => i += 2,
            }
            continue;
        }
        if c == '<' {
            // An autolink: <scheme:...>, with no space in it.
            if let Some(p) = chars[i + 1..].iter().position(|&ch| ch == '>') {
                let inside = &chars[i + 1..i + 1 + p];
                if !inside.is_empty() && inside.contains(&':') && !inside.iter().any(|ch| ch.is_whitespace()) {
                    i = i + 1 + p + 1;
                    continue;
                }
            }
        }
        if c == '#' && boundary(i.checked_sub(1).map(|p| chars[p])) {
            let (name, end) = name_at(&chars, i + 1);
            if let Some(name) = name {
                out.push(name);
            }
            i = end.max(i + 1);
            continue;
        }
        i += 1;
    }
}

/// A fence that opens or closes a code block: its character and how many (``` or ~~~, 3 or more,
/// after at most 3 spaces); `rest` is what follows the run.
fn fence(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.bytes().take_while(|&b| b == b' ').count();
    if indent > 3 {
        return None;
    }
    let t = &line[indent..];
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let run = t.chars().take_while(|&ch| ch == c).count();
    if run < 3 {
        return None;
    }
    let rest = &t[run..];
    if c == '`' && rest.contains('`') {
        return None; // (an info string can't have a backtick)
    }
    Some((c, run, rest))
}

/// The tags in a note's text, in lower case, each once, sorted.
pub fn tags_in(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut open: Option<(char, usize)> = None;
    for line in body.split('\n') {
        if let Some((c, n)) = open {
            // In a code block: until a fence of the same character, at least as long, with nothing after it.
            if let Some((fc, run, rest)) = fence(line)
                && fc == c
                && run >= n
                && rest.trim().is_empty()
            {
                open = None;
            }
            continue;
        }
        if let Some((c, run, _)) = fence(line) {
            open = Some((c, run));
            continue;
        }
        line_tags(line, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

/// A tag as typed on its own ("gym", "#Gym", "gym/legs"), as it's kept; None if it isn't one.
pub fn tag_name(s: &str) -> Option<String> {
    let s = s.trim();
    let s = s.strip_prefix('#').unwrap_or(s);
    let chars: Vec<char> = s.chars().collect();
    let (name, end) = name_at(&chars, 0);
    // (All of it: "gym legs" or "gym!" isn't a tag, nor is "gym/" or "/gym".)
    name.filter(|n| end == chars.len() && n.chars().count() == chars.len())
}

/// Whether `tag` is what's asked for (#539): `query` itself. A tag is a word: "gym" doesn't find
/// "gym/legs", as in the app.
pub fn matches(tag: &str, query: &str) -> bool {
    tag == query
}

/// Whether a line is a tag line: nothing but tags, separated by spaces.
pub fn tag_line(line: &str) -> bool {
    let words: Vec<&str> = line.split_whitespace().collect();
    !words.is_empty() && words.iter().all(|w| w.starts_with('#') && tag_name(w).is_some())
}

/// The one change that makes `old` into `new`: where (a byte offset), how much of `old` goes,
/// and what goes in (so a CRDT edit touches only that, not the whole text).
pub fn change(old: &str, new: &str) -> (usize, usize, String) {
    let mut start = old.bytes().zip(new.bytes()).take_while(|(a, b)| a == b).count();
    while !old.is_char_boundary(start) || !new.is_char_boundary(start) {
        start -= 1;
    }
    let max = old.len().min(new.len()) - start;
    let mut end = old.bytes().rev().zip(new.bytes().rev()).take(max).take_while(|(a, b)| a == b).count();
    while !old.is_char_boundary(old.len() - end) || !new.is_char_boundary(new.len() - end) {
        end -= 1;
    }
    (start, old.len() - end - start, new[start..new.len() - end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../web/tests/fixtures/tags.json")).unwrap()
    }
    fn s(v: &serde_json::Value) -> &str {
        v.as_str().unwrap()
    }

    /// The same tags as the web app, from the same cases (web/tests/fixtures/tags.json).
    #[test]
    fn tags_as_the_web_app_reads_them() {
        let f = fixture();
        for case in f["tags"].as_array().unwrap() {
            let want: Vec<&str> = case[1].as_array().unwrap().iter().map(s).collect();
            assert_eq!(tags_in(s(&case[0])), want, "{:?}", s(&case[0]));
        }
        for case in f["names"].as_array().unwrap() {
            assert_eq!(tag_name(s(&case[0])).as_deref(), case[1].as_str(), "{:?}", s(&case[0]));
        }
        for case in f["matches"].as_array().unwrap() {
            assert_eq!(matches(s(&case[0]), s(&case[1])), case[2].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn one_change_from_one_text_to_the_other() {
        for (old, new) in [("# T\nbody", "# T\n#gym\nbody"), ("# T\n#gym\nb", "# T\nb"), ("abc", "abc"), ("", "x"), ("é#a", "é#b"), ("日本 #a", "日本")] {
            let (at, del, ins) = change(old, new);
            let mut out = old.to_string();
            out.replace_range(at..at + del, &ins);
            assert_eq!(out, new, "{old:?} → {new:?}");
        }
        assert_eq!(change("# T\nbody", "# T\n#gym\nbody"), (4, 0, "#gym\n".to_string()));
    }
}
