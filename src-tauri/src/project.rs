//! A project is a plain folder, so it stays usable outside the app (git, Overleaf, a text editor):
//!
//! ```text
//! paper.json   metadata, template choice and the ordered list of Markdown parts
//! sections/    the parts (chapters or sections) in Pandoc Markdown
//! refs.bib     BibTeX references
//! figures/     images referenced from the parts
//! .build/      generated paper.tex, part-*.tex fragments, paper.pdf and logs (safe to delete)
//! ```

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::compiler::{self, TEMPLATES, TEX_FILE};

pub const META_FILE: &str = "paper.json";
/// The single body file of projects created before documents had parts.
pub const LEGACY_BODY_FILE: &str = "paper.md";
pub const SECTIONS_DIR: &str = "sections";
pub const BIB_FILE: &str = "refs.bib";
pub const FIGURES_DIR: &str = "figures";
pub const BUILD_DIR: &str = ".build";

const FIGURE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "pdf"];
const SLUG_MAX_CHARS: usize = 48;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Author {
    pub name: String,
    pub affiliation: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PaperMeta {
    pub template: String,
    pub title: String,
    pub authors: Vec<Author>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub keywords: Vec<String>,
    pub language: String,
    pub date: String,
    pub bib_style: String,
    /// Project-relative Markdown files in document order.
    pub parts: Vec<String>,
    pub toc: bool,
    pub lof: bool,
    pub lot: bool,
    /// Heading levels the printed table of contents shows, 1..=3.
    pub toc_depth: u8,
}

impl Default for PaperMeta {
    fn default() -> Self {
        Self {
            template: "article".into(),
            title: "Untitled Paper".into(),
            authors: vec![Author::default()],
            abstract_text: String::new(),
            keywords: Vec::new(),
            language: "en".into(),
            date: String::new(),
            bib_style: String::new(),
            parts: Vec::new(),
            toc: false,
            lof: false,
            lot: false,
            toc_depth: 2,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub file: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub dir: String,
    pub meta: PaperMeta,
    pub parts: Vec<Part>,
    pub bib: String,
    pub figures: Vec<String>,
}

pub fn read_meta(dir: &Path) -> Result<PaperMeta, String> {
    let path = dir.join(META_FILE);
    let raw = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_meta(dir: &Path, meta: &PaperMeta) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(META_FILE), &raw)
}

fn read_optional(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn remove_optional(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Write via a sibling temp file and rename, so a crash mid-save never truncates the paper.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp~");
    let mut f = fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(contents).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn list_figures(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir.join(FIGURES_DIR)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| is_figure(p))
        .filter_map(|p| p.file_name().map(|n| format!("{FIGURES_DIR}/{}", n.to_string_lossy())))
        .collect();
    names.sort();
    names
}

fn is_figure(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| FIGURE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Parts are `/`-separated Markdown paths below the project folder.
fn check_part_path(file: &str) -> Result<(), String> {
    let path = Path::new(file);
    let inside = !file.contains('\\')
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && path.extension().is_some_and(|e| e == "md");
    if inside { Ok(()) } else { Err(format!("'{file}' is not a Markdown file inside the project")) }
}

fn part_index(meta: &PaperMeta, file: &str) -> Result<usize, String> {
    check_part_path(file)?;
    meta.parts
        .iter()
        .position(|p| p == file)
        .ok_or_else(|| format!("'{file}' is not a part of this document"))
}

fn write_part(dir: &Path, file: &str, content: &str) -> Result<(), String> {
    let path = dir.join(file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    write_atomic(&path, content.as_bytes())
}

/// Drops listed parts that are missing or outside the project; a document left without parts
/// gets its legacy `paper.md` or a fresh introduction. Returns whether `parts` changed.
fn migrate_parts(dir: &Path, meta: &mut PaperMeta) -> Result<bool, String> {
    let before = meta.parts.clone();
    let mut seen = HashSet::new();
    meta.parts.retain(|p| {
        check_part_path(p).is_ok() && dir.join(p).is_file() && seen.insert(p.clone())
    });
    if meta.parts.is_empty() {
        if dir.join(LEGACY_BODY_FILE).is_file() {
            meta.parts.push(LEGACY_BODY_FILE.into());
        } else {
            let file = format!("{SECTIONS_DIR}/introduction.md");
            if !dir.join(&file).is_file() {
                write_part(dir, &file, "# Introduction\n\n")?;
            }
            meta.parts.push(file);
        }
    }
    Ok(meta.parts != before)
}

fn snapshot(dir: &Path, meta: PaperMeta) -> Result<ProjectSnapshot, String> {
    let parts = meta
        .parts
        .iter()
        .map(|file| Ok(Part { file: file.clone(), content: read_optional(&dir.join(file))? }))
        .collect::<Result<_, String>>()?;
    Ok(ProjectSnapshot {
        dir: dir.to_string_lossy().into_owned(),
        meta,
        parts,
        bib: read_optional(&dir.join(BIB_FILE))?,
        figures: list_figures(dir),
    })
}

pub fn open(dir: &Path) -> Result<ProjectSnapshot, String> {
    if !dir.join(META_FILE).exists() {
        return Err(format!("{} is not a PaperForge project (no {META_FILE})", dir.display()));
    }
    let mut meta = read_meta(dir)?;
    if migrate_parts(dir, &mut meta)? {
        write_meta(dir, &meta)?;
    }
    snapshot(dir, meta)
}

/// Creates a project in `dir`, from the bundled sample or as a blank skeleton. An empty `title`
/// or `language` keeps the sample's (or the default) value.
pub fn create(
    dir: &Path,
    sample_dir: Option<&Path>,
    template: &str,
    title: &str,
    language: &str,
) -> Result<ProjectSnapshot, String> {
    if !TEMPLATES.contains(&template) {
        return Err(format!("Unknown template '{template}'"));
    }
    if dir.join(META_FILE).exists() {
        return Err(format!("{} already contains a project", dir.display()));
    }
    fs::create_dir_all(dir.join(FIGURES_DIR)).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut meta = match sample_dir {
        Some(sample) => {
            copy_dir(sample, dir)?;
            read_meta(dir)?
        }
        None => {
            let file = format!("{SECTIONS_DIR}/introduction.md");
            write_part(dir, &file, "# Introduction\n\nStart writing here.\n")?;
            write_atomic(&dir.join(BIB_FILE), b"")?;
            PaperMeta { parts: vec![file], ..PaperMeta::default() }
        }
    };
    meta.template = template.into();
    if !title.trim().is_empty() {
        meta.title = title.trim().into();
    }
    if !language.trim().is_empty() {
        meta.language = language.trim().into();
    }
    write_meta(dir, &meta)?;
    open(dir)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    for entry in fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
    }
    Ok(())
}

/// `parts` is owned by the part commands: a meta saved from a stale editor state must not drop
/// or revive parts.
pub fn save(dir: &Path, meta: Option<&PaperMeta>, bib: Option<&str>) -> Result<(), String> {
    if let Some(meta) = meta {
        let parts = read_meta(dir)?.parts;
        write_meta(dir, &PaperMeta { parts, ..meta.clone() })?;
    }
    if let Some(bib) = bib {
        write_atomic(&dir.join(BIB_FILE), bib.as_bytes())?;
    }
    Ok(())
}

pub fn save_part(dir: &Path, file: &str, content: &str) -> Result<(), String> {
    part_index(&read_meta(dir)?, file)?;
    write_part(dir, file, content)
}

pub fn create_part(dir: &Path, index: usize, title: &str) -> Result<ProjectSnapshot, String> {
    let mut meta = read_meta(dir)?;
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = if title.is_empty() { "Untitled".to_string() } else { title };
    let file = unique_part_file(dir, &meta.parts, &slug(&title));
    write_part(dir, &file, &format!("# {title}\n\n"))?;
    let index = index.min(meta.parts.len());
    meta.parts.insert(index, file);
    write_meta(dir, &meta)?;
    snapshot(dir, meta)
}

pub fn delete_part(dir: &Path, file: &str) -> Result<ProjectSnapshot, String> {
    let mut meta = read_meta(dir)?;
    let index = part_index(&meta, file)?;
    if meta.parts.len() == 1 {
        return Err("A document needs at least one part".into());
    }
    meta.parts.remove(index);
    write_meta(dir, &meta)?;
    remove_optional(&dir.join(file))?;
    snapshot(dir, meta)
}

pub fn reorder_parts(dir: &Path, parts: &[String]) -> Result<ProjectSnapshot, String> {
    let mut meta = read_meta(dir)?;
    let mut current = meta.parts.clone();
    let mut proposed = parts.to_vec();
    current.sort();
    proposed.sort();
    if current != proposed {
        return Err("The new order must list exactly the document's current parts".into());
    }
    meta.parts = parts.to_vec();
    write_meta(dir, &meta)?;
    snapshot(dir, meta)
}

/// Moves every heading of `level` (and the text up to the next one) into its own part, inserted
/// right after `file`.
pub fn split_part(dir: &Path, file: &str, level: u8) -> Result<ProjectSnapshot, String> {
    if !(1..=2).contains(&level) {
        return Err(format!("Cannot split at heading level {level}: use 1 or 2"));
    }
    let mut meta = read_meta(dir)?;
    let index = part_index(&meta, file)?;
    let content = read_optional(&dir.join(file))?;
    let (kept, chunks) = split_markdown(&content, level).ok_or("Nothing to split")?;
    let mut taken = meta.parts.clone();
    let mut created = Vec::new();
    for (heading, text) in chunks {
        let name = unique_part_file(dir, &taken, &slug(&heading));
        write_part(dir, &name, &text)?;
        taken.push(name.clone());
        created.push(name);
    }
    write_part(dir, file, &kept)?;
    meta.parts.splice(index + 1..index + 1, created);
    write_meta(dir, &meta)?;
    snapshot(dir, meta)
}

/// Joins consecutive parts into the first one and deletes the others.
pub fn merge_parts(dir: &Path, files: &[String]) -> Result<ProjectSnapshot, String> {
    if files.len() < 2 {
        return Err("Select at least two parts to merge".into());
    }
    let mut meta = read_meta(dir)?;
    let mut indices = files.iter().map(|f| part_index(&meta, f)).collect::<Result<Vec<_>, _>>()?;
    indices.sort_unstable();
    if indices.windows(2).any(|w| w[1] != w[0] + 1) {
        return Err("Only consecutive parts can be merged".into());
    }
    let texts = indices
        .iter()
        .map(|&i| read_optional(&dir.join(&meta.parts[i])).map(|t| t.trim_end().to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let first = indices[0];
    write_part(dir, &meta.parts[first], &format!("{}\n", texts.join("\n\n")))?;
    let removed: Vec<String> = meta.parts.drain(first + 1..first + indices.len()).collect();
    write_meta(dir, &meta)?;
    for file in removed {
        remove_optional(&dir.join(file))?;
    }
    snapshot(dir, meta)
}

/// Returns what the original part keeps and the `(heading, text)` chunks that become new parts.
fn split_markdown(content: &str, level: u8) -> Option<(String, Vec<(String, String)>)> {
    let headings = heading_offsets(content, level);
    let first = headings.first()?.0;
    let mut chunks: Vec<(String, String)> = headings
        .iter()
        .enumerate()
        .map(|(i, (start, title))| {
            let end = headings.get(i + 1).map_or(content.len(), |h| h.0);
            (title.clone(), chunk_text(&content[*start..end]))
        })
        .collect();
    let leading = &content[..first];
    let kept = if leading.trim().is_empty() { chunks.remove(0).1 } else { chunk_text(leading) };
    (!chunks.is_empty()).then_some((kept, chunks))
}

fn chunk_text(text: &str) -> String {
    format!("{}\n", text.trim_end())
}

/// Byte offset and title of each ATX heading of exactly `level`, skipping fenced code.
fn heading_offsets(content: &str, level: u8) -> Vec<(usize, String)> {
    let marker = "#".repeat(level as usize);
    let mut fence: Option<(char, usize)> = None;
    let mut offset = 0;
    let mut out = Vec::new();
    for line in content.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let text = line.trim_end_matches(['\n', '\r']);
        let unindented = text.trim_start_matches(' ');
        let fenceable = text.len() - unindented.len() <= 3;
        match (fence, fence_run(unindented)) {
            (Some((c, n)), Some((rc, rn, rest)))
                if fenceable && rc == c && rn >= n && rest.trim().is_empty() =>
            {
                fence = None
            }
            (Some(_), _) => {}
            (None, Some((c, n, _))) if fenceable => fence = Some((c, n)),
            (None, _) => {
                if let Some(title) = atx_heading(text, &marker) {
                    out.push((start, title));
                }
            }
        }
    }
    out
}

/// A run of three or more backticks or tildes opening a line, and the rest of the line.
fn fence_run(line: &str) -> Option<(char, usize, &str)> {
    let c = line.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = line.len() - line.trim_start_matches(c).len();
    (n >= 3).then(|| (c, n, &line[n..]))
}

/// The heading text without closing hashes or a trailing `{#id .class}` attribute block.
fn atx_heading(line: &str, marker: &str) -> Option<String> {
    let rest = line.strip_prefix(marker)?;
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let mut title = rest.trim();
    if title.ends_with('}')
        && let Some(open) = title.rfind('{')
    {
        title = title[..open].trim_end();
    }
    Some(title.trim_end_matches('#').trim_end().to_string())
}

fn unique_part_file(dir: &Path, taken: &[String], slug: &str) -> String {
    (1..)
        .map(|n| match n {
            1 => format!("{SECTIONS_DIR}/{slug}.md"),
            n => format!("{SECTIONS_DIR}/{slug}-{n}.md"),
        })
        .find(|f| !dir.join(f).exists() && !taken.iter().any(|t| t.eq_ignore_ascii_case(f)))
        .expect("an unused name")
}

/// File names end up in `\include{…}`, so keep `[a-z0-9-]`; common accents fold to ASCII.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase).map(fold_accent) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= SLUG_MAX_CHARS {
            break;
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() { "section".into() } else { trimmed.into() }
}

fn fold_accent(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        _ => c,
    }
}

/// Copies an image into `figures/` under a unique, LaTeX-safe name and returns its
/// project-relative path.
pub fn import_figure(dir: &Path, source: &Path) -> Result<String, String> {
    if !is_figure(source) {
        return Err(format!(
            "Unsupported figure type {}: use {}",
            source.display(),
            FIGURE_EXTENSIONS.join(", ")
        ));
    }
    let figures = dir.join(FIGURES_DIR);
    fs::create_dir_all(&figures).map_err(|e| e.to_string())?;
    let stem = safe_stem(source);
    let ext = source.extension().unwrap().to_string_lossy().to_ascii_lowercase();
    let mut name = format!("{stem}.{ext}");
    let mut n = 2;
    while figures.join(&name).exists() {
        name = format!("{stem}-{n}.{ext}");
        n += 1;
    }
    fs::copy(source, figures.join(&name)).map_err(|e| format!("{}: {e}", source.display()))?;
    Ok(format!("{FIGURES_DIR}/{name}"))
}

/// Spaces, `#`, `%` and non-ASCII characters break `\includegraphics`, so keep `[a-z0-9-_]`.
fn safe_stem(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() { "figure".into() } else { trimmed.into() }
}

pub fn build_dir(dir: &Path) -> PathBuf {
    dir.join(BUILD_DIR)
}

/// Overleaf-ready archive: the generated paper.tex and its fragments, the bibliography and the
/// figures, all compiling from the archive root.
pub fn export_zip(dir: &Path, dest: &Path) -> Result<(), String> {
    let build = build_dir(dir);
    let tex = fs::read_to_string(build.join(TEX_FILE))
        .map_err(|_| "Compile the paper once before exporting the LaTeX sources".to_string())?;
    let file = fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())
    };
    let read = |path: &Path| fs::read(path).map_err(|e| format!("{}: {e}", path.display()));
    add(TEX_FILE, compiler::without_includeonly(&tex).as_bytes())?;
    for name in tex.lines().filter_map(compiler::included_fragment) {
        let fragment = format!("{name}.tex");
        add(&fragment, &read(&build.join(&fragment))?)?;
    }
    let bib = dir.join(BIB_FILE);
    if bib.exists() {
        add(BIB_FILE, &read(&bib)?)?;
    }
    for figure in list_figures(dir) {
        add(&figure, &read(&dir.join(&figure))?)?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        create(tmp.path(), None, "article", "", "").unwrap();
        tmp
    }

    fn with_parts(parts: &[(&str, &str)]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for (file, content) in parts {
            write_part(tmp.path(), file, content).unwrap();
        }
        let meta = PaperMeta {
            parts: parts.iter().map(|(f, _)| f.to_string()).collect(),
            ..PaperMeta::default()
        };
        write_meta(tmp.path(), &meta).unwrap();
        tmp
    }

    fn files(snapshot: &ProjectSnapshot) -> Vec<&str> {
        snapshot.parts.iter().map(|p| p.file.as_str()).collect()
    }

    fn content<'a>(snapshot: &'a ProjectSnapshot, file: &str) -> &'a str {
        &snapshot.parts.iter().find(|p| p.file == file).unwrap().content
    }

    #[test]
    fn blank_project_round_trips() {
        let tmp = blank();
        let created = open(tmp.path()).unwrap();
        assert_eq!(files(&created), ["sections/introduction.md"]);
        assert_eq!(created.parts[0].content, "# Introduction\n\nStart writing here.\n");

        let mut meta = created.meta.clone();
        meta.title = "Changed".into();
        meta.toc = true;
        save(tmp.path(), Some(&meta), Some("@misc{a}")).unwrap();
        save_part(tmp.path(), "sections/introduction.md", "# New").unwrap();

        let reopened = open(tmp.path()).unwrap();
        assert_eq!(reopened.meta.title, "Changed");
        assert!(reopened.meta.toc);
        assert_eq!(reopened.parts[0].content, "# New");
        assert_eq!(reopened.bib, "@misc{a}");
    }

    #[test]
    fn create_applies_template_title_and_language() {
        let tmp = tempfile::tempdir().unwrap();
        let snapshot = create(tmp.path(), None, "report", "My Thesis", "es").unwrap();
        assert_eq!(snapshot.meta.template, "report");
        assert_eq!(snapshot.meta.title, "My Thesis");
        assert_eq!(snapshot.meta.language, "es");
        assert!(create(tempfile::tempdir().unwrap().path(), None, "nope", "", "").is_err());
    }

    #[test]
    fn create_refuses_existing_project() {
        let tmp = blank();
        assert!(create(tmp.path(), None, "article", "", "").is_err());
    }

    #[test]
    fn save_keeps_the_parts_on_disk() {
        let tmp = with_parts(&[("a.md", "A"), ("b.md", "B")]);
        let stale = PaperMeta { parts: vec!["a.md".into()], ..PaperMeta::default() };
        save(tmp.path(), Some(&stale), None).unwrap();
        assert_eq!(read_meta(tmp.path()).unwrap().parts, ["a.md", "b.md"]);
    }

    #[test]
    fn open_migrates_a_legacy_body() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(META_FILE), r#"{"title":"Old"}"#).unwrap();
        fs::write(tmp.path().join(LEGACY_BODY_FILE), "# Old body\n").unwrap();
        let snapshot = open(tmp.path()).unwrap();
        assert_eq!(files(&snapshot), [LEGACY_BODY_FILE]);
        assert_eq!(snapshot.parts[0].content, "# Old body\n");
        assert_eq!(read_meta(tmp.path()).unwrap().parts, [LEGACY_BODY_FILE]);
    }

    #[test]
    fn open_creates_an_introduction_without_any_body() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(META_FILE), "{}").unwrap();
        let snapshot = open(tmp.path()).unwrap();
        assert_eq!(files(&snapshot), ["sections/introduction.md"]);
        assert_eq!(snapshot.parts[0].content, "# Introduction\n\n");
        assert_eq!(read_meta(tmp.path()).unwrap().parts, ["sections/introduction.md"]);
    }

    #[test]
    fn open_drops_missing_and_escaping_parts() {
        let tmp = with_parts(&[("sections/a.md", "A")]);
        let mut meta = read_meta(tmp.path()).unwrap();
        meta.parts = vec!["sections/a.md".into(), "gone.md".into(), "../x.md".into()];
        write_meta(tmp.path(), &meta).unwrap();
        let snapshot = open(tmp.path()).unwrap();
        assert_eq!(files(&snapshot), ["sections/a.md"]);
        assert_eq!(read_meta(tmp.path()).unwrap().parts, ["sections/a.md"]);
    }

    #[test]
    fn part_save_rejects_unlisted_and_escaping_paths() {
        let tmp = with_parts(&[("sections/a.md", "A")]);
        assert!(save_part(tmp.path(), "sections/b.md", "x").is_err());
        let mut meta = read_meta(tmp.path()).unwrap();
        meta.parts.extend(["../evil.md".into(), "sections/../../evil.md".into(), "/tmp/e.md".into()]);
        write_meta(tmp.path(), &meta).unwrap();
        for file in ["../evil.md", "sections/../../evil.md", "/tmp/e.md"] {
            assert!(save_part(tmp.path(), file, "x").is_err(), "{file}");
        }
        assert!(!tmp.path().parent().unwrap().join("evil.md").exists());
    }

    #[test]
    fn part_create_inserts_unique_slugged_files() {
        let tmp = blank();
        let s = create_part(tmp.path(), 0, "Related Work: Más #1").unwrap();
        assert_eq!(files(&s), ["sections/related-work-mas-1.md", "sections/introduction.md"]);
        assert_eq!(content(&s, "sections/related-work-mas-1.md"), "# Related Work: Más #1\n\n");
        let s = create_part(tmp.path(), 99, "Introduction").unwrap();
        assert_eq!(files(&s)[2], "sections/introduction-2.md");
    }

    #[test]
    fn part_delete_refuses_the_last_part() {
        let tmp = with_parts(&[("a.md", "A"), ("b.md", "B")]);
        let s = delete_part(tmp.path(), "a.md").unwrap();
        assert_eq!(files(&s), ["b.md"]);
        assert!(!tmp.path().join("a.md").exists());
        assert!(delete_part(tmp.path(), "b.md").is_err());
        assert!(delete_part(tmp.path(), "a.md").is_err());
    }

    #[test]
    fn parts_reorder_requires_a_permutation() {
        let tmp = with_parts(&[("a.md", "A"), ("b.md", "B")]);
        let s = reorder_parts(tmp.path(), &["b.md".into(), "a.md".into()]).unwrap();
        assert_eq!(files(&s), ["b.md", "a.md"]);
        assert!(reorder_parts(tmp.path(), &["a.md".into()]).is_err());
        assert!(reorder_parts(tmp.path(), &["a.md".into(), "a.md".into()]).is_err());
        assert!(reorder_parts(tmp.path(), &["a.md".into(), "c.md".into()]).is_err());
    }

    #[test]
    fn split_at_chapters_ignores_fences_and_attributes() {
        let text = "# Intro {#sec:intro}\n\nHello.\n\n```bash\n# not a heading\n```\n\n\
                    ## Sub\n\n# Method ##\n\nM.\n\n~~~~\n# also code\n~~~~\n# Intro\n\nAgain.\n";
        let tmp = with_parts(&[("sections/intro.md", text), ("end.md", "End")]);
        let s = split_part(tmp.path(), "sections/intro.md", 1).unwrap();
        assert_eq!(
            files(&s),
            ["sections/intro.md", "sections/method.md", "sections/intro-2.md", "end.md"]
        );
        assert_eq!(
            content(&s, "sections/intro.md"),
            "# Intro {#sec:intro}\n\nHello.\n\n```bash\n# not a heading\n```\n\n## Sub\n"
        );
        assert_eq!(content(&s, "sections/method.md"), "# Method ##\n\nM.\n\n~~~~\n# also code\n~~~~\n");
        assert_eq!(content(&s, "sections/intro-2.md"), "# Intro\n\nAgain.\n");
    }

    #[test]
    fn split_at_sections_keeps_leading_text() {
        let text = "# Chapter\n\nLead.\n\n## First\n\nA.\n\n### Deep\n\n## Second\n\nB.\n";
        let tmp = with_parts(&[("ch.md", text)]);
        let s = split_part(tmp.path(), "ch.md", 2).unwrap();
        assert_eq!(files(&s), ["ch.md", "sections/first.md", "sections/second.md"]);
        assert_eq!(content(&s, "ch.md"), "# Chapter\n\nLead.\n");
        assert_eq!(content(&s, "sections/first.md"), "## First\n\nA.\n\n### Deep\n");
        assert_eq!(content(&s, "sections/second.md"), "## Second\n\nB.\n");
    }

    #[test]
    fn split_needs_two_chunks() {
        let tmp = with_parts(&[("a.md", "\n# Only\n\nText\n"), ("b.md", "No headings\n")]);
        assert_eq!(split_part(tmp.path(), "a.md", 1).unwrap_err(), "Nothing to split");
        assert_eq!(split_part(tmp.path(), "b.md", 1).unwrap_err(), "Nothing to split");
        assert!(split_part(tmp.path(), "a.md", 3).is_err());
    }

    #[test]
    fn merge_joins_consecutive_parts() {
        let tmp = with_parts(&[("a.md", "A\n\n\n"), ("b.md", "B"), ("c.md", "C\n"), ("d.md", "D")]);
        assert_eq!(
            merge_parts(tmp.path(), &["a.md".into(), "c.md".into()]).unwrap_err(),
            "Only consecutive parts can be merged"
        );
        assert!(merge_parts(tmp.path(), &["a.md".into()]).is_err());
        let s = merge_parts(tmp.path(), &["c.md".into(), "a.md".into(), "b.md".into()]).unwrap();
        assert_eq!(files(&s), ["a.md", "d.md"]);
        assert_eq!(content(&s, "a.md"), "A\n\nB\n\nC\n");
        assert!(!tmp.path().join("b.md").exists() && !tmp.path().join("c.md").exists());
    }

    #[test]
    fn import_figure_sanitizes_and_deduplicates_names() {
        let tmp = blank();
        let src = tmp.path().join("My Plot #1 (final).PNG");
        fs::write(&src, b"png").unwrap();

        assert_eq!(import_figure(tmp.path(), &src).unwrap(), "figures/my-plot--1--final.png");
        assert_eq!(import_figure(tmp.path(), &src).unwrap(), "figures/my-plot--1--final-2.png");
        assert_eq!(list_figures(tmp.path()).len(), 2);
    }

    #[test]
    fn import_figure_rejects_unsupported_types() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("diagram.svg");
        fs::write(&src, b"<svg/>").unwrap();
        assert!(import_figure(tmp.path(), &src).is_err());
    }

    #[test]
    fn meta_reads_partial_json_with_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(META_FILE), r#"{"title":"Only title"}"#).unwrap();
        let meta = read_meta(tmp.path()).unwrap();
        assert_eq!(meta.title, "Only title");
        assert_eq!(meta.template, "article");
        assert_eq!(meta.toc_depth, 2);
        assert!(meta.parts.is_empty() && !meta.toc);
    }
}
