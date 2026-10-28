//! Version history of a project, kept in a git repository in the project folder.
//!
//! ```text
//! refs/heads/<branch>               versions: one commit each, parent = the previous version
//! refs/paperforge/autosave/<branch> autosaves: a hidden linear chain, not pushed or cloned
//! refs/tags/<slug>                  named milestones: annotated tags on versions
//! ```
//!
//! Versions write `.git/index`, so `git status` is clean right after one; autosaves build their
//! tree in an in-memory index and leave `.git/index` alone, so the git CLI shows the changes since
//! the last version. Snapshots honor `.gitignore`, and an unchanged tree makes no commit.
//!
//! git2's `Repository` is not `Sync`: every function opens the repository itself. All of them
//! block; async callers run them in `spawn_blocking`, under the project lock of `Backend`.

mod bib;
mod diff;
mod log;
mod repo;
mod restore;
mod snapshot;

use std::path::Path;

use git2::{Commit, IndexAddOption, Oid, Repository};
use serde::Serialize;

use crate::project::{self, ProjectSnapshot};

/// How the project folder relates to a git repository.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoMode {
    /// History enabled by PaperForge.
    Own,
    /// The folder already was a git repository when history was enabled.
    Adopted,
    /// The folder sits inside another repository; history stays off for now.
    ParentRepo,
    /// No repository: history not enabled yet.
    None,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub enabled: bool,
    pub mode: RepoMode,
    /// The checked-out branch, `None` when history is off or HEAD is detached.
    pub branch: Option<String>,
    /// The project differs from the last version.
    pub dirty: bool,
    pub last_version: Option<VersionInfo>,
    /// URL of the `origin` remote.
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VersionKind {
    Autosave,
    Version,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    /// Full commit id.
    pub id: String,
    pub short_id: String,
    pub kind: VersionKind,
    /// Milestone name, from the tag pointing at this version.
    pub label: Option<String>,
    /// The milestone tag's note.
    pub note: Option<String>,
    /// First line of the commit message, e.g. "Edited: Introduction, Method".
    pub summary: String,
    /// Commit time, Unix seconds.
    pub time: i64,
    pub author: String,
    /// Project-relative files that changed since the previous snapshot.
    pub changed_parts: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SegmentKind {
    Equal,
    Insert,
    Delete,
}

/// A run of words (with the whitespace around them) that is unchanged, inserted or deleted.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffSegment {
    pub kind: SegmentKind,
    pub text: String,
}

/// The word-level changes of one Markdown part.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartDiff {
    /// The part's path on the newer side (the older side for a deleted part).
    pub file: String,
    /// The older path of a renamed part.
    pub old_file: Option<String>,
    /// The part's first heading on the newer side (older for a deleted part), else its file name.
    pub title: String,
    pub status: ChangeStatus,
    /// The whole text as segments; the UI folds long unchanged runs.
    pub segments: Vec<DiffSegment>,
}

/// A change of `paper.json` in plain language.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaChange {
    /// The `PaperMeta` field, camelCase as in `paper.json`, e.g. "title" or "parts".
    pub field: String,
    /// e.g. "Title: “A” → “B”", "Part added: Results", "Order of parts changed".
    pub description: String,
}

/// A `refs.bib` entry added, removed or edited, by citation key.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BibChange {
    pub key: String,
    pub status: ChangeStatus,
}

/// Any other changed file: figures, `preamble.tex`, the ejected template, ...
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ChangeStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiff {
    pub from: String,
    /// `None`: the working copy.
    pub to: Option<String>,
    /// Changed parts, in the newer side's document order; parts only on the older side last.
    pub parts: Vec<PartDiff>,
    pub meta: Vec<MetaChange>,
    pub bib: Vec<BibChange>,
    pub files: Vec<FileChange>,
}

pub(crate) fn git_err(e: git2::Error) -> String {
    e.message().to_string()
}

/// The project's own repository; a parent repository higher up does not count.
pub(crate) fn open_repo(dir: &Path) -> Result<Repository, String> {
    Repository::open(dir).map_err(|_| "Version history is not enabled for this project".to_string())
}

/// A snapshot by full or abbreviated commit id, or any revision git understands.
pub(crate) fn resolve_commit<'r>(repo: &'r Repository, id: &str) -> Result<Commit<'r>, String> {
    repo.revparse_single(id)
        .and_then(|o| o.peel_to_commit())
        .map_err(|_| format!("Unknown version '{id}'"))
}

/// The working copy as a tree object, honoring `.gitignore`. `.git/index` is written only with
/// `write_index`; otherwise the changes stay in this `Repository`'s in-memory copy of the index, so
/// open a fresh `Repository` per operation.
pub(crate) fn worktree_tree(repo: &Repository, write_index: bool) -> Result<Oid, String> {
    let mut index = repo.index().map_err(git_err)?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None).map_err(git_err)?;
    index.update_all(["*"], None).map_err(git_err)?;
    if write_index {
        index.write().map_err(git_err)?;
    }
    index.write_tree().map_err(git_err)
}

/// How messages and the UI name a part: its first ATX heading, else its file name.
pub fn part_title(content: &str, file: &str) -> String {
    const MARKERS: [&str; 6] = ["#", "##", "###", "####", "#####", "######"];
    content
        .lines()
        .find_map(|line| MARKERS.iter().find_map(|m| project::atx_heading(line, m)))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| {
            let name = file.rsplit('/').next().unwrap_or(file);
            name.strip_suffix(".md").unwrap_or(name).to_string()
        })
}

/// What `HistoryStatus` reports for a folder; never fails for a folder without a repository.
pub fn status(dir: &Path) -> Result<HistoryStatus, String> {
    repo::status(dir)
}

/// Initializes (or adopts) the repository, writes `.gitignore`/`.gitattributes` and records a
/// first version with `summary`, e.g. "Project created". Enabling twice is a no-op.
pub fn enable(dir: &Path, summary: &str) -> Result<HistoryStatus, String> {
    repo::enable(dir, summary)
}

/// Records the project on the hidden autosave chain. `None` when history is off or nothing changed
/// since the last snapshot. `reason` explains it, e.g. "Before deleting “Method”".
pub fn autosave(dir: &Path, reason: Option<&str>) -> Result<Option<VersionInfo>, String> {
    snapshot::autosave(dir, reason)
}

/// Records a version on the current branch. A `label` also names it with a milestone tag, and
/// names the last version when nothing changed. `reason` replaces the automatic summary, e.g.
/// "PDF exported". `None` when nothing changed and there is nothing to name.
pub fn save_version(
    dir: &Path,
    label: Option<&str>,
    note: Option<&str>,
    reason: Option<&str>,
) -> Result<Option<VersionInfo>, String> {
    snapshot::save_version(dir, label, note, reason)
}

/// Versions (and autosaves when asked) newest first, older than the snapshot `before` if given.
pub fn list(dir: &Path, include_autosaves: bool, before: Option<&str>, limit: usize) -> Result<Vec<VersionInfo>, String> {
    log::list(dir, include_autosaves, before, limit)
}

/// Names a version (`Some`) or removes its name (`None`).
pub fn label(dir: &Path, id: &str, label: Option<&str>) -> Result<VersionInfo, String> {
    log::label(dir, id, label)
}

/// What changed from snapshot `from` to snapshot `to`, or to the working copy when `to` is `None`.
pub fn diff(dir: &Path, from: &str, to: Option<&str>) -> Result<VersionDiff, String> {
    diff::diff(dir, from, to)
}

/// A file's text as of a snapshot.
pub fn read_part(dir: &Path, id: &str, file: &str) -> Result<String, String> {
    restore::read_part(dir, id, file)
}

/// Brings the whole project back to a snapshot: autosave first, then a version after.
pub fn restore(dir: &Path, id: &str) -> Result<ProjectSnapshot, String> {
    restore::restore(dir, id)
}

/// Brings one part back to a snapshot, re-inserting it when it was deleted since.
pub fn restore_part(dir: &Path, id: &str, file: &str) -> Result<ProjectSnapshot, String> {
    restore::restore_part(dir, id, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_are_named_by_their_first_heading() {
        assert_eq!(part_title("Intro text\n\n## Method {#sec:m}\n", "sections/m.md"), "Method");
        assert_eq!(part_title("# Results ##\n", "sections/r.md"), "Results");
        assert_eq!(part_title("no heading\n", "sections/related-work.md"), "related-work");
        assert_eq!(part_title("#hashtag\n", "paper.md"), "paper");
    }

    #[test]
    fn worktree_tree_honors_gitignore_and_leaves_the_index_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let repo = Repository::init(dir).unwrap();
        std::fs::write(dir.join(".gitignore"), ".build/\n*.tmp~\n").unwrap();
        std::fs::create_dir_all(dir.join(".build")).unwrap();
        std::fs::create_dir_all(dir.join("sections")).unwrap();
        std::fs::write(dir.join(".build/paper.pdf"), "PDF").unwrap();
        std::fs::write(dir.join("sections/a.md"), "# A\n").unwrap();
        std::fs::write(dir.join("sections/a.tmp~"), "partial").unwrap();

        let tree = repo.find_tree(worktree_tree(&repo, false).unwrap()).unwrap();
        let mut paths = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                paths.push(format!("{root}{}", entry.name().unwrap()));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        assert_eq!(paths, [".gitignore", "sections/a.md"]);
        assert!(Repository::open(dir).unwrap().index().unwrap().is_empty());

        worktree_tree(&Repository::open(dir).unwrap(), true).unwrap();
        assert_eq!(Repository::open(dir).unwrap().index().unwrap().len(), 2);
    }
}
