//! A project is a plain folder, so it stays usable outside the app (git, Overleaf, a text editor):
//!
//! ```text
//! paper.json   metadata and template choice
//! paper.md     body in Pandoc Markdown
//! refs.bib     BibTeX references
//! figures/     images referenced from paper.md
//! .build/      generated paper.tex, paper.pdf and logs (safe to delete)
//! ```

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const META_FILE: &str = "paper.json";
pub const BODY_FILE: &str = "paper.md";
pub const BIB_FILE: &str = "refs.bib";
pub const FIGURES_DIR: &str = "figures";
pub const BUILD_DIR: &str = ".build";

const FIGURE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "pdf"];

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
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub dir: String,
    pub meta: PaperMeta,
    pub body: String,
    pub bib: String,
    pub figures: Vec<String>,
}

pub fn read_meta(dir: &Path) -> Result<PaperMeta, String> {
    let path = dir.join(META_FILE);
    let raw = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_optional(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
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

pub fn open(dir: &Path) -> Result<ProjectSnapshot, String> {
    if !dir.join(META_FILE).exists() {
        return Err(format!("{} is not a PaperForge project (no {META_FILE})", dir.display()));
    }
    Ok(ProjectSnapshot {
        dir: dir.to_string_lossy().into_owned(),
        meta: read_meta(dir)?,
        body: read_optional(&dir.join(BODY_FILE))?,
        bib: read_optional(&dir.join(BIB_FILE))?,
        figures: list_figures(dir),
    })
}

/// Creates a project in `dir`, from the bundled sample or as a blank skeleton.
pub fn create(dir: &Path, sample_dir: Option<&Path>) -> Result<ProjectSnapshot, String> {
    if dir.join(META_FILE).exists() {
        return Err(format!("{} already contains a project", dir.display()));
    }
    fs::create_dir_all(dir.join(FIGURES_DIR)).map_err(|e| format!("{}: {e}", dir.display()))?;
    match sample_dir {
        Some(sample) => copy_dir(sample, dir)?,
        None => {
            let meta = serde_json::to_vec_pretty(&PaperMeta::default()).expect("meta serializes");
            write_atomic(&dir.join(META_FILE), &meta)?;
            write_atomic(&dir.join(BODY_FILE), b"# Introduction\n\nStart writing here.\n")?;
            write_atomic(&dir.join(BIB_FILE), b"")?;
        }
    }
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

pub fn save(
    dir: &Path,
    meta: Option<&PaperMeta>,
    body: Option<&str>,
    bib: Option<&str>,
) -> Result<(), String> {
    if let Some(meta) = meta {
        let raw = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
        write_atomic(&dir.join(META_FILE), &raw)?;
    }
    if let Some(body) = body {
        write_atomic(&dir.join(BODY_FILE), body.as_bytes())?;
    }
    if let Some(bib) = bib {
        write_atomic(&dir.join(BIB_FILE), bib.as_bytes())?;
    }
    Ok(())
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

/// Overleaf-ready archive: the generated paper.tex plus the bibliography and figures.
pub fn export_zip(dir: &Path, dest: &Path) -> Result<(), String> {
    let tex = build_dir(dir).join("paper.tex");
    if !tex.exists() {
        return Err("Compile the paper once before exporting the LaTeX sources".into());
    }
    let file = fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, path: &Path| -> Result<(), String> {
        let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())
    };
    add("paper.tex", &tex)?;
    let bib = dir.join(BIB_FILE);
    if bib.exists() {
        add(BIB_FILE, &bib)?;
    }
    for figure in list_figures(dir) {
        add(&figure, &dir.join(&figure))?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_project_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let created = create(tmp.path(), None).unwrap();
        assert_eq!(created.meta, PaperMeta::default());

        let mut meta = created.meta.clone();
        meta.title = "Changed".into();
        save(tmp.path(), Some(&meta), Some("# New"), Some("@misc{a}")).unwrap();

        let reopened = open(tmp.path()).unwrap();
        assert_eq!(reopened.meta.title, "Changed");
        assert_eq!(reopened.body, "# New");
        assert_eq!(reopened.bib, "@misc{a}");
    }

    #[test]
    fn create_refuses_existing_project() {
        let tmp = tempfile::tempdir().unwrap();
        create(tmp.path(), None).unwrap();
        assert!(create(tmp.path(), None).is_err());
    }

    #[test]
    fn import_figure_sanitizes_and_deduplicates_names() {
        let tmp = tempfile::tempdir().unwrap();
        create(tmp.path(), None).unwrap();
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
    }
}
