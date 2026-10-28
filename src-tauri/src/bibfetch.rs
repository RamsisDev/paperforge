//! References by identifier, fetched here because the desktop CSP blocks frontend requests: a DOI
//! through doi.org content negotiation, an arXiv id through the arXiv API. Either way the result
//! is one formatted BibTeX entry under a fresh citation key.

use std::time::Duration;

use serde::Serialize;

const TIMEOUT_SECS: u64 = 10;
const DOI_HOST: &str = "doi.org";
const ARXIV_HOST: &str = "export.arxiv.org";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identifier {
    Doi(String),
    /// As typed, with its version if it had one: `2401.01234v2`, `hep-th/9901001`.
    Arxiv(String),
}

#[derive(Debug, Serialize)]
pub struct Lookup {
    pub key: String,
    pub bibtex: String,
}

/// One BibTeX entry; field values are kept as written (`{…}`, `"…"`, `dec`, `a # b`).
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub kind: String,
    pub fields: Vec<(String, String)>,
}

impl Entry {
    fn get(&self, name: &str) -> Option<&str> {
        self.fields.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, PartialEq)]
enum FetchError {
    Offline,
    Timeout,
    NotFound,
    Status(u16),
    Other(String),
}

impl From<ureq::Error> for FetchError {
    fn from(error: ureq::Error) -> Self {
        match error {
            ureq::Error::StatusCode(404 | 410) => Self::NotFound,
            ureq::Error::StatusCode(code) => Self::Status(code),
            ureq::Error::Timeout(_) => Self::Timeout,
            ureq::Error::Io(e) if e.kind() == std::io::ErrorKind::TimedOut => Self::Timeout,
            ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Io(_) => Self::Offline,
            other => Self::Other(other.to_string()),
        }
    }
}

fn describe(error: FetchError, host: &str, what: &str) -> String {
    match error {
        FetchError::Offline => format!("Could not reach {host}. Check your internet connection and try again."),
        FetchError::Timeout => format!("{host} did not answer within {TIMEOUT_SECS} s. Try again later."),
        FetchError::NotFound => format!("{what} was not found on {host}."),
        FetchError::Status(406) => format!("{host} has no BibTeX for {what}."),
        FetchError::Status(code) => format!("{host} answered HTTP {code} for {what}."),
        FetchError::Other(message) => format!("{host}: {message}"),
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    s.get(..prefix.len()).filter(|p| p.eq_ignore_ascii_case(prefix)).map(|_| &s[prefix.len()..])
}

fn strip_scheme(s: &str) -> &str {
    let s = strip_prefix_ci(s, "https://").or_else(|| strip_prefix_ci(s, "http://")).unwrap_or(s);
    strip_prefix_ci(s, "www.").unwrap_or(s)
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `10.1234/abc` from a bare DOI, `doi:10.1234/abc` or a `https://doi.org/…` link.
pub fn normalize_doi(input: &str) -> Option<String> {
    let s = input.trim();
    let s = strip_prefix_ci(s, "doi:").map(str::trim_start).unwrap_or(s);
    let s = strip_scheme(s);
    let s = ["dx.doi.org/", "doi.org/"].iter().find_map(|host| strip_prefix_ci(s, host)).unwrap_or(s);
    let doi = percent_decode(s);
    let (prefix, suffix) = doi.split_once('/')?;
    let registrant = prefix.strip_prefix("10.")?;
    let valid = registrant.split('.').all(all_digits) && !suffix.is_empty() && !doi.contains(char::is_whitespace);
    valid.then_some(doi)
}

fn split_version(id: &str) -> (&str, Option<&str>) {
    match id.rfind('v') {
        Some(i) if i > 0 && all_digits(&id[i + 1..]) => (&id[..i], Some(&id[i + 1..])),
        _ => (id, None),
    }
}

fn is_arxiv_id(id: &str) -> bool {
    let (base, _) = split_version(id);
    if let Some((yymm, number)) = base.split_once('.')
        && yymm.len() == 4
        && all_digits(yymm)
        && (4..=5).contains(&number.len())
        && all_digits(number)
    {
        return true;
    }
    let Some((archive, number)) = base.split_once('/') else { return false };
    let (name, class) = archive.split_once('.').unwrap_or((archive, ""));
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
        && (class.is_empty() || (class.len() == 2 && class.bytes().all(|b| b.is_ascii_uppercase())))
        && number.len() == 7
        && all_digits(number)
}

/// An arXiv id from `2401.01234v2`, `arXiv:hep-th/9901001` or an abs/pdf link.
pub fn parse_arxiv_id(input: &str) -> Option<String> {
    let s = input.trim();
    let s = strip_prefix_ci(s, "arxiv:").map(str::trim_start).unwrap_or(s);
    let s = strip_scheme(s);
    let s = strip_prefix_ci(s, "export.").unwrap_or(s);
    let s = match strip_prefix_ci(s, "arxiv.org/") {
        Some(path) => ["abs/", "pdf/"].iter().find_map(|p| strip_prefix_ci(path, p)).unwrap_or(path),
        None => s,
    };
    let id = s.split(['?', '#']).next()?.trim_end_matches('/');
    let id = id.strip_suffix(".pdf").unwrap_or(id);
    is_arxiv_id(id).then(|| id.to_string())
}

pub fn parse_identifier(query: &str) -> Result<Identifier, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("Enter a DOI or an arXiv id.".into());
    }
    if let Some(doi) = normalize_doi(q) {
        return Ok(Identifier::Doi(doi));
    }
    if let Some(id) = parse_arxiv_id(q) {
        return Ok(Identifier::Arxiv(id));
    }
    Err(format!("'{q}' is not a DOI (10.1234/…) or an arXiv id (2401.01234, hep-th/9901001)."))
}

/// Index just past the `}` matching the `{` at `start`.
fn braced_end(b: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, &c) in b.iter().enumerate().skip(start) {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Index just past the `"` closing the one at `start`, ignoring quotes inside braces.
fn quoted_end(b: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, &c) in b.iter().enumerate().skip(start + 1) {
        match c {
            b'{' => depth += 1,
            b'}' => depth = depth.checked_sub(1)?,
            b'"' if depth == 0 => return Some(i + 1),
            _ => {}
        }
    }
    None
}

/// Length of the field value at the start of `s`: pieces joined with `#`.
fn value_len(s: &str, close: u8) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    loop {
        while b.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        match *b.get(i)? {
            b'{' => i = braced_end(b, i)?,
            b'"' => i = quoted_end(b, i)?,
            _ => {
                let start = i;
                while b.get(i).is_some_and(|&c| !matches!(c, b',' | b'#' | b'}') && c != close && !c.is_ascii_whitespace()) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
            }
        }
        let end = i;
        while b.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        if b.get(i) == Some(&b'#') {
            i += 1;
            continue;
        }
        return Some(end);
    }
}

/// The first entry of a BibTeX text, field names lowercased.
pub fn parse_entry(text: &str) -> Option<Entry> {
    let rest = &text[text.find('@')? + 1..];
    let open = rest.find(['{', '('])?;
    let kind = rest[..open].trim().to_ascii_lowercase();
    if kind.is_empty() || !kind.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let close = if rest.as_bytes()[open] == b'{' { b'}' } else { b')' };
    let body = &rest[open + 1..];
    let mut s = &body[body.find(',')? + 1..];
    let mut fields = Vec::new();
    loop {
        s = s.trim_start_matches(|c: char| c.is_whitespace() || c == ',');
        if *s.as_bytes().first()? == close {
            break;
        }
        let name_len = s.find(|c: char| !(c.is_ascii_alphanumeric() || "_-:.+".contains(c))).unwrap_or(s.len());
        if name_len == 0 {
            return None;
        }
        let name = s[..name_len].to_ascii_lowercase();
        s = s[name_len..].trim_start().strip_prefix('=')?.trim_start();
        let len = value_len(s, close)?;
        fields.push((name, s[..len].to_string()));
        s = &s[len..];
    }
    Some(Entry { kind, fields })
}

pub fn format_entry(entry: &Entry, key: &str) -> String {
    let width = entry.fields.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
    let mut out = format!("@{}{{{key},\n", entry.kind);
    for (i, (name, value)) in entry.fields.iter().enumerate() {
        let comma = if i + 1 < entry.fields.len() { "," } else { "" };
        out.push_str(&format!("  {name:<width$} = {value}{comma}\n"));
    }
    out.push_str("}\n");
    out
}

fn strip_delims(value: &str) -> &str {
    let v = value.trim();
    let b = v.as_bytes();
    let wrapped = b.len() >= 2
        && ((b[0] == b'{' && braced_end(b, 0) == Some(b.len())) || (b[0] == b'"' && quoted_end(b, 0) == Some(b.len())));
    if wrapped { &v[1..v.len() - 1] } else { v }
}

/// Text without TeX commands, braces or math delimiters, whitespace collapsed.
fn clean_tex(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.peek() {
                Some(n) if n.is_ascii_alphabetic() => {
                    let mut name = String::new();
                    while let Some(&n) = chars.peek().filter(|n| n.is_ascii_alphabetic()) {
                        name.push(n);
                        chars.next();
                    }
                    const KEPT: &[&str] =
                        &["ss", "o", "O", "ae", "AE", "oe", "OE", "l", "L", "aa", "AA", "i", "j", "TeX", "LaTeX", "BibTeX"];
                    if KEPT.contains(&name.as_str()) {
                        out.push_str(&name);
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '{' | '}' | '$' => {}
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lowercase ASCII letters and digits only, common Latin accents folded.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in clean_tex(s).to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            continue;
        }
        out.push_str(match c {
            'à'..='å' | 'ā' | 'ă' | 'ą' => "a",
            'æ' => "ae",
            'ç' | 'ć' | 'č' => "c",
            'ď' | 'đ' => "d",
            'è'..='ë' | 'ē' | 'ę' | 'ě' => "e",
            'ğ' => "g",
            'ì'..='ï' | 'ı' | 'ī' => "i",
            'ł' => "l",
            'ñ' | 'ń' | 'ň' => "n",
            'ò'..='ö' | 'ø' | 'ő' | 'ō' => "o",
            'œ' => "oe",
            'ř' => "r",
            'ś' | 'š' | 'ş' => "s",
            'ß' => "ss",
            'ť' => "t",
            'ù'..='ü' | 'ű' | 'ů' | 'ū' => "u",
            'ý' | 'ÿ' => "y",
            'ź' | 'ż' | 'ž' => "z",
            _ => "",
        });
    }
    out
}

/// Names of a BibTeX `author` value, split on ` and ` outside braces.
fn split_names(author: &str) -> Vec<&str> {
    let b = author.as_bytes();
    let mut names = Vec::new();
    let (mut depth, mut start, mut i) = (0usize, 0, 0);
    while i < b.len() {
        match b[i] {
            b'{' => depth += 1,
            b'}' => depth = depth.saturating_sub(1),
            c if depth == 0
                && c.is_ascii_whitespace()
                && author.get(i + 1..i + 4).is_some_and(|w| w.eq_ignore_ascii_case("and"))
                && b.get(i + 4).is_some_and(u8::is_ascii_whitespace) =>
            {
                names.push(author[start..i].trim());
                i += 4;
                start = i;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    names.push(author[start..].trim());
    names.retain(|n| !n.is_empty());
    names
}

fn last_name(name: &str) -> &str {
    if let Some((last, _)) = name.split_once(',') {
        return last;
    }
    if strip_delims(name) != name {
        return name;
    }
    name.split_whitespace().last().unwrap_or("")
}

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "on", "of", "in", "for", "and", "to", "with", "at", "by", "from", "is", "are", "via", "towards",
    "toward", "de", "la", "el", "los", "las", "un", "una", "del", "en", "y",
];

/// `lastname` + year + first significant title word, made unique against `existing`
/// (case-insensitively, like BibTeX) with a letter, then a number.
pub fn citation_key(entry: &Entry, existing: &[String]) -> String {
    let field = |name: &str| entry.get(name).map(strip_delims).unwrap_or_default();
    let author = Some(field("author")).filter(|a| !a.is_empty()).unwrap_or_else(|| field("editor"));
    let last = split_names(author).first().map(|n| slug(last_name(n))).unwrap_or_default();
    let year: String = clean_tex(field("year")).chars().filter(char::is_ascii_digit).take(4).collect();
    let title = clean_tex(field("title"));
    let word = title
        .split(|c: char| !c.is_alphanumeric())
        .find(|w| !w.is_empty() && !STOPWORDS.contains(&w.to_lowercase().as_str()))
        .map(slug)
        .unwrap_or_default();
    let base = format!("{last}{year}{word}");
    let base = if base.is_empty() { "ref".to_string() } else { base };
    let taken = |key: &str| existing.iter().any(|e| e.eq_ignore_ascii_case(key));
    if !taken(&base) {
        return base;
    }
    ('a'..='z')
        .map(|c| format!("{base}{c}"))
        .chain((2..).map(|n| format!("{base}{n}")))
        .find(|k| !taken(k))
        .expect("an unbounded sequence has a free key")
}

/// Plain text as a braced BibTeX value: TeX specials escaped outside `$…$`.
fn tex_value(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    let (mut math, mut prev) = (false, '\0');
    for c in text.chars() {
        if c == '$' && prev != '\\' {
            math = !math;
        }
        if !math && matches!(c, '&' | '%' | '#' | '_') && prev != '\\' {
            out.push('\\');
        }
        out.push(c);
        prev = c;
    }
    let balanced = braced_end(format!("{{{out}}}").as_bytes(), 0) == Some(out.len() + 2);
    if !balanced {
        out.retain(|c| c != '{' && c != '}');
    }
    format!("{{{out}}}")
}

fn decode_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let decoded = rest.find(';').filter(|&end| end <= 10).and_then(|end| {
            let name = &rest[1..end];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => match name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok().and_then(char::from_u32),
                    None => name.strip_prefix('#').and_then(|d| d.parse().ok()).and_then(char::from_u32),
                },
            };
            c.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Each `<name …>…</name>` element in `xml`: its start tag and its inner text, not decoded.
fn elements<'a>(xml: &'a str, name: &str) -> Vec<(&'a str, &'a str)> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find(&open) {
        let after = &rest[at + open.len()..];
        if !after.starts_with(|c: char| c == '>' || c == '/' || c.is_whitespace()) {
            rest = after;
            continue;
        }
        let Some(tag_end) = after.find('>') else { break };
        let tag = &after[..tag_end];
        let body = &after[tag_end + 1..];
        if tag.ends_with('/') {
            found.push((tag, ""));
            rest = body;
        } else if let Some(end) = body.find(&close) {
            found.push((tag, &body[..end]));
            rest = &body[end + close.len()..];
        } else {
            break;
        }
    }
    found
}

fn element_text(xml: &str, name: &str) -> Option<String> {
    elements(xml, name).first().map(|(_, text)| decode_xml(text).split_whitespace().collect::<Vec<_>>().join(" "))
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let start = tag.find(&format!(" {name}=\""))? + name.len() + 3;
    let len = tag[start..].find('"')?;
    Some(decode_xml(&tag[start..start + len]))
}

/// The BibTeX for the first entry of an arXiv API Atom feed.
fn arxiv_entry(xml: &str, requested: &str) -> Result<Entry, FetchError> {
    let (_, entry) = elements(xml, "entry").into_iter().next().ok_or(FetchError::NotFound)?;
    let id = element_text(entry, "id").unwrap_or_default();
    let title = element_text(entry, "title").unwrap_or_default();
    if id.contains("/api/errors") {
        let summary = element_text(entry, "summary").unwrap_or(title);
        return Err(FetchError::Other(summary));
    }
    if title.is_empty() || title == "Error" {
        return Err(FetchError::NotFound);
    }
    let authors: Vec<String> = elements(entry, "author")
        .into_iter()
        .filter_map(|(_, author)| element_text(author, "name"))
        .filter(|n| !n.is_empty())
        .collect();
    let year: String = element_text(entry, "published").unwrap_or_default().chars().take(4).collect();
    let journal = element_text(entry, "arxiv:journal_ref").filter(|j| !j.is_empty());
    let doi = element_text(entry, "arxiv:doi").filter(|d| !d.is_empty());
    let class = elements(entry, "arxiv:primary_category")
        .first()
        .or(elements(entry, "category").first())
        .and_then(|(tag, _)| attribute(tag, "term"));

    let mut fields = Vec::new();
    let mut add = |name: &str, value: String| fields.push((name.to_string(), value));
    if !authors.is_empty() {
        add("author", tex_value(&authors.join(" and ")));
    }
    add("title", tex_value(&title));
    if let Some(journal) = &journal {
        add("journal", tex_value(journal));
    }
    if all_digits(&year) {
        add("year", format!("{{{year}}}"));
    }
    add("eprint", format!("{{{}}}", split_version(requested).0));
    add("archiveprefix", "{arXiv}".into());
    if let Some(class) = class {
        add("primaryclass", format!("{{{class}}}"));
    }
    if let Some(doi) = doi {
        add("doi", format!("{{{doi}}}"));
    }
    add("url", format!("{{https://arxiv.org/abs/{requested}}}"));
    let kind = if journal.is_some() { "article" } else { "misc" };
    Ok(Entry { kind: kind.into(), fields })
}

fn encode_doi_path(doi: &str) -> String {
    let mut out = String::with_capacity(doi.len());
    for b in doi.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:;()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn get(url: &str, accept: &str) -> Result<String, FetchError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(TIMEOUT_SECS)))
        .user_agent(concat!("PaperForge/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut response = agent.get(url).header("Accept", accept).call()?;
    Ok(response.body_mut().read_to_string()?)
}

fn fetch(id: &Identifier) -> Result<Entry, String> {
    match id {
        Identifier::Doi(doi) => {
            let what = format!("DOI {doi}");
            let url = format!("https://{DOI_HOST}/{}", encode_doi_path(doi));
            let body = get(&url, "application/x-bibtex; charset=utf-8").map_err(|e| describe(e, DOI_HOST, &what))?;
            parse_entry(&body)
                .filter(|e| !e.fields.is_empty())
                .ok_or_else(|| describe(FetchError::Other(format!("the answer for {what} is not BibTeX")), DOI_HOST, &what))
        }
        Identifier::Arxiv(arxiv) => {
            let what = format!("arXiv:{arxiv}");
            let url = format!("https://{ARXIV_HOST}/api/query?id_list={arxiv}&max_results=1");
            let body = get(&url, "application/atom+xml").map_err(|e| describe(e, ARXIV_HOST, &what))?;
            arxiv_entry(&body, arxiv).map_err(|e| describe(e, ARXIV_HOST, &what))
        }
    }
}

/// Looks up a DOI or arXiv id and returns its entry under a key not in `existing`.
pub async fn lookup(query: &str, existing: &[String]) -> Result<Lookup, String> {
    let id = parse_identifier(query)?;
    let entry = tokio::task::spawn_blocking(move || fetch(&id)).await.map_err(|e| e.to_string())??;
    let key = citation_key(&entry, existing);
    Ok(Lookup { bibtex: format_entry(&entry, &key), key })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CROSSREF: &str = " @article{Vaswani_2017, title={Attention Is All You Need}, volume={30}, \
        url={http://dx.doi.org/10.5555/3295222.3295349}, DOI={10.5555/3295222.3295349}, \
        journal={Advances in Neural Information Processing Systems}, author={Vaswani, Ashish and Shazeer, Noam}, \
        year={2017}, month=dec, pages={5998--6008} }\n";

    const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?id_list=1706.03762v5" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=&amp;id_list=1706.03762v5</title>
  <id>http://arxiv.org/api/abc</id>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
  You Need: 50% &amp; $O(n_k)$ #1</title>
    <summary>The dominant sequence transduction models...</summary>
    <author>
      <name>Ashish Vaswani</name>
    </author>
    <author>
      <name>&#321;ukasz Kaiser</name>
    </author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.48550/arXiv.1706.03762</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">NeurIPS 30 (2017)</arxiv:journal_ref>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>"#;

    #[test]
    fn normalizes_dois() {
        for input in [
            "10.1000/xyz123",
            " doi:10.1000/xyz123 ",
            "DOI: 10.1000/xyz123",
            "https://doi.org/10.1000/xyz123",
            "http://dx.doi.org/10.1000/xyz123",
            "https://www.doi.org/10.1000%2Fxyz123",
        ] {
            assert_eq!(normalize_doi(input).as_deref(), Some("10.1000/xyz123"), "{input}");
        }
        assert_eq!(normalize_doi("10.1002/(SICI)1097-4571").as_deref(), Some("10.1002/(SICI)1097-4571"));
        assert_eq!(normalize_doi("10.1000.10/abc").as_deref(), Some("10.1000.10/abc"));
        for bad in ["", "10.1000", "10.1000/", "11.1000/x", "10.ab/x", "10.1000/x y", "2401.01234", "https://example.com/10.1/x"] {
            assert_eq!(normalize_doi(bad), None, "{bad}");
        }
        assert_eq!(encode_doi_path("10.1002/(SICI)1097<12>#x"), "10.1002/(SICI)1097%3C12%3E%23x");
    }

    #[test]
    fn parses_arxiv_ids() {
        for (input, id) in [
            ("2401.01234", "2401.01234"),
            ("2401.01234v2", "2401.01234v2"),
            ("0704.0001", "0704.0001"),
            ("arXiv:2401.01234", "2401.01234"),
            ("https://arxiv.org/abs/2401.01234v2", "2401.01234v2"),
            ("https://arxiv.org/pdf/2401.01234v2.pdf", "2401.01234v2"),
            ("arxiv.org/pdf/2401.01234", "2401.01234"),
            ("http://export.arxiv.org/abs/2401.01234?context=cs", "2401.01234"),
            ("hep-th/9901001", "hep-th/9901001"),
            ("hep-th/9901001v3", "hep-th/9901001v3"),
            ("math.GT/0309136", "math.GT/0309136"),
            ("https://arxiv.org/abs/solv-int/9901001/", "solv-int/9901001"),
        ] {
            assert_eq!(parse_arxiv_id(input).as_deref(), Some(id), "{input}");
        }
        for bad in ["", "2401.123", "2401.123456", "240.01234", "hep-th/990100", "HEP-TH/9901001", "math.gt/0309136", "2401.01234v"] {
            assert_eq!(parse_arxiv_id(bad), None, "{bad}");
        }
        assert_eq!(split_version("hep-th/9901001v3"), ("hep-th/9901001", Some("3")));
        assert_eq!(split_version("solv-int/9901001"), ("solv-int/9901001", None));
    }

    #[test]
    fn identifies_queries() {
        assert_eq!(parse_identifier("https://doi.org/10.1/a"), Ok(Identifier::Doi("10.1/a".into())));
        assert_eq!(parse_identifier("10.48550/arXiv.2401.01234"), Ok(Identifier::Doi("10.48550/arXiv.2401.01234".into())));
        assert_eq!(parse_identifier("arXiv:2401.01234v2"), Ok(Identifier::Arxiv("2401.01234v2".into())));
        assert!(parse_identifier("  ").unwrap_err().contains("Enter"));
        assert!(parse_identifier("hello world").unwrap_err().contains("not a DOI"));
    }

    #[test]
    fn parses_and_formats_bibtex() {
        let entry = parse_entry(CROSSREF).unwrap();
        assert_eq!(entry.kind, "article");
        assert_eq!(entry.get("doi"), Some("{10.5555/3295222.3295349}"));
        assert_eq!(entry.get("month"), Some("dec"));
        assert_eq!(entry.get("pages"), Some("{5998--6008}"));
        let text = format_entry(&entry, "vaswani2017attention");
        assert!(text.starts_with("@article{vaswani2017attention,\n  title   = {Attention Is All You Need},\n"), "{text}");
        assert!(text.ends_with("  pages   = {5998--6008}\n}\n"), "{text}");
        assert_eq!(parse_entry(&text).unwrap(), entry);

        let odd = parse_entry("@Book(k, Title = \"A {\"}quoted\" # \" b\", note = {x {y} z}, year = 1999)").unwrap();
        assert_eq!(odd.kind, "book");
        assert_eq!(odd.get("title"), Some("\"A {\"}quoted\" # \" b\""));
        assert_eq!(odd.get("note"), Some("{x {y} z}"));
        assert_eq!(odd.get("year"), Some("1999"));
        for bad in ["", "<html>Not found</html>", "@article{k, title={unclosed", "@{k, a=1}"] {
            assert_eq!(parse_entry(bad), None, "{bad}");
        }
    }

    fn entry(fields: &[(&str, &str)]) -> Entry {
        Entry { kind: "article".into(), fields: fields.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn generates_citation_keys() {
        let keys = |fields: &[(&str, &str)]| citation_key(&entry(fields), &[]);
        assert_eq!(keys(&[("author", "{Vaswani, Ashish and Shazeer, Noam}"), ("year", "{2017}"), ("title", "{Attention Is All You Need}")]), "vaswani2017attention");
        assert_eq!(keys(&[("author", "{Donald E. Knuth}"), ("year", "1984"), ("title", "{The {\\TeX}book}")]), "knuth1984texbook");
        assert_eq!(keys(&[("author", "{G{\\\"o}del, Kurt}"), ("year", "{1931}"), ("title", "{{\\\"U}ber formal unentscheidbare S\u{e4}tze}")]), "godel1931uber");
        assert_eq!(keys(&[("author", "{Łukasz Kaiser and Others}"), ("title", "{On $\\alpha$-Nets}")]), "kaisernets");
        assert_eq!(keys(&[("author", "{{OpenAI Team} and Smith, J.}"), ("year", "{2023}"), ("title", "{GPT-4}")]), "openaiteam2023gpt");
        assert_eq!(keys(&[("editor", "{Strau\\ss, Anna}"), ("year", "{c. 2001}")]), "strauss2001");
        assert_eq!(keys(&[("title", "{}")]), "ref");
    }

    #[test]
    fn deduplicates_citation_keys() {
        let e = entry(&[("author", "{Smith, J.}"), ("year", "{2020}"), ("title", "{Deep Nets}")]);
        let taken = |keys: &[&str]| citation_key(&e, &keys.iter().map(|k| k.to_string()).collect::<Vec<_>>());
        assert_eq!(taken(&["other"]), "smith2020deep");
        assert_eq!(taken(&["Smith2020Deep"]), "smith2020deepa");
        assert_eq!(taken(&["smith2020deep", "smith2020deepa"]), "smith2020deepb");
        let all: Vec<String> = std::iter::once("smith2020deep".to_string())
            .chain(('a'..='z').map(|c| format!("smith2020deep{c}")))
            .collect();
        let refs: Vec<&str> = all.iter().map(String::as_str).collect();
        assert_eq!(taken(&refs), "smith2020deep2");
    }

    #[test]
    fn builds_arxiv_entries() {
        let entry = arxiv_entry(ATOM, "1706.03762v5").unwrap();
        let text = format_entry(&entry, &citation_key(&entry, &[]));
        assert_eq!(
            text,
            "@article{vaswani2017attention,\n\
             \x20 author        = {Ashish Vaswani and Łukasz Kaiser},\n\
             \x20 title         = {Attention Is All You Need: 50\\% \\& $O(n_k)$ \\#1},\n\
             \x20 journal       = {NeurIPS 30 (2017)},\n\
             \x20 year          = {2017},\n\
             \x20 eprint        = {1706.03762},\n\
             \x20 archiveprefix = {arXiv},\n\
             \x20 primaryclass  = {cs.CL},\n\
             \x20 doi           = {10.48550/arXiv.1706.03762},\n\
             \x20 url           = {https://arxiv.org/abs/1706.03762v5}\n\
             }\n"
        );

        let preprint = ATOM.replace(r#"<arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">NeurIPS 30 (2017)</arxiv:journal_ref>"#, "");
        let preprint = preprint.replace("<arxiv:primary_category", "<arxiv:other");
        let entry = arxiv_entry(&preprint, "1706.03762").unwrap();
        assert_eq!(entry.kind, "misc");
        assert_eq!(entry.get("journal"), None);
        assert_eq!(entry.get("primaryclass"), Some("{cs.LG}"));
        assert_eq!(entry.get("url"), Some("{https://arxiv.org/abs/1706.03762}"));
    }

    #[test]
    fn maps_arxiv_misses_and_errors() {
        let empty = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title></feed>"#;
        assert_eq!(arxiv_entry(empty, "2401.99999"), Err(FetchError::NotFound));
        let blank = r#"<feed><entry><id>http://arxiv.org/abs/2401.99999</id><title></title></entry></feed>"#;
        assert_eq!(arxiv_entry(blank, "2401.99999"), Err(FetchError::NotFound));
        let error = r#"<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_x</id>
            <title>Error</title><summary>incorrect id format for x</summary></entry></feed>"#;
        assert_eq!(arxiv_entry(error, "x"), Err(FetchError::Other("incorrect id format for x".into())));
    }

    #[test]
    fn decodes_xml_and_escapes_tex() {
        assert_eq!(decode_xml("a &amp; b &lt;c&gt; &quot;&apos; &#233;&#x00E9; &bogus; & x"), "a & b <c> \"' éé &bogus; & x");
        assert_eq!(tex_value("50% & #1 a_b $x_1 & y$ \\& done"), "{50\\% \\& \\#1 a\\_b $x_1 & y$ \\& done}");
        assert_eq!(tex_value("broken } brace {"), "{broken  brace }");
        assert_eq!(tex_value("ok {Nested} braces"), "{ok {Nested} braces}");
    }

    #[test]
    fn maps_fetch_errors() {
        assert_eq!(FetchError::from(ureq::Error::StatusCode(404)), FetchError::NotFound);
        assert_eq!(FetchError::from(ureq::Error::StatusCode(503)), FetchError::Status(503));
        assert_eq!(FetchError::from(ureq::Error::HostNotFound), FetchError::Offline);
        assert_eq!(FetchError::from(ureq::Error::ConnectionFailed), FetchError::Offline);
        let timed_out = std::io::Error::new(std::io::ErrorKind::TimedOut, "slow");
        assert_eq!(FetchError::from(ureq::Error::Io(timed_out)), FetchError::Timeout);

        let what = "DOI 10.1/x";
        assert_eq!(describe(FetchError::Offline, DOI_HOST, what), "Could not reach doi.org. Check your internet connection and try again.");
        assert_eq!(describe(FetchError::Timeout, DOI_HOST, what), "doi.org did not answer within 10 s. Try again later.");
        assert_eq!(describe(FetchError::NotFound, DOI_HOST, what), "DOI 10.1/x was not found on doi.org.");
        assert_eq!(describe(FetchError::Status(406), DOI_HOST, what), "doi.org has no BibTeX for DOI 10.1/x.");
        assert_eq!(describe(FetchError::Status(500), DOI_HOST, what), "doi.org answered HTTP 500 for DOI 10.1/x.");
    }

    #[tokio::test]
    async fn rejects_bad_queries_without_network() {
        assert!(lookup("not an id", &[]).await.unwrap_err().contains("not a DOI"));
    }

    #[tokio::test]
    #[ignore = "needs the network"]
    async fn looks_up_real_identifiers() {
        let doi = lookup("https://doi.org/10.1038/nature14539", &[]).await.unwrap();
        assert_eq!(doi.key, "lecun2015deep");
        assert!(doi.bibtex.starts_with("@article{lecun2015deep,\n"), "{}", doi.bibtex);
        let arxiv = lookup("arXiv:1706.03762v5", &["vaswani2017attention".into()]).await.unwrap();
        assert_eq!(arxiv.key, "vaswani2017attentiona");
        assert!(arxiv.bibtex.contains("eprint        = {1706.03762}"), "{}", arxiv.bibtex);
        let old = lookup("hep-th/9901001", &[]).await.unwrap();
        assert!(old.bibtex.contains("archiveprefix = {arXiv}"), "{}", old.bibtex);
        let missing = lookup("10.1000/this-doi-does-not-exist-pf", &[]).await.unwrap_err();
        assert!(missing.contains("was not found"), "{missing}");
    }
}
