//! Markdown parts -> LaTeX fragments (Pandoc + the Lua filter, re-run only for parts that
//! changed) -> a main document that `\input`s or `\include`s them -> PDF (Tectonic).
//!
//! Tectonic runs offline first against the cache seeded at install time; it only goes online
//! when a document asks for a package or BibTeX style the cache does not have.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::markers::{self, BlockMap, Marked};
use crate::project::{self, BIB_FILE, BUILD_DIR, PaperMeta};

/// The default relay redirects to a mirror that is unreachable; this host serves the same bundle.
pub const BUNDLE_URL: &str = "https://data1.fullyjustified.net/tlextras-2022.0r0.tar";
pub const TEMPLATES: [&str; 7] = ["article", "ieee", "acm", "elsevier", "lncs", "report", "book"];
/// Templates whose `#` headings are chapters; each part becomes an `\include`d file.
const CHAPTER_TEMPLATES: [&str; 2] = ["report", "book"];
pub const TEX_FILE: &str = "paper.tex";
const MAIN_STEM: &str = "paper";
const MAIN_MARKDOWN: &str = "main.md";
const META_JSON: &str = "meta.json";
const AUX_FILE: &str = "paper.aux";
const TOC_CACHE: &str = "toc.json";
const FRAGMENT_PREFIX: &str = "part-";
/// Tectonic also runs BibTeX on each `\include`d .aux, leaving a harmless `part-*.blg`.
const FRAGMENT_EXTENSIONS: [&str; 6] = ["tex", "aux", "bbl", "blg", "hash", "pandoc"];
const FRAGMENT_INTERMEDIATES: [&str; 3] = ["aux", "bbl", "blg"];
/// Part of every conversion cache key: bump it when the Pandoc command lines or the Markdown
/// fed to them (block markers) change.
const PANDOC_ARGS_VERSION: &str = "3";

const PANDOC_TIMEOUT: Duration = Duration::from_secs(30);
const TEX_OFFLINE_TIMEOUT: Duration = Duration::from_secs(90);
const TEX_ONLINE_TIMEOUT: Duration = Duration::from_secs(300);
const INTERMEDIATES: [&str; 7] =
    ["paper.aux", "paper.bbl", "paper.blg", "paper.out", "paper.toc", "paper.lof", "paper.lot"];
const TEMPLATE_STAMP: &str = "template.txt";
const TOC_LISTS: [&str; 3] = ["toc", "lof", "lot"];

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
    /// The generated `paper.tex` or `part-*.tex` fragment, or `refs.bib`.
    pub file: Option<String>,
    /// 1-based line in `file`.
    pub line: Option<usize>,
    /// The generated LaTeX line, which the editor uses to find the Markdown line.
    pub source: Option<String>,
    /// The Markdown part a fragment (or a Pandoc message) came from.
    pub part: Option<String>,
    /// 1-based line in `part` that the fragment line came from, by the block markers.
    pub part_line: Option<usize>,
}

impl Diagnostic {
    fn new(severity: Severity, stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            severity,
            stage,
            message: message.into(),
            file: None,
            line: None,
            source: None,
            part: None,
            part_line: None,
        }
    }

    fn at(mut self, file: &str, line: usize) -> Self {
        self.file = Some(file.to_string());
        self.line = Some(line);
        self
    }
}

/// One line of the document's table of contents or list of figures/tables, as LaTeX wrote it to
/// the .aux files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    /// `toc`, `lof` or `lot`.
    pub list: String,
    /// The LaTeX sectioning level (`chapter`, `section`, …) or `figure` / `table`.
    pub level: String,
    pub depth: u8,
    /// Empty for unnumbered entries.
    pub number: String,
    pub title: String,
    /// As LaTeX prints it: `3`, `iv`.
    pub page: String,
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
    /// A preview pass changed labels, citations or a printed list; another pass settles them.
    pub needs_rerun: bool,
    /// Entries of the last successful compile.
    pub toc: Vec<TocEntry>,
    /// Parts Pandoc converted in this compile; unchanged parts reuse their fragment.
    pub converted_parts: usize,
}

impl CompileOutcome {
    pub fn cancelled() -> Self {
        Self { cancelled: true, ..Self::default() }
    }
}

/// A part's generated LaTeX in the build directory.
#[derive(Debug, Clone, PartialEq)]
pub struct Fragment {
    pub part: String,
    /// File stem without extension, e.g. `part-sections-introduction`.
    pub name: String,
}

impl Fragment {
    fn tex_file(&self) -> String {
        format!("{}.tex", self.name)
    }
}

/// Fragments stay flat in the build directory, named `part-<path>` with `[a-z0-9-]` only, since
/// the names end up in `\include` and `\includeonly`.
pub fn fragments(parts: &[String]) -> Vec<Fragment> {
    let mut taken = HashSet::new();
    parts
        .iter()
        .map(|part| {
            let base = fragment_stem(part);
            let name = (1..)
                .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
                .find(|name| taken.insert(name.clone()))
                .expect("an unused name");
            Fragment { part: part.clone(), name }
        })
        .collect()
}

fn fragment_stem(part: &str) -> String {
    let stem = part.strip_suffix(".md").unwrap_or(part);
    let mut cleaned = String::new();
    for c in stem.chars().map(|c| c.to_ascii_lowercase()) {
        if c.is_ascii_alphanumeric() {
            cleaned.push(c);
        } else if !cleaned.is_empty() && !cleaned.ends_with('-') {
            cleaned.push('-');
        }
    }
    let cleaned = cleaned.trim_end_matches('-');
    format!("{FRAGMENT_PREFIX}{}", if cleaned.is_empty() { "x" } else { cleaned })
}

fn uses_chapters(template: &str) -> bool {
    CHAPTER_TEMPLATES.contains(&template)
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
    if numeric_only_citations(meta) {
        doc["numeric-only-citations"] = json!(true);
    }
    if !meta.bib_style.trim().is_empty() {
        doc["biblio-style"] = json!(meta.bib_style.trim());
    }
    for (key, on) in [("toc", meta.toc), ("lof", meta.lof), ("lot", meta.lot)] {
        if on {
            doc[key] = json!(true);
        }
    }
    if meta.toc {
        doc["toc-depth"] = json!(latex_toc_depth(meta));
    }
    doc
}

/// `tocDepth` counts heading levels from `#`, which is a chapter (LaTeX level 0) in chapter
/// templates and a section (level 1) elsewhere.
fn latex_toc_depth(meta: &PaperMeta) -> u8 {
    let levels = meta.toc_depth.clamp(1, 3);
    if uses_chapters(&meta.template) { levels - 1 } else { levels }
}

/// Templates whose default BibTeX style has no author names, so `@key` in running text cannot
/// render as "Author [n]" and becomes a plain "[n]".
const NUMERIC_ONLY_DEFAULT_STYLES: [&str; 1] = ["lncs"];

fn numeric_only_citations(meta: &PaperMeta) -> bool {
    meta.bib_style.trim().is_empty() && NUMERIC_ONLY_DEFAULT_STYLES.contains(&meta.template.as_str())
}

struct RunOutput {
    success: bool,
    text: String,
}

async fn run(mut cmd: Command, timeout: Duration, input: Option<Vec<u8>>) -> Result<RunOutput, String> {
    let stdin = if input.is_some() { Stdio::piped() } else { Stdio::null() };
    cmd.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start {cmd:?}: {e}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // Written alongside reading the output, so a full pipe cannot stall either side.
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&input).await;
        });
    }
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

async fn build_files(build: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(build).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names
}

/// A fragment file name split into stem and extension, when it is one.
fn fragment_file(name: &str) -> Option<(&str, &str)> {
    name.rsplit_once('.')
        .filter(|(stem, ext)| stem.starts_with(FRAGMENT_PREFIX) && FRAGMENT_EXTENSIONS.contains(ext))
}

async fn remove_intermediates(build: &Path) {
    for name in INTERMEDIATES {
        let _ = tokio::fs::remove_file(build.join(name)).await;
    }
    for name in build_files(build).await {
        if fragment_file(&name).is_some_and(|(_, ext)| FRAGMENT_INTERMEDIATES.contains(&ext)) {
            let _ = tokio::fs::remove_file(build.join(name)).await;
        }
    }
}

/// Fragments of deleted or renamed parts would otherwise linger in exports and flattened views.
async fn remove_stale_fragments(build: &Path, fragments: &[Fragment]) {
    for name in build_files(build).await {
        let stale = fragment_file(&name).is_some_and(|(stem, _)| !fragments.iter().any(|f| f.name == stem));
        if stale {
            let _ = tokio::fs::remove_file(build.join(name)).await;
        }
    }
}

/// FNV-1a over length-prefixed fields: stable across Rust releases, unlike `DefaultHasher`.
fn cache_key(fields: &[&[u8]]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for field in fields {
        for byte in (field.len() as u64).to_le_bytes().iter().chain(field.iter()) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// Path, size and mtime of the Pandoc binary, so an app update that ships a new Pandoc
/// reconverts every part.
async fn pandoc_identity(pandoc: &Path) -> String {
    let meta = tokio::fs::metadata(pandoc).await.ok();
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{PANDOC_ARGS_VERSION}|{}|{}|{modified}", pandoc.display(), meta.map_or(0, |m| m.len()))
}

/// Every file Pandoc may read from the templates folder (template, partials, Lua filter).
async fn templates_fingerprint(templates: &Path) -> Vec<u8> {
    let mut names = build_files(templates).await;
    names.sort();
    let mut bytes = Vec::new();
    for name in names {
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend(tokio::fs::read(templates.join(&name)).await.unwrap_or_default());
    }
    bytes
}

/// The stored Pandoc output of a conversion whose inputs hash to `key`.
async fn cached_run(build: &Path, stem: &str, key: &str) -> Option<RunOutput> {
    if read_or_empty(&build.join(format!("{stem}.hash"))).await != key
        || tokio::fs::metadata(build.join(format!("{stem}.tex"))).await.is_err()
    {
        return None;
    }
    let text = read_or_empty(&build.join(format!("{stem}.pandoc"))).await;
    Some(RunOutput { success: true, text })
}

/// Runs Pandoc unless the last successful run had the same inputs. The hash is written last so
/// an interrupted run is never mistaken for a cached one.
async fn run_cached(
    build: &Path,
    stem: &str,
    key: String,
    cmd: Command,
    input: Option<Vec<u8>>,
) -> Result<(RunOutput, bool), String> {
    if let Some(out) = cached_run(build, stem, &key).await {
        return Ok((out, false));
    }
    let hash = build.join(format!("{stem}.hash"));
    let _ = tokio::fs::remove_file(&hash).await;
    let out = run(cmd, PANDOC_TIMEOUT, input).await?;
    if out.success {
        let log = build.join(format!("{stem}.pandoc"));
        tokio::fs::write(&log, &out.text).await.map_err(|e| e.to_string())?;
        tokio::fs::write(&hash, key).await.map_err(|e| e.to_string())?;
    }
    Ok((out, true))
}

fn pandoc_diagnostics(out: &RunOutput, part: Option<&str>) -> Vec<Diagnostic> {
    let mut diagnostics = parse_pandoc(&out.text);
    if !out.success && !diagnostics.iter().any(|d| d.severity == Severity::Error) {
        diagnostics.push(Diagnostic::new(Severity::Error, "pandoc", out.text.trim()));
    }
    for d in &mut diagnostics {
        d.part = part.map(str::to_string);
    }
    diagnostics
}

#[derive(Debug, Clone, Copy)]
struct FragmentOptions {
    chapters: bool,
    numeric_only: bool,
}

struct Conversion {
    ok: bool,
    converted: usize,
    diagnostics: Vec<Diagnostic>,
}

/// Converts the parts whose inputs changed, concurrently, and replays the stored Pandoc
/// messages of the others.
async fn convert_parts(
    tc: &Toolchain,
    dir: &Path,
    build: &Path,
    fragments: &[Fragment],
    options: FragmentOptions,
    pandoc_id: &str,
) -> Result<Conversion, String> {
    let filter = tokio::fs::read(tc.templates.join("paper.lua")).await.map_err(|e| e.to_string())?;
    let flags = [u8::from(options.chapters), u8::from(options.numeric_only)];
    let limit = Arc::new(Semaphore::new(std::thread::available_parallelism().map_or(4, |n| n.get())));
    let mut conversion = Conversion { ok: true, converted: 0, diagnostics: Vec::new() };
    let mut jobs = JoinSet::new();
    let mut marks: Vec<Option<Marked>> = fragments.iter().map(|_| None).collect();
    for (i, fragment) in fragments.iter().enumerate() {
        let content = match tokio::fs::read(dir.join(&fragment.part)).await {
            Ok(content) => content,
            Err(e) => {
                let mut d = Diagnostic::new(Severity::Error, "pandoc", format!("Cannot read {}: {e}", fragment.part));
                d.part = Some(fragment.part.clone());
                conversion.diagnostics.push(d);
                conversion.ok = false;
                continue;
            }
        };
        let key = cache_key(&[pandoc_id.as_bytes(), &filter, &flags, &content]);
        let marked = markers::mark_blocks(&String::from_utf8_lossy(&content));
        let input = marked.text.clone().into_bytes();
        marks[i] = Some(marked);
        let cmd = pandoc_fragment(tc, dir, fragment, options);
        let (build, stem, limit) = (build.to_path_buf(), fragment.name.clone(), limit.clone());
        jobs.spawn(async move {
            let _permit = limit.acquire_owned().await.expect("the semaphore is never closed");
            (i, run_cached(&build, &stem, key, cmd, Some(input)).await)
        });
    }
    let mut outputs: Vec<Option<RunOutput>> = fragments.iter().map(|_| None).collect();
    while let Some(joined) = jobs.join_next().await {
        let (i, result) = joined.map_err(|e| e.to_string())?;
        let (out, ran) = result?;
        conversion.converted += usize::from(ran);
        outputs[i] = Some(out);
    }
    for ((fragment, out), marked) in fragments.iter().zip(outputs).zip(marks) {
        let (Some(out), Some(marked)) = (out, marked) else { continue };
        let out = RunOutput { text: marked.remap_messages(&out.text), ..out };
        conversion.ok &= out.success;
        conversion.diagnostics.extend(pandoc_diagnostics(&out, Some(&fragment.part)));
    }
    Ok(conversion)
}

/// Reads the part, with its block markers, from stdin.
fn pandoc_fragment(tc: &Toolchain, dir: &Path, fragment: &Fragment, options: FragmentOptions) -> Command {
    let mut cmd = Command::new(&tc.pandoc);
    cmd.current_dir(dir)
        .args(["--from", "markdown", "--to", "latex", "--natbib"])
        // Keeps fragment lines aligned with Markdown lines for error mapping.
        .arg("--wrap=preserve")
        .arg(format!("--lua-filter={}", tc.templates.join("paper.lua").display()))
        .arg(format!(
            "--top-level-division={}",
            if options.chapters { "chapter" } else { "section" }
        ));
    if options.chapters {
        // One part is one chapter: the filter turns its later top-level headings into sections.
        cmd.arg("--metadata=file-scoped-headings:true");
    }
    if options.numeric_only {
        cmd.arg("--metadata=numeric-only-citations:true");
    }
    cmd.arg(format!(
        "--output={}",
        Path::new(BUILD_DIR).join(fragment.tex_file()).display()
    ));
    cmd
}

/// The body of the main document: one `\input` (or, for chapters, `\include`) per fragment.
fn main_markdown(fragments: &[Fragment], chapters: bool) -> String {
    let command = if chapters { "include" } else { "input" };
    let mut md = String::from("```{=latex}\n");
    for fragment in fragments {
        md.push_str(&format!("\\{command}{{{}}}\n", fragment.name));
    }
    md.push_str("```\n");
    md
}

/// The fragment a line of the main document pulls in.
pub fn included_fragment(line: &str) -> Option<&str> {
    let line = line.trim();
    ["\\input{", "\\include{"]
        .iter()
        .find_map(|command| line.strip_prefix(command))
        .and_then(|rest| rest.strip_suffix('}'))
        .filter(|name| name.starts_with(FRAGMENT_PREFIX))
}

/// A preview focused on one chapter leaves `\includeonly` in the main document; exports drop it.
pub fn without_includeonly(tex: &str) -> String {
    tex.lines()
        .filter(|l| !l.trim_start().starts_with("\\includeonly{"))
        .flat_map(|l| [l, "\n"])
        .collect()
}

/// The main document with every fragment pasted in place of its `\input` / `\include` line.
pub async fn flatten_tex(build: &Path) -> Result<String, String> {
    let path = build.join(TEX_FILE);
    let main = tokio::fs::read_to_string(&path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = String::with_capacity(main.len());
    for line in main.lines() {
        match included_fragment(line) {
            Some(name) => {
                let path = build.join(format!("{name}.tex"));
                let fragment = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                out.push_str(fragment.trim_end());
            }
            None => out.push_str(line),
        }
        out.push('\n');
    }
    Ok(out)
}

pub async fn compile(
    tc: &Toolchain,
    dir: &Path,
    mode: CompileMode,
    focus: Option<&str>,
) -> Result<CompileOutcome, String> {
    let meta = project::read_meta(dir)?;
    if !TEMPLATES.contains(&meta.template.as_str()) {
        return Err(format!("Unknown template '{}'", meta.template));
    }
    if meta.parts.is_empty() {
        return Err("The document has no parts".into());
    }
    let build = project::build_dir(dir);
    tokio::fs::create_dir_all(&build).await.map_err(|e| e.to_string())?;
    // A class's .aux commands are not defined in another class.
    let stamp = build.join(TEMPLATE_STAMP);
    if read_or_empty(&stamp).await != meta.template {
        remove_intermediates(&build).await;
        tokio::fs::write(&stamp, &meta.template).await.map_err(|e| e.to_string())?;
    }
    let chapters = uses_chapters(&meta.template);
    let fragments = fragments(&meta.parts);
    remove_stale_fragments(&build, &fragments).await;
    let pandoc_id = pandoc_identity(&tc.pandoc).await;

    let mut outcome = CompileOutcome::default();
    let started = Instant::now();
    let options = FragmentOptions { chapters, numeric_only: numeric_only_citations(&meta) };
    let includeonly = focus
        .filter(|_| chapters && mode == CompileMode::Preview)
        .and_then(|focus| fragments.iter().find(|f| f.part == focus))
        .map(|f| f.name.as_str());
    // The main document only names the fragments, so it converts alongside them.
    let (parts, main) = tokio::join!(
        convert_parts(tc, dir, &build, &fragments, options, &pandoc_id),
        convert_main(tc, dir, &build, &meta, &fragments, includeonly, &pandoc_id),
    );
    let (parts, main) = (parts?, main?);
    outcome.converted_parts = parts.converted;
    outcome.diagnostics = parts.diagnostics;
    outcome.diagnostics.extend(pandoc_diagnostics(&main, None));
    let converted = parts.ok && main.success;
    outcome.pandoc_ms = started.elapsed().as_millis();
    if !converted {
        outcome.toc = last_toc(&build).await;
        return Ok(outcome);
    }

    let lists_before = writefile_key(&read_aux_tree(&build).await);
    let started = Instant::now();
    let mut tex_out = run(tectonic(tc, dir, &build, mode, true), TEX_OFFLINE_TIMEOUT, None).await?;
    let mut blg = read_or_empty(&build.join("paper.blg")).await;
    if needs_network(&tex_out, &blg) {
        outcome.used_network = true;
        tex_out = run(tectonic(tc, dir, &build, mode, false), TEX_ONLINE_TIMEOUT, None).await?;
        blg = read_or_empty(&build.join("paper.blg")).await;
    }
    outcome.tex_ms = started.elapsed().as_millis();

    let log = read_or_empty(&build.join("paper.log")).await;
    let mut tex_diagnostics = parse_tectonic(&tex_out.text);
    tex_diagnostics.extend(parse_log_warnings(&log, &fragments));
    if !tex_out.success && !tex_diagnostics.iter().any(|d| d.severity == Severity::Error) {
        tex_diagnostics.push(Diagnostic::new(Severity::Error, "latex", last_meaningful_error(&tex_out.text)));
    }
    locate_tex_lines(&mut tex_diagnostics, dir, &build, &fragments).await;
    outcome.diagnostics.extend(tex_diagnostics);
    outcome.diagnostics.extend(parse_blg(&blg));

    outcome.ok = tex_out.success;
    if tex_out.success {
        outcome.pdf_path = Some(build.join("paper.pdf").to_string_lossy().into_owned());
        let aux = read_aux_tree(&build).await;
        outcome.toc = parse_toc(&aux);
        let toc_json = serde_json::to_vec(&outcome.toc).expect("toc serializes");
        tokio::fs::write(build.join(TOC_CACHE), toc_json).await.map_err(|e| e.to_string())?;
        // LaTeX does not announce a changed table of contents; a printed list reads the .toc of
        // the previous pass.
        let lists_changed =
            (meta.toc || meta.lof || meta.lot) && writefile_key(&aux) != lists_before;
        outcome.needs_rerun = mode == CompileMode::Preview && (log_requests_rerun(&log) || lists_changed);
    } else {
        // A run that stopped mid-document can leave a truncated .aux that breaks the next one.
        remove_intermediates(&build).await;
        outcome.toc = last_toc(&build).await;
    }
    Ok(outcome)
}

async fn convert_main(
    tc: &Toolchain,
    dir: &Path,
    build: &Path,
    meta: &PaperMeta,
    fragments: &[Fragment],
    includeonly: Option<&str>,
    pandoc_id: &str,
) -> Result<RunOutput, String> {
    let has_bib = tokio::fs::metadata(dir.join(BIB_FILE)).await.is_ok_and(|m| m.len() > 0);
    let meta_json = serde_json::to_vec(&pandoc_metadata(meta, has_bib)).expect("json");
    let markdown = main_markdown(fragments, uses_chapters(&meta.template));
    let templates = templates_fingerprint(&tc.templates).await;
    let key = cache_key(&[
        pandoc_id.as_bytes(),
        meta.template.as_bytes(),
        &templates,
        &meta_json,
        markdown.as_bytes(),
        includeonly.unwrap_or_default().as_bytes(),
    ]);
    if let Some(out) = cached_run(build, MAIN_STEM, &key).await {
        return Ok(out);
    }
    tokio::fs::write(build.join(META_JSON), meta_json).await.map_err(|e| e.to_string())?;
    tokio::fs::write(build.join(MAIN_MARKDOWN), markdown).await.map_err(|e| e.to_string())?;
    let cmd = pandoc_main(tc, build, &meta.template, includeonly);
    run_cached(build, MAIN_STEM, key, cmd, None).await.map(|(out, _)| out)
}

fn pandoc_main(tc: &Toolchain, build: &Path, template: &str, includeonly: Option<&str>) -> Command {
    let mut cmd = Command::new(&tc.pandoc);
    cmd.current_dir(build)
        .arg(MAIN_MARKDOWN)
        .args(["--from", "markdown", "--to", "latex", "--standalone", "--natbib"])
        .arg("--wrap=preserve")
        .arg(format!("--template={}", tc.templates.join(format!("{template}.tex")).display()))
        // The filter also applies to the metadata (abstract, title).
        .arg(format!("--lua-filter={}", tc.templates.join("paper.lua").display()))
        .arg(format!("--metadata-file={META_JSON}"))
        .arg(format!("--output={TEX_FILE}"));
    if let Some(name) = includeonly {
        cmd.arg(format!("--variable=includeonly:{name}"));
    }
    cmd
}

fn tectonic(tc: &Toolchain, dir: &Path, build: &Path, mode: CompileMode, offline: bool) -> Command {
    let mut cmd = Command::new(&tc.tectonic);
    cmd.current_dir(dir)
        .env("TECTONIC_CACHE_DIR", &tc.tex_cache)
        .args(["--bundle", BUNDLE_URL, "--keep-logs", "--keep-intermediates", "--synctex"])
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

/// Fills `part`, `part_line` and `source` for diagnostics that point at the main document or a
/// fragment.
async fn locate_tex_lines(diagnostics: &mut [Diagnostic], dir: &Path, build: &Path, fragments: &[Fragment]) {
    // Per generated file: its text and, for fragments, the Markdown of the part.
    let mut files: HashMap<String, (String, Option<String>)> = HashMap::new();
    for d in diagnostics {
        let (Some(file), Some(line)) = (d.file.clone(), d.line) else { continue };
        let fragment = fragments.iter().find(|f| f.tex_file() == file);
        if fragment.is_none() && file != TEX_FILE {
            continue;
        }
        d.part = fragment.map(|f| f.part.clone());
        if !files.contains_key(&file) {
            let text = read_or_empty(&build.join(&file)).await;
            let markdown = match fragment {
                Some(f) => tokio::fs::read_to_string(dir.join(&f.part)).await.ok(),
                None => None,
            };
            files.insert(file.clone(), (text, markdown));
        }
        let (text, markdown) = &files[&file];
        d.source = text.lines().nth(line.saturating_sub(1)).map(|s| s.trim().to_string());
        d.part_line = markdown.as_deref().and_then(|md| BlockMap::new(text, md).markdown_line(line));
    }
}

/// The main .aux with each `\@input{part-x.aux}` (written by `\include`) replaced by that file's
/// lines, i.e. in document order. `\include` cannot nest, so one level is enough.
async fn read_aux_tree(build: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    for line in read_or_empty(&build.join(AUX_FILE)).await.lines() {
        match line.strip_prefix("\\@input{").and_then(|rest| rest.strip_suffix('}')) {
            Some(inner) => {
                let text = read_or_empty(&build.join(inner)).await;
                lines.extend(text.lines().map(str::to_string));
            }
            None => lines.push(line.to_string()),
        }
    }
    lines
}

fn writefile_key(aux: &[String]) -> String {
    let lines: Vec<&[u8]> =
        aux.iter().filter(|l| l.starts_with("\\@writefile")).map(|l| l.as_bytes()).collect();
    cache_key(&lines)
}

async fn last_toc(build: &Path) -> Vec<TocEntry> {
    serde_json::from_str(&read_or_empty(&build.join(TOC_CACHE)).await).unwrap_or_default()
}

fn parse_toc(aux: &[String]) -> Vec<TocEntry> {
    aux.iter().filter_map(|line| parse_writefile(line)).collect()
}

/// `\@writefile{toc}{\contentsline {section}{\numberline {1}Title}{3}{section.1}%}`; hyperref
/// adds the fourth (anchor) argument.
fn parse_writefile(line: &str) -> Option<TocEntry> {
    let rest = line.trim().strip_prefix("\\@writefile{")?;
    let (list, rest) = rest.split_once('}')?;
    if !TOC_LISTS.contains(&list) {
        return None;
    }
    let (body, _) = take_group(rest)?;
    let body = body.trim_start();
    let body = body.strip_prefix("\\protect").unwrap_or(body).trim_start();
    let args = body.strip_prefix("\\contentsline")?;
    let (level, args) = take_group(args)?;
    let (text, args) = take_group(args)?;
    let (page, _) = take_group(args)?;
    let level = level.trim();
    let (number, title) = split_number(level, text);
    Some(TocEntry {
        list: list.to_string(),
        level: level.to_string(),
        depth: level_depth(level),
        number,
        title: plain_text(title),
        page: plain_text(page),
    })
}

/// `\numberline {1.2}Title`; the book class writes parts as `I\hspace {1em}Title` instead.
fn split_number<'a>(level: &str, text: &'a str) -> (String, &'a str) {
    let text = text.trim_start();
    if let Some((number, title)) = text.strip_prefix("\\numberline").and_then(take_group) {
        return (plain_text(number), title);
    }
    if level == "part"
        && let Some((number, rest)) = text.split_once("\\hspace")
    {
        return (plain_text(number), take_group(rest).map_or(rest, |(_, title)| title));
    }
    (String::new(), text)
}

fn level_depth(level: &str) -> u8 {
    match level {
        "part" => 0,
        "section" => 2,
        "subsection" => 3,
        "subsubsection" => 4,
        "paragraph" => 5,
        "subparagraph" => 6,
        _ => 1,
    }
}

/// The contents of the `{…}` group `s` starts with (after spaces), and what follows it.
fn take_group(s: &str) -> Option<(&str, &str)> {
    let body = s.trim_start().strip_prefix('{')?;
    let mut depth = 0usize;
    let mut chars = body.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '{' => depth += 1,
            '}' if depth == 0 => return Some((&body[..i], &body[i + 1..])),
            '}' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// Drops LaTeX commands and braces from a .aux title, keeping escaped characters and the PDF
/// variant of `\texorpdfstring`.
fn plain_text(tex: &str) -> String {
    let mut out = String::new();
    let mut rest = tex;
    while let Some(c) = rest.chars().next() {
        rest = &rest[c.len_utf8()..];
        match c {
            '\\' => {
                let name_len = rest
                    .find(|c: char| !(c.is_ascii_alphabetic() || c == '@'))
                    .unwrap_or(rest.len());
                if name_len == 0 {
                    let Some(symbol) = rest.chars().next() else { break };
                    rest = &rest[symbol.len_utf8()..];
                    if "{}%&#_$".contains(symbol) {
                        out.push(symbol);
                    } else if symbol == ' ' || symbol == '\\' {
                        out.push(' ');
                    }
                    continue;
                }
                let name = &rest[..name_len];
                rest = rest[name_len..].strip_prefix('*').unwrap_or(&rest[name_len..]);
                rest = rest.trim_start_matches(' ');
                match name {
                    "texorpdfstring" => {
                        if let Some((pdf, after)) = take_group(rest).and_then(|(_, r)| take_group(r)) {
                            out.push_str(&plain_text(pdf));
                            rest = after;
                        }
                    }
                    "hspace" | "vspace" | "label" | "addvspace" | "index" => {
                        rest = take_group(rest).map_or(rest, |(_, after)| after);
                    }
                    "nobreakspace" | "quad" | "qquad" | "enspace" | "space" | "newline" => {
                        out.push(' ')
                    }
                    _ => {}
                }
            }
            '{' | '}' | '$' => {}
            '~' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("---", "—")
        .replace("--", "–")
        .replace("``", "“")
        .replace("''", "”")
}

/// An offline run reports a package missing from the cache as a missing file (or, for fonts, an
/// unloadable one), babel reports a missing language as an unknown option, and BibTeX only
/// mentions a missing style in its log.
fn needs_network(tex: &RunOutput, blg: &str) -> bool {
    let out = &tex.text;
    let missing_tex_file = !tex.success
        && (out.contains("not found") && out.contains("File `")
            || out.contains("Package babel Error: Unknown option")
            || out.contains("Metric (TFM) file or installed font not found")
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

/// `error: paper.tex:12: Undefined control sequence`, `warning: part-x.tex:3: ...`.
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
        let name = file.rsplit(['/', '\\']).next().unwrap_or(file);
        // TeX names an `\input{part-x}` file as given, without the extension.
        let name = match name {
            n if n.ends_with(".tex") => n.to_string(),
            n if n.starts_with(FRAGMENT_PREFIX) && !n.contains('.') => format!("{n}.tex"),
            _ => continue,
        };
        let message = message.trim().trim_start_matches("! ");
        out.push(Diagnostic::new(severity, "latex", message).at(&name, num));
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

/// The file TeX is reading after `text`, judged by the last `(name` it opened: a fragment, or the
/// main document again once it opens paper.bbl / paper.aux. Package files opened inside a
/// fragment are ignored.
fn last_opened(text: &str, fragments: &[Fragment]) -> Option<String> {
    text.match_indices('(')
        .filter_map(|(i, _)| {
            let token = text[i + 1..].split([' ', '(', ')']).next()?.trim_start_matches("./");
            // `\input{part-x}` shows up as `(part-x`, `\include` as `(part-x.tex`.
            let stem = token.strip_suffix(".tex").unwrap_or(token);
            if let Some(fragment) = fragments.iter().find(|f| f.name == stem) {
                Some(fragment.tex_file())
            } else {
                [TEX_FILE, AUX_FILE, "paper.bbl"].contains(&token).then(|| TEX_FILE.to_string())
            }
        })
        .next_back()
}

fn parse_log_warnings(log: &str, fragments: &[Fragment]) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut file = TEX_FILE.to_string();
    for line in unwrap_log(log) {
        let Some(idx) = line.find("Warning: ") else {
            file = last_opened(&line, fragments).unwrap_or(file);
            continue;
        };
        let head = &line[..idx];
        file = last_opened(head, fragments).unwrap_or(file);
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
                Ok(n) => Diagnostic::new(Severity::Warning, "latex", m).at(&file, n),
                Err(_) => Diagnostic::new(Severity::Warning, "latex", message),
            },
            None => Diagnostic::new(Severity::Warning, "latex", message),
        };
        diagnostic.message = diagnostic.message.trim_end_matches('.').to_string();
        if out.iter().any(|d| {
            d.message == diagnostic.message && d.line == diagnostic.line && d.file == diagnostic.file
        }) {
            continue;
        }
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
    fn metadata_lists_and_toc_depth_per_division() {
        let doc = pandoc_metadata(&PaperMeta::default(), false);
        for key in ["toc", "lof", "lot", "toc-depth"] {
            assert!(doc.get(key).is_none(), "{key}");
        }
        let article = PaperMeta { toc: true, lot: true, toc_depth: 9, ..PaperMeta::default() };
        let doc = pandoc_metadata(&article, false);
        assert_eq!((doc["toc"].clone(), doc["lot"].clone()), (json!(true), json!(true)));
        assert!(doc.get("lof").is_none());
        assert_eq!(doc["toc-depth"], 3);
        let report = PaperMeta { template: "report".into(), toc_depth: 1, ..article };
        assert_eq!(pandoc_metadata(&report, false)["toc-depth"], 0);
    }

    #[test]
    fn fragment_names_are_flat_latex_safe_and_unique() {
        let parts: Vec<String> =
            ["sections/Intro_1.md", "paper.md", "sections/intro-1.md", "é.md"].map(String::from).into();
        let names: Vec<String> = fragments(&parts).into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["part-sections-intro-1", "part-paper", "part-sections-intro-1-2", "part-x"]);
    }

    #[test]
    fn main_document_inputs_or_includes_fragments() {
        let frags = fragments(&["a.md".into(), "b/c.md".into()]);
        assert_eq!(main_markdown(&frags, false), "```{=latex}\n\\input{part-a}\n\\input{part-b-c}\n```\n");
        let main = main_markdown(&frags, true);
        let included: Vec<_> = main.lines().filter_map(included_fragment).collect();
        assert_eq!(included, ["part-a", "part-b-c"]);
        assert_eq!(included_fragment("\\input{figures/x}"), None);
        assert_eq!(included_fragment("\\includeonly{part-a}"), None);
        assert_eq!(without_includeonly("a\n\\includeonly{part-a}\nb"), "a\nb\n");
    }

    #[test]
    fn parses_toc_entries_with_and_without_hyperref() {
        let aux: Vec<String> = [
            r"\relax",
            r"\@writefile{toc}{\contentsline {chapter}{\numberline {1}Alpha}{3}{chapter.1}\protected@file@percent }",
            r"\@writefile{lof}{\addvspace {10\p@ }}",
            r"\@writefile{toc}{\contentsline {section}{\numberline {1.1}Sub {\em  x} y}{iv}}",
            r"\@writefile{lof}{\contentsline {figure}{\numberline {1.1}{\ignorespaces Cap \texttt  {\{w\}} $H(X)$}}{3}{figure.1.1}%}",
            r"\@writefile{lot}{\contentsline {table}{\numberline {2}{\ignorespaces Results on the test set.}}{5}{table.caption.4}\protected@file@percent }",
            r"\@writefile{toc}{\contentsline {chapter}{Bibliograf\'ia~list}{9}{chapter*.3}%}",
            r"\@writefile{toc}{\contentsline {part}{I\hspace {1em}Theory}{1}{part.1}%}",
            r"\@writefile{toc}{\babel@toc {spanish}{}\relax }",
            r"\@writefile{toc}{\contentsline {subsection}{\numberline {1.1.1}\texorpdfstring {$\alpha $}{alpha} ``tests''}{4}{subsection.1.1.1}%}",
            r"\@writefile{loa}{\contentsline {algorithm}{x}{1}}",
        ]
        .map(String::from)
        .into();
        let toc = parse_toc(&aux);
        fn row(e: &TocEntry) -> (&str, &str, u8, &str, &str, &str) {
            (&e.list, &e.level, e.depth, &e.number, &e.title, &e.page)
        }
        let rows: Vec<_> = toc.iter().map(row).collect();
        assert_eq!(
            rows,
            [
                ("toc", "chapter", 1, "1", "Alpha", "3"),
                ("toc", "section", 2, "1.1", "Sub x y", "iv"),
                ("lof", "figure", 1, "1.1", "Cap {w} H(X)", "3"),
                ("lot", "table", 1, "2", "Results on the test set.", "5"),
                ("toc", "chapter", 1, "", "Bibliografia list", "9"),
                ("toc", "part", 0, "I", "Theory", "1"),
                ("toc", "subsection", 3, "1.1.1", "alpha “tests”", "4"),
            ]
        );
    }

    #[test]
    fn writefile_key_ignores_labels() {
        let a: Vec<String> = [r"\@writefile{toc}{x}", r"\newlabel{a}{{1}{1}}"].map(String::from).into();
        let b: Vec<String> = [r"\@writefile{toc}{x}", r"\newlabel{a}{{1}{2}}"].map(String::from).into();
        let c: Vec<String> = [r"\@writefile{toc}{y}"].map(String::from).into();
        assert_eq!(writefile_key(&a), writefile_key(&b));
        assert_ne!(writefile_key(&a), writefile_key(&c));
    }

    #[test]
    fn parses_tectonic_line_errors() {
        let out = "note: Running TeX ...\nerror: paper.tex:3: Undefined control sequence\n\
                   error: ./part-sections-a.tex:7: Missing $ inserted\n\
                   error: part-sections-b:2: Undefined control sequence\n\
                   error: something bad happened inside XeTeX; its output follows:\n";
        let d = parse_tectonic(out);
        assert_eq!(d.len(), 3);
        assert_eq!(d[2].file.as_deref(), Some("part-sections-b.tex"));
        assert_eq!(d[0].line, Some(3));
        assert_eq!(d[0].file.as_deref(), Some(TEX_FILE));
        assert_eq!(d[0].message, "Undefined control sequence");
        assert_eq!(d[1].file.as_deref(), Some("part-sections-a.tex"));
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
        let d = parse_log_warnings(&log, &[]);
        assert_eq!(d.len(), 2, "{d:?}");
        assert_eq!(d[0].line, Some(46));
        assert_eq!(d[1].line, Some(9));
    }

    #[test]
    fn log_warnings_point_at_the_fragment_being_read() {
        let frags = fragments(&["a.md".into(), "b.md".into()]);
        let log = "LaTeX Warning: Unused global option(s) on input line 2.\n\
                   (./part-a.tex (/tex/t1cmr.fd)\n\
                   LaTeX Warning: Reference `x' on page 1 undefined on input line 3.\n\
                   ) [1] (part-b\n\
                   LaTeX Warning: Reference `x' on page 2 undefined on input line 3.\n\
                   ) (./paper.bbl\n\
                   LaTeX Warning: Something on input line 5.\n";
        let d = parse_log_warnings(log, &frags);
        let files: Vec<_> = d.iter().map(|d| d.file.as_deref().unwrap()).collect();
        assert_eq!(files, [TEX_FILE, "part-a.tex", "part-b.tex", TEX_FILE]);
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
        let font = "error: paper.tex:78: Font TU/lmr/m/sc/10.95=[lmromancaps10-regular]:mapping=tex-text; \
                    at 10.95pt not loadable: Metric (TFM) file or installed font not found";
        assert!(needs_network(&failed(font), ""));
        let ok = RunOutput { success: true, text: String::new() };
        assert!(needs_network(&ok, "I couldn't open style file elsarticle-num-names.bst\n"));
        assert!(!needs_network(&failed("error: paper.tex:3: Undefined control sequence"), ""));
        assert!(!needs_network(&ok, ""));
    }

    fn dev_toolchain() -> Toolchain {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let exe = if cfg!(windows) { ".exe" } else { "" };
        let bin = |name: &str| {
            manifest.join("binaries").join(format!("{name}-{}{exe}", env!("PAPERFORGE_TARGET_TRIPLE")))
        };
        Toolchain {
            pandoc: bin("pandoc"),
            tectonic: bin("tectonic"),
            templates: manifest.join("resources/templates"),
            tex_cache: manifest.join("resources/tex-cache"),
        }
    }

    #[tokio::test]
    async fn unchanged_parts_reuse_their_fragment() {
        let tc = dev_toolchain();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let build = project::build_dir(dir);
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(dir.join("a.md"), "# A\n\nSee @fig:x.\n").unwrap();
        std::fs::write(dir.join("b.md"), "# B\n\n~~gone~~\n").unwrap();
        let frags = fragments(&["a.md".into(), "b.md".into()]);
        let convert = |options| {
            let (tc, frags, build) = (&tc, &frags, &build);
            async move { convert_parts(tc, dir, build, frags, options, "test").await.unwrap() }
        };
        let sections = FragmentOptions { chapters: false, numeric_only: false };

        let first = convert(sections).await;
        assert!(first.ok && first.converted == 2, "{:?}", first.diagnostics);
        let a = std::fs::read_to_string(build.join("part-a.tex")).unwrap();
        assert!(a.contains("\\section{A}") && a.contains("\\ref{fig:x}"), "{a}");
        assert_eq!(convert(sections).await.converted, 0);

        std::fs::write(dir.join("b.md"), "# B\n\nEdited.\n").unwrap();
        assert_eq!(convert(sections).await.converted, 1);
        assert!(std::fs::read_to_string(build.join("part-b.tex")).unwrap().contains("Edited."));

        let chapters = convert(FragmentOptions { chapters: true, numeric_only: false }).await;
        assert_eq!(chapters.converted, 2);
        assert!(std::fs::read_to_string(build.join("part-a.tex")).unwrap().contains("\\chapter{A}"));
    }

    #[tokio::test]
    async fn chapter_parts_turn_later_top_level_headings_into_sections() {
        let tc = dev_toolchain();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let build = project::build_dir(dir);
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(
            dir.join("a.md"),
            "Before.\n\n# Marco Teorico\n\nAlgun texto\n\n# Subtema\n\n## Detalle\n\n\
             ```\n# not a heading\n```\n\n# Anexo {#sec:anexo .unnumbered}\n",
        )
        .unwrap();
        let frags = fragments(&["a.md".into()]);
        let convert = |chapters| {
            let (tc, frags, build) = (&tc, &frags, &build);
            async move {
                let options = FragmentOptions { chapters, numeric_only: false };
                let conversion = convert_parts(tc, dir, build, frags, options, "test").await.unwrap();
                assert!(conversion.ok, "{:?}", conversion.diagnostics);
                std::fs::read_to_string(build.join("part-a.tex")).unwrap()
            }
        };

        let report = convert(true).await;
        for expected in [
            "Before.",
            "\\chapter{Marco Teorico}\\label{marco-teorico}",
            "\\section{Subtema}\\label{subtema}",
            "\\section{Detalle}\\label{detalle}",
            "# not a heading",
            "\\section*{Anexo}\\label{sec:anexo}",
        ] {
            assert!(report.contains(expected), "{expected} in\n{report}");
        }
        assert_eq!(report.matches("\\chapter").count(), 1, "{report}");

        let article = convert(false).await;
        for expected in ["\\section{Marco Teorico}", "\\section{Subtema}", "\\subsection{Detalle}"] {
            assert!(article.contains(expected), "{expected} in\n{article}");
        }
    }

    #[tokio::test]
    async fn pandoc_errors_name_the_part() {
        let tc = dev_toolchain();
        let tmp = tempfile::tempdir().unwrap();
        let build = project::build_dir(tmp.path());
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        let frags = fragments(&["a.md".into(), "missing.md".into()]);
        let options = FragmentOptions { chapters: false, numeric_only: false };
        let result = convert_parts(&tc, tmp.path(), &build, &frags, options, "test").await.unwrap();
        assert!(!result.ok);
        let error = result.diagnostics.iter().find(|d| d.severity == Severity::Error).unwrap();
        assert_eq!(error.part.as_deref(), Some("missing.md"));
    }

    const EVERY_BLOCK: &str = r##"# Introduction {#sec:intro}
Text right after the heading,
on two lines with $x^2$ math.

Second paragraph cites @knuth1984 and @fig:plot.

- tight one
- tight two
  - nested tight

1. loose one

2. loose two

   continuation paragraph

   - nested loose

     nested continuation

3. loose three

Term
:   Definition one

Term two

:   Definition two

> A quote
> on two lines

> Second quote

    indented code

    more indented code

```python
# not a heading

x = 1
```

$$
E = mc^2
$$ {#eq:energy}

::: {.note}
Inside a div.

Still inside.
:::

```{=latex}
\begin{center}

Raw block.
\end{center}
```

\begin{center}
Raw environment.

Second paragraph inside.
\end{center}

| A | B |
|---|---|
| 1 | 2 |

: Pipe caption {#tbl:pipe}

-------------------------
  Name   Value
------- -------
  first  1

  second 2
-------------------------

: Multiline caption {#tbl:multi}

![A plot](figures/plot.png){#fig:plot width=50%}

Table: Caption before {#tbl:before}

  C     D
  ---   ---
  3     4

Table: Caption before an unindented table {#tbl:flush}

E     F
---   ---
5     6

<!-- a comment

over two paragraphs -->

Text with a note.[^n]

[^n]: The note.

    Its second paragraph.

* * *

Last paragraph,
on two lines.
"##;

    async fn fragment_tex(markdown: &str, options: FragmentOptions) -> String {
        let tc = dev_toolchain();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project::build_dir(tmp.path())).unwrap();
        let fragment = Fragment { part: "a.md".into(), name: "part-a".into() };
        let cmd = pandoc_fragment(&tc, tmp.path(), &fragment, options);
        let out = run(cmd, PANDOC_TIMEOUT, Some(markdown.as_bytes().to_vec())).await.unwrap();
        assert!(out.success, "{}", out.text);
        std::fs::read_to_string(project::build_dir(tmp.path()).join("part-a.tex")).unwrap()
    }

    /// The fragment without its `%PF:N` lines and the blank line Pandoc puts after each.
    fn without_markers(tex: &str) -> String {
        let mut out = Vec::new();
        let mut lines = tex.lines();
        while let Some(line) = lines.next() {
            if line.starts_with("%PF:") {
                assert_eq!(lines.next(), Some(""), "a blank line follows {line}");
            } else {
                out.push(line);
            }
        }
        out.join("\n")
    }

    #[tokio::test]
    async fn block_markers_only_add_comment_lines() {
        let marked = markers::mark_blocks(EVERY_BLOCK);
        for chapters in [false, true] {
            let options = FragmentOptions { chapters, numeric_only: false };
            let plain = fragment_tex(EVERY_BLOCK, options).await;
            let with_markers = fragment_tex(&marked.text, options).await;
            assert_eq!(without_markers(&with_markers), plain.trim_end(), "chapters: {chapters}");
            let comments: Vec<usize> = with_markers
                .lines()
                .filter_map(|l| l.strip_prefix("%PF:").and_then(|n| n.parse().ok()))
                .collect();
            assert_eq!(comments, marked.lines);
        }

        let tex = fragment_tex(&marked.text, FragmentOptions { chapters: false, numeric_only: false }).await;
        let map = BlockMap::new(&tex, EVERY_BLOCK);
        let md: Vec<&str> = EVERY_BLOCK.lines().collect();
        let tex_lines: Vec<&str> = tex.lines().collect();
        for wanted in ["on two lines with", "Second paragraph", "loose three", "Last paragraph", "on two lines."] {
            let line = md.iter().position(|l| l.contains(wanted)).unwrap() + 1;
            let (tex_line, _) = map.tex_line(line).unwrap();
            assert!(tex_lines[tex_line - 1].contains(wanted), "{wanted}: {}", tex_lines[tex_line - 1]);
            assert_eq!(map.markdown_line(tex_line), Some(line), "{wanted}");
        }
    }

    #[tokio::test]
    async fn flattened_tex_pastes_fragments() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TEX_FILE), "\\begin{document}\n\\include{part-a}\n\\end{document}\n")
            .unwrap();
        std::fs::write(tmp.path().join("part-a.tex"), "\\chapter{A}\nText.\n\n").unwrap();
        assert_eq!(
            flatten_tex(tmp.path()).await.unwrap(),
            "\\begin{document}\n\\chapter{A}\nText.\n\\end{document}\n"
        );
    }
}
