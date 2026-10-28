//! Markdown -> LaTeX (Pandoc + the template's Lua filter) -> PDF (Tectonic).
//!
//! Tectonic runs offline first against the cache seeded at install time; it only goes online
//! when a document asks for a package or BibTeX style the cache does not have.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::project::{self, BIB_FILE, BODY_FILE, PaperMeta};

/// The default relay redirects to a mirror that is unreachable; this host serves the same bundle.
pub const BUNDLE_URL: &str = "https://data1.fullyjustified.net/tlextras-2022.0r0.tar";
pub const TEMPLATES: [&str; 5] = ["article", "ieee", "acm", "elsevier", "lncs"];
pub const TEX_FILE: &str = "paper.tex";

const PANDOC_TIMEOUT: Duration = Duration::from_secs(30);
const TEX_OFFLINE_TIMEOUT: Duration = Duration::from_secs(90);
const TEX_ONLINE_TIMEOUT: Duration = Duration::from_secs(300);
const INTERMEDIATES: [&str; 5] = ["paper.aux", "paper.bbl", "paper.blg", "paper.out", "paper.toc"];
const TEMPLATE_STAMP: &str = "template.txt";

#[derive(Debug, Clone)]
pub struct Toolchain {
    pub pandoc: PathBuf,
    pub tectonic: PathBuf,
    pub templates: PathBuf,
    pub tex_cache: PathBuf,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CompileMode {
    /// One TeX pass on top of the previous run's .aux/.bbl: fast enough to run while typing.
    Preview,
    /// As many passes as TeX needs; used for export.
    Full,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    pub stage: &'static str,
    pub message: String,
    /// `paper.tex` (generated, mapped back to Markdown by the editor) or `refs.bib`.
    pub file: Option<String>,
    /// 1-based line in `file`.
    pub line: Option<usize>,
    /// The generated paper.tex line, which the editor uses to find the Markdown line.
    pub source: Option<String>,
}

impl Diagnostic {
    fn new(severity: Severity, stage: &'static str, message: impl Into<String>) -> Self {
        Self { severity, stage, message: message.into(), file: None, line: None, source: None }
    }

    fn at(mut self, file: &str, line: usize) -> Self {
        self.file = Some(file.to_string());
        self.line = Some(line);
        self
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileOutcome {
    pub ok: bool,
    pub cancelled: bool,
    pub pdf_path: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub pandoc_ms: u128,
    pub tex_ms: u128,
    pub used_network: bool,
    /// A preview pass changed labels or citations; another pass settles them.
    pub needs_rerun: bool,
}

impl CompileOutcome {
    pub fn cancelled() -> Self {
        Self { cancelled: true, ..Self::default() }
    }
}

fn keywords_label(lang: &str) -> &'static str {
    match lang.split(['-', '_']).next().unwrap_or("en") {
        "es" => "Palabras clave",
        "pt" => "Palavras-chave",
        "fr" => "Mots-clés",
        "de" => "Schlüsselwörter",
        "it" => "Parole chiave",
        _ => "Keywords",
    }
}

/// Pandoc reads metadata strings as Markdown; names and emails must stay literal
/// (`ada@example.org` would otherwise parse as a citation).
fn escape_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_punctuation() && c != '.' && c != ',' && c != '-' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn pandoc_metadata(meta: &PaperMeta, has_bib: bool) -> Value {
    let authors: Vec<Value> = meta
        .authors
        .iter()
        .filter(|a| !a.name.trim().is_empty())
        .enumerate()
        .map(|(i, a)| {
            json!({
                "name": escape_markdown(a.name.trim()),
                "affiliation": escape_markdown(a.affiliation.trim()),
                "email": escape_markdown(a.email.trim()),
                "n": (i + 1).to_string(),
            })
        })
        .collect();
    let keywords: Vec<String> = meta
        .keywords
        .iter()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .map(escape_markdown)
        .collect();
    let mut doc = json!({
        "title": meta.title,
        "author": authors,
        "abstract": meta.abstract_text,
        "keywords": keywords,
        "keywords-label": keywords_label(&meta.language),
        "lang": if meta.language.is_empty() { "en" } else { &meta.language },
        "date": meta.date,
    });
    if has_bib {
        doc["bibliography"] = json!(BIB_FILE.trim_end_matches(".bib"));
    }
    if meta.bib_style.trim().is_empty() {
        if NUMERIC_ONLY_DEFAULT_STYLES.contains(&meta.template.as_str()) {
            doc["numeric-only-citations"] = json!(true);
        }
    } else {
        doc["biblio-style"] = json!(meta.bib_style.trim());
    }
    doc
}

/// Templates whose default BibTeX style has no author names, so `@key` in running text cannot
/// render as "Author [n]" and becomes a plain "[n]".
const NUMERIC_ONLY_DEFAULT_STYLES: [&str; 1] = ["lncs"];

struct RunOutput {
    success: bool,
    text: String,
}

async fn run(mut cmd: Command, timeout: Duration) -> Result<RunOutput, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("could not start {cmd:?}: {e}"))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("timed out after {}s", timeout.as_secs()))?
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(RunOutput { success: output.status.success(), text })
}

async fn read_or_empty(path: &Path) -> String {
    tokio::fs::read_to_string(path).await.unwrap_or_default()
}

async fn remove_intermediates(build: &Path) {
    for name in INTERMEDIATES {
        let _ = tokio::fs::remove_file(build.join(name)).await;
    }
}

pub async fn compile(tc: &Toolchain, dir: &Path, mode: CompileMode) -> Result<CompileOutcome, String> {
    let meta = project::read_meta(dir)?;
    if !TEMPLATES.contains(&meta.template.as_str()) {
        return Err(format!("Unknown template '{}'", meta.template));
    }
    let build = project::build_dir(dir);
    tokio::fs::create_dir_all(&build).await.map_err(|e| e.to_string())?;
    // A class's .aux commands are not defined in another class.
    let stamp = build.join(TEMPLATE_STAMP);
    if read_or_empty(&stamp).await != meta.template {
        remove_intermediates(&build).await;
        tokio::fs::write(&stamp, &meta.template).await.map_err(|e| e.to_string())?;
    }
    let has_bib = tokio::fs::metadata(dir.join(BIB_FILE)).await.is_ok_and(|m| m.len() > 0);
    let meta_path = build.join("meta.json");
    let meta_json = serde_json::to_vec(&pandoc_metadata(&meta, has_bib)).expect("json");
    tokio::fs::write(&meta_path, meta_json).await.map_err(|e| e.to_string())?;

    let mut outcome = CompileOutcome::default();

    let started = Instant::now();
    let pandoc_out = run(pandoc(tc, dir, &build, &meta.template), PANDOC_TIMEOUT).await?;
    outcome.pandoc_ms = started.elapsed().as_millis();
    outcome.diagnostics.extend(parse_pandoc(&pandoc_out.text));
    if !pandoc_out.success {
        if !outcome.diagnostics.iter().any(|d| d.severity == Severity::Error) {
            outcome.diagnostics.push(Diagnostic::new(Severity::Error, "pandoc", pandoc_out.text.trim()));
        }
        return Ok(outcome);
    }

    let started = Instant::now();
    let mut tex_out = run(tectonic(tc, dir, &build, mode, true), TEX_OFFLINE_TIMEOUT).await?;
    let mut blg = read_or_empty(&build.join("paper.blg")).await;
    if needs_network(&tex_out, &blg) {
        outcome.used_network = true;
        tex_out = run(tectonic(tc, dir, &build, mode, false), TEX_ONLINE_TIMEOUT).await?;
        blg = read_or_empty(&build.join("paper.blg")).await;
    }
    outcome.tex_ms = started.elapsed().as_millis();

    let log = read_or_empty(&build.join("paper.log")).await;
    let tex = read_or_empty(&build.join(TEX_FILE)).await;
    let tex_lines: Vec<&str> = tex.lines().collect();

    let mut tex_diagnostics = parse_tectonic(&tex_out.text);
    tex_diagnostics.extend(parse_log_warnings(&log));
    if !tex_out.success && !tex_diagnostics.iter().any(|d| d.severity == Severity::Error) {
        tex_diagnostics.push(Diagnostic::new(Severity::Error, "latex", last_meaningful_error(&tex_out.text)));
    }
    for d in &mut tex_diagnostics {
        if let Some(line) = d.line {
            d.source = tex_lines.get(line.saturating_sub(1)).map(|s| s.trim().to_string());
        }
    }
    outcome.diagnostics.extend(tex_diagnostics);
    outcome.diagnostics.extend(parse_blg(&blg));

    outcome.ok = tex_out.success;
    if tex_out.success {
        outcome.pdf_path = Some(build.join("paper.pdf").to_string_lossy().into_owned());
        outcome.needs_rerun = mode == CompileMode::Preview && log_requests_rerun(&log);
    } else {
        // A run that stopped mid-document can leave a truncated .aux that breaks the next one.
        remove_intermediates(&build).await;
    }
    Ok(outcome)
}

fn pandoc(tc: &Toolchain, dir: &Path, build: &Path, template: &str) -> Command {
    let mut cmd = Command::new(&tc.pandoc);
    cmd.current_dir(dir)
        .arg(BODY_FILE)
        .args(["--from", "markdown", "--to", "latex", "--standalone", "--natbib"])
        // Keeps paper.tex lines aligned with Markdown lines for error mapping.
        .arg("--wrap=preserve")
        .arg(format!("--template={}", tc.templates.join(format!("{template}.tex")).display()))
        .arg(format!("--lua-filter={}", tc.templates.join("paper.lua").display()))
        .arg(format!("--metadata-file={}", build.join("meta.json").display()))
        .arg(format!("--output={}", build.join(TEX_FILE).display()));
    cmd
}

fn tectonic(tc: &Toolchain, dir: &Path, build: &Path, mode: CompileMode, offline: bool) -> Command {
    let mut cmd = Command::new(&tc.tectonic);
    cmd.current_dir(dir)
        .env("TECTONIC_CACHE_DIR", &tc.tex_cache)
        .args(["--bundle", BUNDLE_URL, "--keep-logs", "--keep-intermediates"])
        .args(["--chatter", "minimal"])
        .arg("--outdir")
        .arg(build)
        .arg("-Z")
        .arg(format!("search-path={}", dir.display()));
    if mode == CompileMode::Preview {
        cmd.args(["--reruns", "0"]);
    }
    if offline {
        cmd.arg("--only-cached");
    }
    cmd.arg(build.join(TEX_FILE));
    cmd
}

/// An offline run reports a package missing from the cache as a missing file, babel reports a
/// missing language as an unknown option, and BibTeX only mentions a missing style in its log.
fn needs_network(tex: &RunOutput, blg: &str) -> bool {
    let out = &tex.text;
    let missing_tex_file = !tex.success
        && (out.contains("not found") && out.contains("File `")
            || out.contains("Package babel Error: Unknown option")
            || out.contains("isn't cached"));
    missing_tex_file || blg.contains("couldn't open style file")
}

fn log_requests_rerun(log: &str) -> bool {
    log.contains("Label(s) may have changed")
        || log.contains("Rerun to get cross-references right")
        || log.contains("Citation(s) may have changed")
        || log.contains("There were undefined citations")
        || log.contains("There were undefined references")
}

fn parse_pandoc(output: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("[WARNING]") {
                Some(Diagnostic::new(Severity::Warning, "pandoc", rest.trim()))
            } else {
                line.strip_prefix("Error")
                    .map(|rest| Diagnostic::new(Severity::Error, "pandoc", rest.trim_start_matches(':').trim()))
            }
        })
        .collect()
}

/// `error: paper.tex:12: Undefined control sequence` and `warning: paper.tex:3: ...`.
fn parse_tectonic(output: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in output.lines() {
        let (severity, rest) = if let Some(rest) = line.strip_prefix("error: ") {
            (Severity::Error, rest)
        } else if let Some(rest) = line.strip_prefix("warning: ") {
            (Severity::Warning, rest)
        } else {
            continue;
        };
        let mut parts = rest.splitn(3, ':');
        let (Some(file), Some(num), Some(message)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Ok(num) = num.trim().parse::<usize>() else { continue };
        if !file.ends_with(".tex") {
            continue;
        }
        let message = message.trim().trim_start_matches("! ");
        out.push(Diagnostic::new(severity, "latex", message).at(TEX_FILE, num));
    }
    out
}

/// TeX wraps log lines at 79 characters; rejoin them before matching warnings.
fn unwrap_log(log: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut continuing = false;
    for line in log.lines() {
        if continuing {
            lines.last_mut().expect("continuation follows a line").push_str(line);
        } else {
            lines.push(line.to_string());
        }
        continuing = line.chars().count() == 79;
    }
    lines
}

fn parse_log_warnings(log: &str) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    for line in unwrap_log(log) {
        let Some(idx) = line.find("Warning: ") else { continue };
        let head = &line[..idx];
        if !(head.ends_with("LaTeX ") || head.starts_with("Package ") || head.starts_with("Class ")) {
            continue;
        }
        let message = line[idx + "Warning: ".len()..].trim();
        if message.starts_with("Rerun")
            || message.contains("may have changed")
            || message.contains("There were undefined")
        {
            continue;
        }
        let mut diagnostic = match message.rsplit_once(" on input line ") {
            Some((m, n)) => match n.trim_end_matches('.').parse() {
                Ok(n) => Diagnostic::new(Severity::Warning, "latex", m).at(TEX_FILE, n),
                Err(_) => Diagnostic::new(Severity::Warning, "latex", message),
            },
            None => Diagnostic::new(Severity::Warning, "latex", message),
        };
        if out.iter().any(|d| d.message == diagnostic.message && d.line == diagnostic.line) {
            continue;
        }
        diagnostic.message = diagnostic.message.trim_end_matches('.').to_string();
        out.push(diagnostic);
    }
    out
}

/// BibTeX errors end in `---line N of file refs.bib`; warnings start with `Warning--`.
fn parse_blg(blg: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in blg.lines() {
        if let Some(message) = line.strip_prefix("Warning--") {
            out.push(Diagnostic::new(Severity::Warning, "bibtex", message.trim()));
        } else if let Some((message, location)) = line.split_once("---line ") {
            let mut parts = location.splitn(2, " of file ");
            let num = parts.next().and_then(|n| n.trim().parse().ok());
            let file = parts.next().map(str::trim).unwrap_or(BIB_FILE);
            let diagnostic = Diagnostic::new(Severity::Error, "bibtex", message.trim());
            out.push(match num {
                Some(n) => diagnostic.at(file, n),
                None => diagnostic,
            });
        } else if line.starts_with("I couldn't open") {
            out.push(Diagnostic::new(Severity::Error, "bibtex", line.trim()));
        }
    }
    out
}

fn last_meaningful_error(output: &str) -> String {
    output
        .lines()
        .filter_map(|l| l.strip_prefix("error: "))
        .find(|l| !l.starts_with("something bad happened") && !l.starts_with("the XeTeX engine"))
        .or_else(|| output.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("LaTeX failed without output")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Author;

    #[test]
    fn metadata_escapes_literal_fields_and_numbers_authors() {
        let meta = PaperMeta {
            authors: vec![
                Author { name: "Ada *L*".into(), affiliation: "Lab #1".into(), email: "a@b.org".into() },
                Author::default(),
                Author { name: "Alan".into(), ..Author::default() },
            ],
            keywords: vec!["x_y".into(), " ".into()],
            language: "es".into(),
            ..PaperMeta::default()
        };
        let doc = pandoc_metadata(&meta, true);
        assert_eq!(doc["author"][0]["name"], "Ada \\*L\\*");
        assert_eq!(doc["author"][0]["affiliation"], "Lab \\#1");
        assert_eq!(doc["author"][0]["email"], "a\\@b.org");
        assert_eq!(doc["author"][1]["n"], "2");
        assert_eq!(doc["author"].as_array().unwrap().len(), 2);
        assert_eq!(doc["keywords"], json!(["x\\_y"]));
        assert_eq!(doc["keywords-label"], "Palabras clave");
        assert_eq!(doc["bibliography"], "refs");
    }

    #[test]
    fn lncs_default_style_turns_textual_citations_numeric() {
        let lncs = PaperMeta { template: "lncs".into(), ..PaperMeta::default() };
        assert_eq!(pandoc_metadata(&lncs, true)["numeric-only-citations"], true);
        let custom = PaperMeta { bib_style: "splncsnat".into(), ..lncs };
        assert!(pandoc_metadata(&custom, true).get("numeric-only-citations").is_none());
        assert_eq!(pandoc_metadata(&custom, true)["biblio-style"], "splncsnat");
    }

    #[test]
    fn metadata_omits_bibliography_without_bib_file() {
        let doc = pandoc_metadata(&PaperMeta::default(), false);
        assert!(doc.get("bibliography").is_none());
    }

    #[test]
    fn parses_tectonic_line_errors() {
        let out = "note: Running TeX ...\nerror: paper.tex:3: Undefined control sequence\n\
                   error: something bad happened inside XeTeX; its output follows:\n";
        let d = parse_tectonic(out);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, Some(3));
        assert_eq!(d[0].file.as_deref(), Some(TEX_FILE));
        assert_eq!(d[0].message, "Undefined control sequence");
    }

    #[test]
    fn parses_wrapped_log_warnings_once() {
        let base = "Package natbib Warning: Citation `' on page 1 undefined on input line 4";
        let first = base.replacen("`'", &format!("`{}'", "k".repeat(79 - base.len())), 1);
        assert_eq!(first.chars().count(), 79);
        let log = format!(
            "{first}\n6.\nLaTeX Warning: Reference `x' on page 1 undefined on input line 9.\n\
             LaTeX Warning: Reference `x' on page 1 undefined on input line 9.\n\
             LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.\n"
        );
        let d = parse_log_warnings(&log);
        assert_eq!(d.len(), 2, "{d:?}");
        assert_eq!(d[0].line, Some(46));
        assert_eq!(d[1].line, Some(9));
    }

    #[test]
    fn parses_bibtex_errors_with_bib_line() {
        let blg = "I was expecting a `,' or a `}'---line 5 of file refs.bib\n :  title = {x\n\
                   Warning--empty journal in shannon1948\n";
        let d = parse_blg(blg);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].severity, Severity::Error);
        assert_eq!(d[0].file.as_deref(), Some("refs.bib"));
        assert_eq!(d[0].line, Some(5));
        assert_eq!(d[1].message, "empty journal in shannon1948");
    }

    fn failed(text: &str) -> RunOutput {
        RunOutput { success: false, text: text.into() }
    }

    #[test]
    fn missing_resources_trigger_online_retry() {
        assert!(needs_network(&failed("error: m.tex:1: ! LaTeX Error: File `tikz.sty' not found."), ""));
        assert!(needs_network(&failed("Package babel Error: Unknown option 'spanish'."), ""));
        let ok = RunOutput { success: true, text: String::new() };
        assert!(needs_network(&ok, "I couldn't open style file elsarticle-num-names.bst\n"));
        assert!(!needs_network(&failed("error: paper.tex:3: Undefined control sequence"), ""));
        assert!(!needs_network(&ok, ""));
    }
}
