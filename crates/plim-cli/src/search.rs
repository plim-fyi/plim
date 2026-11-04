//! Searching notes (#24), for agents (`search_notes`): the web app's search (web/core/search.js),
//! the same rules, over the notes the client can see. A search is words; a note matches when every
//! word is in it, as part of a word or whole, whatever its case or accents ("cafe" finds "Café").
//! web/tests/fixtures/search.json holds the cases both must agree on.
//!
//! Positions here are bytes of the note's text (the web app's are UTF-16 units): a long line is cut
//! around its first match by characters, so a line with emoji beyond its first 140 characters may
//! be cut a few characters differently. Which notes match, and what's marked, are the same.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// Text folded for matching (lower case, accents off), and where each of its bytes came from in the
/// original (`map[folded.len()]` is the original's length), so a match is put back on the text.
pub struct Folded {
    pub text: String,
    map: Vec<usize>,
}

pub fn fold(s: &str) -> Folded {
    let mut text = String::with_capacity(s.len());
    let mut map = Vec::with_capacity(s.len() + 1);
    for (i, c) in s.char_indices() {
        for f in c.nfd().filter(|m| !is_combining_mark(*m)).flat_map(char::to_lowercase) {
            let mut buf = [0u8; 4];
            let enc = f.encode_utf8(&mut buf);
            map.extend(std::iter::repeat_n(i, enc.len()));
            text.push(f);
        }
    }
    map.push(s.len());
    Folded { text, map }
}

/// A search's words, folded, each once (longest first: a shorter one inside it adds nothing).
pub fn query_words(q: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for w in fold(q).text.split_whitespace() {
        if !words.iter().any(|x| x == w) {
            words.push(w.to_string());
        }
    }
    words.sort_by_key(|w| std::cmp::Reverse(w.chars().count()));
    words
}

/// Where `words` are in the text `folded` was folded from: its byte ranges, in order, those that
/// touch joined.
pub fn find_all(words: &[String], folded: &Folded) -> Vec<(usize, usize)> {
    let mut hits = Vec::new();
    for w in words {
        let mut from = 0;
        while let Some(at) = folded.text[from..].find(w.as_str()).map(|i| i + from) {
            hits.push((folded.map[at], folded.map[at + w.len()]));
            from = at + w.len();
        }
    }
    hits.sort();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for h in hits {
        match out.last_mut() {
            Some(last) if h.0 <= last.1 => last.1 = last.1.max(h.1),
            _ => out.push(h),
        }
    }
    out
}

/// A line shown for a match: its text (cut down around the match, "…" where cut) and the byte
/// ranges of the matches in it.
pub struct Line {
    pub text: String,
    pub ranges: Vec<(usize, usize)>,
}

impl Line {
    /// Its text with each match between `open` and `close`.
    pub fn marked(&self, open: &str, close: &str) -> String {
        let mut out = String::new();
        let mut at = 0;
        for &(a, b) in &self.ranges {
            out += &self.text[at..a];
            out += open;
            out += &self.text[a..b];
            out += close;
            at = b;
        }
        out + &self.text[at..]
    }
}

/// A note that has every word: how many places matched, whether its title has every word, and its
/// first lines with a match (not its title's).
pub struct Match {
    pub count: usize,
    pub in_title: bool,
    pub lines: Vec<Line>,
}

const LINE_MAX: usize = 140;

/// The note `title`/`text` if it has every word (`words`: query_words), else None.
pub fn match_note(title: &str, text: &str, words: &[String], lines: usize) -> Option<Match> {
    if words.is_empty() {
        return None;
    }
    let folded = fold(text);
    let ft = fold(title).text;
    if !words.iter().all(|w| folded.text.contains(w.as_str()) || ft.contains(w.as_str())) {
        return None;
    }
    let ranges = find_all(words, &folded);
    let mut shown = Vec::new();
    let (mut line_start, mut title_line) = (0usize, true);
    for line in text.split('\n') {
        let line_end = line_start + line.len();
        if shown.len() < lines && !line.trim().is_empty() {
            let in_line: Vec<(usize, usize)> = ranges
                .iter()
                .filter(|&&(a, b)| a < line_end && b > line_start)
                .map(|&(a, b)| (a.max(line_start) - line_start, b.min(line_end) - line_start))
                .collect();
            if !in_line.is_empty() && !title_line {
                shown.push(cut(line, &in_line));
            }
            title_line = false;
        }
        line_start = line_end + 1;
    }
    Some(Match { count: ranges.len(), in_title: words.iter().all(|w| ft.contains(w.as_str())), lines: shown })
}

/// A line cut down to about LINE_MAX characters around its first match, its ranges moved with it.
fn cut(line: &str, ranges: &[(usize, usize)]) -> Line {
    let trimmed = line.trim_start();
    let off = line.len() - trimmed.len();
    let body = trimmed.trim_end();
    let chars: Vec<(usize, char)> = body.char_indices().collect();
    let (text, shift_from, lead) = if chars.len() > LINE_MAX {
        let first = ranges[0].0.saturating_sub(off);
        let first_c = chars.iter().take_while(|(i, _)| *i < first).count();
        let start = first_c.saturating_sub(30).min(chars.len() - LINE_MAX);
        let from = chars[start].0;
        let to = chars.get(start + LINE_MAX).map_or(body.len(), |c| c.0);
        let lead = if start > 0 { "…" } else { "" };
        let tail = if start + LINE_MAX < chars.len() { "…" } else { "" };
        (format!("{lead}{}{tail}", &body[from..to]), off + from, lead.len())
    } else {
        (body.to_string(), off, 0)
    };
    let end = text.len();
    let moved = ranges
        .iter()
        .map(|&(a, b)| (a as isize - shift_from as isize + lead as isize, b as isize - shift_from as isize + lead as isize))
        .filter(|&(a, b)| b > lead as isize && a < end as isize)
        .map(|(a, b)| (a.max(lead as isize) as usize, (b as usize).min(end)))
        .collect();
    Line { text, ranges: moved }
}

/// A note found, for the answer: its title, address, when, tags in scope, and its match.
pub struct Found {
    pub title: String,
    pub url: String,
    pub when: String,
    pub tags: String,
    pub m: Match,
}

/// The most notes one search answers with, unless asked for fewer.
pub const LIMIT: usize = 20;

/// The answer to a search: the notes found (those `found` in the order they came, newest first,
/// those with every word in their title before the rest, as the web app shows them), each with its
/// lines, the matches in **bold**; at most `limit`, saying how many more.
pub fn answer(query: &str, found: Vec<Found>, limit: usize, scope: &str) -> String {
    if found.is_empty() {
        return format!("No notes{scope} match \"{query}\".");
    }
    let total = found.len();
    let (title, rest): (Vec<Found>, Vec<Found>) = found.into_iter().partition(|f| f.m.in_title);
    let shown: Vec<Found> = title.into_iter().chain(rest).take(limit).collect();
    let mut out = format!("{total} note{}{scope} match \"{query}\":\n", if total == 1 { "" } else { "s" });
    for f in &shown {
        let more = if f.m.count > f.m.lines.len().max(1) { format!(" · found in {} places", f.m.count) } else { String::new() };
        out += &format!("- {} · {} · {}{}{more}\n", f.title, f.url, f.when, f.tags);
        for l in &f.m.lines {
            out += &format!("    {}\n", l.marked("**", "**"));
        }
    }
    if total > shown.len() {
        out += &format!("…and {} more: search with more words, or a tag, to narrow it.\n", total - shown.len());
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same answers as the web app's, case by case (web/tests/fixtures/search.json).
    #[test]
    fn the_web_apps_cases_match_the_same() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/tests/fixtures/search.json");
        let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for c in f["cases"].as_array().unwrap() {
            let (q, title, text) = (c["query"].as_str().unwrap(), c["title"].as_str().unwrap(), c["text"].as_str().unwrap());
            let got = match_note(title, text, &query_words(q), 2).map(|m| {
                serde_json::json!({ "count": m.count, "inTitle": m.in_title, "lines": m.lines.iter().map(|l| l.marked("[", "]")).collect::<Vec<_>>() })
            });
            assert_eq!(got.unwrap_or(serde_json::Value::Null), c["match"], "{q:?}");
        }
    }

    #[test]
    fn words_fold_case_and_accents_each_once() {
        assert_eq!(query_words("  Café   TRAM café "), vec!["cafe", "tram"]);
        assert!(query_words("   ").is_empty());
        assert_eq!(fold("Pastéis ÉCLAIR").text, "pasteis eclair");
    }
}
