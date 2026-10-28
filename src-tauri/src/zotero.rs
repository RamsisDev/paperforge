//! An optional link from a project to a bibliography another program keeps exporting, such as a
//! Zotero Better BibTeX "keep updated" export. The link lives in `.paperforge/zotero.json`; the
//! frontend merges the linked file's entries into refs.bib, so the paper never depends on it.

use std::fs;
use std::path::{Path, PathBuf};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::project::{self, META_FILE, SETTINGS_DIR};

pub const LINK_FILE: &str = "zotero.json";
/// Desktop event, with the project folder as payload, when the linked file changes.
pub const CHANGED_EVENT: &str = "zotero-changed";

#[derive(Default, Serialize, Deserialize)]
struct Link {
    path: Option<String>,
}

/// `.paperforge/zotero.json` of a project; links out of the project are refused.
fn link_file(dir: &Path) -> Result<PathBuf, String> {
    if !dir.join(META_FILE).is_file() {
        return Err(format!("{} is not a PaperForge project (no {META_FILE})", dir.display()));
    }
    let settings = dir.join(SETTINGS_DIR);
    let path = settings.join(LINK_FILE);
    for p in [&settings, &path] {
        if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("{} is a link out of the project", p.display()));
        }
    }
    Ok(path)
}

/// The linked `.bib` file, if any.
pub fn linked(dir: &Path) -> Result<Option<String>, String> {
    let path = link_file(dir)?;
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<Link>(&raw).map(|l| l.path).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Links an existing absolute `.bib` file, or unlinks with `None` or an empty path.
pub fn link(dir: &Path, bib: Option<&str>) -> Result<Option<String>, String> {
    let path = link_file(dir)?;
    let Some(bib) = bib.map(str::trim).filter(|b| !b.is_empty()) else {
        match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{}: {e}", path.display())),
            _ => return Ok(None),
        }
    };
    let file = Path::new(bib);
    if !file.is_absolute() {
        return Err(format!("{bib}: the linked bibliography needs an absolute path"));
    }
    if !file.extension().is_some_and(|e| e.eq_ignore_ascii_case("bib")) {
        return Err(format!("{bib} is not a .bib file"));
    }
    if !file.is_file() {
        return Err(format!("{bib} does not exist"));
    }
    fs::create_dir_all(dir.join(SETTINGS_DIR)).map_err(|e| format!("{}: {e}", dir.display()))?;
    let raw = serde_json::to_vec_pretty(&Link { path: Some(bib.to_string()) }).map_err(|e| e.to_string())?;
    project::write_atomic(&path, &raw)?;
    Ok(Some(bib.to_string()))
}

/// The text of the linked `.bib` file, `None` without a link.
pub fn read_linked(dir: &Path) -> Result<Option<String>, String> {
    match linked(dir)? {
        Some(bib) => fs::read_to_string(&bib).map(Some).map_err(|e| format!("{bib}: {e}")),
        None => Ok(None),
    }
}

/// Calls `on_change` whenever `bib` is written or replaced, until the watcher is dropped.
pub fn watch(bib: &Path, on_change: impl Fn() + Send + 'static) -> Result<RecommendedWatcher, String> {
    // Exporters replace the file (temp file + rename), which ends a watch on the file itself.
    let folder = bib.parent().ok_or_else(|| format!("{}: no parent folder", bib.display()))?;
    let name = bib.file_name().ok_or_else(|| format!("{}: not a file", bib.display()))?.to_os_string();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event
            && matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_))
            && event.paths.iter().any(|p| p.file_name() == Some(name.as_os_str()))
        {
            on_change();
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(folder, RecursiveMode::NonRecursive).map_err(|e| format!("{}: {e}", folder.display()))?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn project() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(META_FILE), "{}").unwrap();
        tmp
    }

    #[test]
    fn links_reads_and_unlinks() {
        let dir = project();
        let library = tempfile::tempdir().unwrap();
        let bib = library.path().join("My Library.bib");
        fs::write(&bib, "@book{a, title={A}}\n").unwrap();
        let bib = bib.to_string_lossy().into_owned();

        assert_eq!(linked(dir.path()).unwrap(), None);
        assert_eq!(read_linked(dir.path()).unwrap(), None);
        assert_eq!(link(dir.path(), Some(&bib)).unwrap().as_deref(), Some(bib.as_str()));
        assert_eq!(linked(dir.path()).unwrap().as_deref(), Some(bib.as_str()));
        assert_eq!(read_linked(dir.path()).unwrap().as_deref(), Some("@book{a, title={A}}\n"));
        assert_eq!(link(dir.path(), Some("  ")).unwrap(), None);
        assert!(!dir.path().join(SETTINGS_DIR).join(LINK_FILE).exists());
        assert_eq!(link(dir.path(), None).unwrap(), None);
    }

    #[test]
    fn refuses_bad_links() {
        let dir = project();
        let library = tempfile::tempdir().unwrap();
        let txt = library.path().join("refs.txt");
        fs::write(&txt, "").unwrap();
        for bad in ["relative/refs.bib".to_string(), txt.to_string_lossy().into_owned(), library.path().join("missing.bib").to_string_lossy().into_owned()] {
            assert!(link(dir.path(), Some(&bad)).is_err(), "{bad}");
        }
        let plain = tempfile::tempdir().unwrap();
        assert!(linked(plain.path()).is_err());
    }

    #[test]
    fn reports_changes_to_the_linked_file() {
        let library = tempfile::tempdir().unwrap();
        let bib = library.path().join("zotero.bib");
        fs::write(&bib, "").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _watcher = watch(&bib, move || {
            let _ = tx.send(());
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        fs::write(library.path().join("other.bib"), "x").unwrap();
        let replacement = library.path().join("zotero.bib.tmp");
        fs::write(&replacement, "@misc{b, title={B}}\n").unwrap();
        fs::rename(&replacement, &bib).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(10)).is_ok());
    }
}
