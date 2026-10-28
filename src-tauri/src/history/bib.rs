//! `refs.bib` as entries keyed by citation key, for comparing (and later merging) bibliographies.

use std::collections::HashMap;

use super::{BibChange, ChangeStatus};

/// Commands that are not references: they have no citation key.
const NOT_ENTRIES: [&str; 3] = ["comment", "preamble", "string"];

pub(super) struct Entry<'a> {
    pub key: &'a str,
    /// From `@` to the closing delimiter.
    pub text: &'a str,
}

/// The references of a BibTeX text in file order: `@type{key, …}` or `@type(key, …)` with balanced
/// braces. A repeated key keeps its first entry; an unterminated entry runs to the end of the text.
pub(super) fn entries(text: &str) -> Vec<Entry<'_>> {
    let mut out: Vec<Entry> = Vec::new();
    let mut rest = 0;
    while let Some(at) = text[rest..].find('@').map(|i| rest + i) {
        let after = &text[at + 1..];
        let kind_len = after.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(after.len());
        let kind = &after[..kind_len];
        let open = at + 1 + kind_len + (after[kind_len..].len() - after[kind_len..].trim_start().len());
        let delimiter = text[open..].chars().next();
        if kind.is_empty() || !matches!(delimiter, Some('{' | '(')) {
            rest = at + 1;
            continue;
        }
        let end = entry_end(text, open);
        let body = &text[open + 1..end];
        let key = body[..body.find([',', '}', ')']).unwrap_or(body.len())].trim();
        let is_reference = !NOT_ENTRIES.contains(&kind.to_ascii_lowercase().as_str());
        if is_reference && !key.is_empty() && !out.iter().any(|e| e.key == key) {
            out.push(Entry { key, text: &text[at..end] });
        }
        rest = end;
    }
    out
}

/// The byte just past the delimiter that closes the one at `open`, else the end of the text.
/// Braces nest; a `"…"` value outside braces may contain the closing delimiter.
fn entry_end(text: &str, open: usize) -> usize {
    let close = if text.as_bytes()[open] == b'{' { b'}' } else { b')' };
    let mut depth = 0usize;
    let mut quoted = false;
    for (i, &b) in text.as_bytes().iter().enumerate().skip(open + 1) {
        match b {
            b'{' => depth += 1,
            b'}' if depth > 0 => depth -= 1,
            b'"' if depth == 0 => quoted = !quoted,
            _ if b == close && depth == 0 && !quoted => return i + 1,
            _ => {}
        }
    }
    text.len()
}

/// The entry with its type lowercased, whitespace runs collapsed and no whitespace around the
/// syntax characters, so reformatting is no edit.
fn normalized(entry: &str) -> String {
    const SYNTAX: &[char] = &['{', '}', '(', ')', ',', '=', '"', '#'];
    let mut out = String::with_capacity(entry.len());
    for word in entry.split_whitespace() {
        let joins = out.ends_with(SYNTAX) || word.starts_with(SYNTAX);
        if !out.is_empty() && !joins {
            out.push(' ');
        }
        out.push_str(word);
    }
    let kind_end = out.find(['{', '(']).unwrap_or(out.len());
    out[..kind_end].make_ascii_lowercase();
    out
}

/// Entries added or edited, in the newer file's order, then entries deleted, in the older's.
pub(super) fn changes(old: &str, new: &str) -> Vec<BibChange> {
    let old_entries = entries(old);
    let new_entries = entries(new);
    let before: HashMap<&str, &str> = old_entries.iter().map(|e| (e.key, e.text)).collect();
    let after: HashMap<&str, &str> = new_entries.iter().map(|e| (e.key, e.text)).collect();
    let mut out = Vec::new();
    for entry in &new_entries {
        let status = match before.get(entry.key) {
            None => ChangeStatus::Added,
            Some(text) if normalized(text) != normalized(entry.text) => ChangeStatus::Modified,
            Some(_) => continue,
        };
        out.push(BibChange { key: entry.key.to_string(), status });
    }
    for entry in old_entries.iter().filter(|e| !after.contains_key(e.key)) {
        out.push(BibChange { key: entry.key.to_string(), status: ChangeStatus::Deleted });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIB: &str = "% my references, mail me@example.com\n\
        @comment{ignored, really}\n\
        @string{jml = {Journal of ML}}\n\
        @Article{knuth84,\n  title = {Literate {P}rogramming},\n  journal = jml,\n}\n\n\
        @book(lamport94, title = \"LaTeX (2nd ed.)\", year = 1994)\n\
        @misc{knuth84, title = {Duplicate}}\n";

    #[test]
    fn parses_entries_by_key_with_nested_delimiters() {
        let found = entries(BIB);
        let keys: Vec<&str> = found.iter().map(|e| e.key).collect();
        assert_eq!(keys, ["knuth84", "lamport94"]);
        assert!(found[0].text.starts_with("@Article{knuth84,") && found[0].text.ends_with("jml,\n}"));
        assert!(found[1].text.ends_with("year = 1994)"));
    }

    #[test]
    fn unterminated_entry_runs_to_the_end() {
        let found = entries("@article{a, title = {x}}\n@article{b, title = {open");
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].text, "@article{b, title = {open");
    }

    #[test]
    fn compares_entries_by_key() {
        let old = "@article{kept, title = {Same}}\n@article{edited, year = 2020}\n@article{gone, year = 1}\n";
        let new = "@ARTICLE{kept,\n    title = {Same}\n}\n@article{added, year = 2}\n@article{edited, year = 2021}\n";
        assert_eq!(
            changes(old, new),
            [
                BibChange { key: "added".into(), status: ChangeStatus::Added },
                BibChange { key: "edited".into(), status: ChangeStatus::Modified },
                BibChange { key: "gone".into(), status: ChangeStatus::Deleted },
            ]
        );
        assert!(changes(old, old).is_empty());
        assert_eq!(normalized("@Book{k,\n  title = {Two  words} ,\n}"), "@book{k,title={Two words},}");
        assert_ne!(normalized("@book{k, title = {Two words}}"), normalized("@book{k, title = {Twowords}}"));
    }
}
