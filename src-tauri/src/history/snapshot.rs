//! Autosaves and versions: trees from the working copy, commit messages and trailers.
//!
//! ```text
//! Edited: Introduction, Method · Added: Results · Title changed
//!
//! PaperForge-Kind: autosave
//! PaperForge-Changed: sections/introduction.md, sections/method.md, paper.json
//! ```

use std::collections::HashSet;
use std::path::Path;

use git2::{Commit, Delta, Oid, Repository, Tree};
use serde_json::{Map, Value};

use super::{VersionInfo, VersionKind, git_err, log, part_title, repo, worktree_tree};
use crate::project;

const KIND_TRAILER: &str = "PaperForge-Kind";
const CHANGED_TRAILER: &str = "PaperForge-Changed";
const AUTOSAVE: &str = "autosave";
const VERSION: &str = "version";
/// Part names listed per kind of change before "+N more".
const MAX_NAMES: usize = 3;

const TITLE: &str = "Title changed";
const SETTINGS: &str = "Paper settings changed";
const ORDER: &str = "Order of parts changed";
const REFERENCES: &str = "References changed";
const FIGURES: &str = "Figures changed";
const PREAMBLE: &str = "Preamble changed";
const TEMPLATE: &str = "Template changed";
const OTHER: &str = "Other files changed";
/// The order of the notes that follow the part lists in a summary.
const NOTES: [&str; 8] = [TITLE, SETTINGS, ORDER, REFERENCES, FIGURES, PREAMBLE, TEMPLATE, OTHER];

pub fn autosave(dir: &Path, reason: Option<&str>) -> Result<Option<VersionInfo>, String> {
    let Ok(repo) = repo::open_enabled(dir) else {
        return Ok(None);
    };
    let tip = repo::autosave_tip(&repo);
    let head = repo::head_commit(&repo);
    let newest = match (&tip, &head) {
        (Some(t), Some(h)) => Some(if t.time().seconds() >= h.time().seconds() { t } else { h }),
        (t, h) => t.as_ref().or(h.as_ref()),
    };
    let tree = worktree_tree(&repo, false)?;
    if newest.is_some_and(|c| c.tree_id() == tree) {
        return Ok(None);
    }
    let parent = tip.as_ref().or(head.as_ref());
    let id = record(&repo, dir, AUTOSAVE, reason, tree, newest, parent)?;
    log::info(&repo, &repo.find_commit(id).map_err(git_err)?).map(Some)
}

pub fn save_version(
    dir: &Path,
    label: Option<&str>,
    note: Option<&str>,
    reason: Option<&str>,
) -> Result<Option<VersionInfo>, String> {
    let repo = repo::open_enabled(dir)?;
    let label = label.and_then(one_line);
    let tree = worktree_tree(&repo, true)?;
    let head = repo::head_commit(&repo);
    let id = match &head {
        Some(h) if h.tree_id() == tree => match label {
            Some(_) => h.id(),
            None => return Ok(None),
        },
        _ => record(&repo, dir, VERSION, reason, tree, head.as_ref(), head.as_ref())?,
    };
    let commit = repo.find_commit(id).map_err(git_err)?;
    if let Some(label) = label {
        let note = note.map(str::trim).filter(|n| !n.is_empty());
        log::name_version(&repo, dir, &commit, &label, note)?;
    }
    log::info(&repo, &commit).map(Some)
}

/// `text` on one line with single spaces; `None` when blank.
pub(super) fn one_line(text: &str) -> Option<String> {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!line.is_empty()).then_some(line)
}

/// Commits `tree` on the autosave chain or the branch, described against `base`, the newest
/// snapshot.
fn record(
    repo: &Repository,
    dir: &Path,
    kind: &str,
    reason: Option<&str>,
    tree: Oid,
    base: Option<&Commit>,
    parent: Option<&Commit>,
) -> Result<Oid, String> {
    let update_ref = if kind == AUTOSAVE { repo::autosave_ref(repo) } else { "HEAD".to_string() };
    let tree = repo.find_tree(tree).map_err(git_err)?;
    let base_tree = base.map(Commit::tree).transpose().map_err(git_err)?;
    let (summary, changed) = describe(repo, base_tree.as_ref(), &tree)?;
    let first_line = reason.and_then(one_line).unwrap_or(summary);
    let message = format!("{first_line}\n\n{KIND_TRAILER}: {kind}\n{CHANGED_TRAILER}: {}\n", changed.join(", "));
    let floor = [repo::head_commit(repo), repo::autosave_tip(repo)].iter().flatten().map(|c| c.time().seconds()).max();
    let signature = repo::signature(repo, dir, floor)?;
    let parents: Vec<&Commit> = parent.into_iter().collect();
    repo.commit(Some(&update_ref), &signature, &signature, &message, &tree, &parents).map_err(git_err)
}

/// What the trailers of a commit message say.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Trailers {
    pub kind: Option<VersionKind>,
    pub changed: Option<Vec<String>>,
}

/// Reads the `PaperForge-*` trailers from the last paragraph (never the subject line).
pub(super) fn trailers(message: &str) -> Trailers {
    let mut out = Trailers::default();
    let Some((_, last)) = message.trim_end().rsplit_once("\n\n") else {
        return out;
    };
    for line in last.lines() {
        match line.split_once(':').map(|(k, v)| (k.trim(), v.trim())) {
            Some((KIND_TRAILER, AUTOSAVE)) => out.kind = Some(VersionKind::Autosave),
            Some((KIND_TRAILER, VERSION)) => out.kind = Some(VersionKind::Version),
            Some((CHANGED_TRAILER, paths)) => {
                out.changed = Some(paths.split(", ").filter(|p| !p.is_empty()).map(String::from).collect())
            }
            _ => {}
        }
    }
    out
}

/// The automatic summary of the changes from `base` to `tree`, and the changed paths.
fn describe(repo: &Repository, base: Option<&Tree>, tree: &Tree) -> Result<(String, Vec<String>), String> {
    let diff = repo.diff_tree_to_tree(base, Some(tree), None).map_err(git_err)?;
    let blob = |id: Oid| repo.find_blob(id).ok().map(|b| b.content().to_vec());
    let parts_of = |t: Option<&Tree>| {
        t.and_then(|t| t.get_path(Path::new(project::META_FILE)).ok())
            .and_then(|e| blob(e.id()))
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .map(|meta| part_list(meta.get("parts")))
            .unwrap_or_default()
    };
    let (old_parts, new_parts) = (parts_of(base), parts_of(Some(tree)));
    let order = |parts: &[String], path: &str| parts.iter().position(|p| p == path).unwrap_or(usize::MAX);

    let (mut edited, mut added, mut deleted) = (Vec::new(), Vec::new(), Vec::new());
    let mut notes = HashSet::new();
    let mut changed = Vec::new();
    for delta in diff.deltas() {
        let Some(path) = delta.new_file().path().or(delta.old_file().path()).and_then(Path::to_str) else {
            continue;
        };
        changed.push(path.to_string());
        let (old, new) = (delta.old_file().id(), delta.new_file().id());
        let text = |id| blob(id).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        if path == project::META_FILE {
            meta_notes(blob(old).as_deref(), blob(new).as_deref(), &mut notes);
        } else if path == project::BIB_FILE {
            notes.insert(REFERENCES);
        } else if path.starts_with(&format!("{}/", project::FIGURES_DIR)) {
            notes.insert(FIGURES);
        } else if path == project::PREAMBLE_FILE {
            notes.insert(PREAMBLE);
        } else if path.starts_with(&format!("{}/", project::TEMPLATE_DIR)) {
            notes.insert(TEMPLATE);
        } else if path.ends_with(".md") {
            match delta.status() {
                Delta::Added => added.push((order(&new_parts, path), part_title(&text(new), path))),
                Delta::Deleted => deleted.push((order(&old_parts, path), part_title(&text(old), path))),
                _ => edited.push((order(&new_parts, path), part_title(&text(new), path))),
            }
        } else {
            notes.insert(OTHER);
        }
    }
    let summary: Vec<String> = [names("Edited", edited), names("Added", added), names("Deleted", deleted)]
        .into_iter()
        .flatten()
        .chain(NOTES.iter().filter(|n| notes.contains(*n)).map(|n| n.to_string()))
        .collect();
    let summary = if summary.is_empty() { OTHER.to_string() } else { summary.join(" · ") };
    Ok((summary, changed))
}

fn part_list(parts: Option<&Value>) -> Vec<String> {
    parts
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

/// "Title changed", "Order of parts changed" or "Paper settings changed". Parts added or deleted
/// are already named by their files.
fn meta_notes(old: Option<&[u8]>, new: Option<&[u8]>, notes: &mut HashSet<&str>) {
    fn parse(raw: Option<&[u8]>) -> Option<Map<String, Value>> {
        match serde_json::from_slice(raw?).ok()? {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }
    let (Some(mut old), Some(mut new)) = (parse(old), parse(new)) else {
        notes.insert(SETTINGS);
        return;
    };
    if old.remove("title") != new.remove("title") {
        notes.insert(TITLE);
    }
    let (old_parts, new_parts) = (part_list(old.remove("parts").as_ref()), part_list(new.remove("parts").as_ref()));
    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };
    if old_parts != new_parts && sorted(old_parts) == sorted(new_parts) {
        notes.insert(ORDER);
    }
    if old != new {
        notes.insert(SETTINGS);
    }
}

/// "Edited: A, B, C +2 more", in document order.
fn names(verb: &str, mut items: Vec<(usize, String)>) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    items.sort_by_key(|(order, _)| *order);
    let shown: Vec<&str> = items.iter().take(MAX_NAMES).map(|(_, title)| title.as_str()).collect();
    let more = items.len().saturating_sub(MAX_NAMES);
    let list = shown.join(", ");
    Some(if more > 0 { format!("{verb}: {list} +{more} more") } else { format!("{verb}: {list}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::repo::tests::project;
    use git2::{Repository, StatusOptions};

    fn write(dir: &Path, file: &str, content: &str) {
        project::write_part(dir, file, content).unwrap();
    }

    #[test]
    fn autosave_moves_neither_the_branch_nor_the_index() {
        let tmp = project();
        let dir = tmp.path();
        let repo = Repository::open(dir).unwrap();
        let head = repo::head_commit(&repo).unwrap().id();
        let index = std::fs::read(dir.join(".git/index")).unwrap();

        write(dir, "sections/introduction.md", "# Introduction\n\nFirst draft.\n");
        let first = autosave(dir, None).unwrap().unwrap();
        assert_eq!(first.kind, VersionKind::Autosave);
        assert_eq!(first.summary, "Edited: Introduction");
        assert_eq!(first.changed_parts, ["sections/introduction.md"]);
        write(dir, "sections/introduction.md", "# Introduction\n\nSecond draft.\n");
        let second = autosave(dir, Some("Before deleting “Method”")).unwrap().unwrap();
        assert_eq!(second.summary, "Before deleting “Method”");

        let repo = Repository::open(dir).unwrap();
        assert_eq!(repo::head_commit(&repo).unwrap().id(), head);
        assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
        let tip = repo.find_reference("refs/paperforge/autosave/main").unwrap().peel_to_commit().unwrap();
        assert_eq!(tip.id().to_string(), second.id);
        assert_eq!(tip.parent(0).unwrap().id().to_string(), first.id);
        assert_eq!(tip.parent(0).unwrap().parent(0).unwrap().id(), head);
        assert!(second.time > first.time);
    }

    #[test]
    fn unchanged_autosave_records_nothing() {
        let tmp = project();
        let dir = tmp.path();
        assert_eq!(autosave(dir, None).unwrap(), None);
        write(dir, "sections/introduction.md", "# Introduction\n\nEdited.\n");
        assert!(autosave(dir, None).unwrap().is_some());
        assert_eq!(autosave(dir, None).unwrap(), None);
        // A version of the same text is the newest snapshot now.
        save_version(dir, None, None, None).unwrap().unwrap();
        assert_eq!(autosave(dir, None).unwrap(), None);

        let plain = tempfile::tempdir().unwrap();
        project::create(plain.path(), None, "article", "", "").unwrap();
        assert_eq!(autosave(plain.path(), None).unwrap(), None);
        Repository::init(plain.path()).unwrap();
        assert_eq!(autosave(plain.path(), None).unwrap(), None);
    }

    #[test]
    fn a_version_leaves_git_status_clean() {
        let tmp = project();
        let dir = tmp.path();
        project::create_part(dir, 1, "Method").unwrap();
        write(dir, "sections/introduction.md", "# Introduction\n\nEdited.\n");
        std::fs::write(dir.join("figures/plot.png"), b"\x89PNG\0data").unwrap();
        let version = save_version(dir, None, None, None).unwrap().unwrap();
        assert_eq!(version.kind, VersionKind::Version);
        assert_eq!(version.summary, "Edited: Introduction · Added: Method · Figures changed");

        let repo = Repository::open(dir).unwrap();
        assert_eq!(repo::head_commit(&repo).unwrap().id().to_string(), version.id);
        let mut options = StatusOptions::new();
        options.include_untracked(true).include_ignored(false);
        assert_eq!(repo.statuses(Some(&mut options)).unwrap().len(), 0);
        assert_eq!(save_version(dir, None, None, None).unwrap(), None);
    }

    #[test]
    fn a_label_on_an_unchanged_tree_names_the_last_version() {
        let tmp = project();
        let dir = tmp.path();
        let repo = Repository::open(dir).unwrap();
        let head = repo::head_commit(&repo).unwrap().id();
        let named = save_version(dir, Some(" Sent to\nreviewer "), Some("For Ana"), None).unwrap().unwrap();
        assert_eq!(named.id, head.to_string());
        assert_eq!(named.label.as_deref(), Some("Sent to reviewer"));
        assert_eq!(named.note.as_deref(), Some("For Ana"));

        let repo = Repository::open(dir).unwrap();
        assert_eq!(repo::head_commit(&repo).unwrap().id(), head);
        let tag = repo.find_reference("refs/tags/sent-to-reviewer").unwrap().peel_to_tag().unwrap();
        assert_eq!(tag.message().unwrap(), Some("Sent to reviewer\n\nFor Ana\n"));
        assert_eq!(tag.target_id(), head);
    }

    #[test]
    fn a_label_with_changes_tags_the_new_version() {
        let tmp = project();
        let dir = tmp.path();
        write(dir, "sections/introduction.md", "# Introduction\n\nDone.\n");
        let version = save_version(dir, Some("Envío a revisión"), None, Some("PDF exported")).unwrap().unwrap();
        assert_eq!(version.summary, "PDF exported");
        assert_eq!((version.label.as_deref(), version.note), (Some("Envío a revisión"), None));
        let repo = Repository::open(dir).unwrap();
        let tagged = repo.find_reference("refs/tags/envio-a-revision").unwrap().peel_to_commit().unwrap();
        assert_eq!(tagged.id().to_string(), version.id);
    }

    #[test]
    fn summaries_name_parts_in_document_order() {
        let tmp = project();
        let dir = tmp.path();
        for (i, title) in ["Method", "Results", "Discussion", "Conclusion"].iter().enumerate() {
            project::create_part(dir, i + 1, title).unwrap();
        }
        save_version(dir, None, None, None).unwrap().unwrap();

        for file in ["conclusion", "results", "introduction", "method", "discussion"] {
            let path = format!("sections/{file}.md");
            let text = std::fs::read_to_string(dir.join(&path)).unwrap();
            write(dir, &path, &format!("{text}More.\n"));
        }
        assert_eq!(
            autosave(dir, None).unwrap().unwrap().summary,
            "Edited: Introduction, Method, Results +2 more"
        );

        project::delete_part(dir, "sections/method.md").unwrap();
        project::create_part(dir, 0, "Abstract").unwrap();
        let mut meta = project::read_meta(dir).unwrap();
        meta.title = "Another title".into();
        project::save(dir, Some(&meta), Some("@misc{a,}\n")).unwrap();
        let info = autosave(dir, None).unwrap().unwrap();
        assert_eq!(info.summary, "Added: Abstract · Deleted: Method · Title changed · References changed");
        assert!(info.changed_parts.contains(&"paper.json".to_string()));

        let mut meta = project::read_meta(dir).unwrap();
        meta.parts.reverse();
        meta.toc = true;
        project::write_meta(dir, &meta).unwrap();
        assert_eq!(autosave(dir, None).unwrap().unwrap().summary, "Paper settings changed · Order of parts changed");
    }

    #[test]
    fn trailers_come_from_the_last_paragraph() {
        assert_eq!(
            trailers("Edited: A\n\nPaperForge-Kind: autosave\nPaperForge-Changed: a.md, paper.json\n"),
            Trailers { kind: Some(VersionKind::Autosave), changed: Some(vec!["a.md".into(), "paper.json".into()]) }
        );
        assert_eq!(trailers("PaperForge-Kind: autosave\n"), Trailers::default());
        assert_eq!(trailers("Fix typo\n\nSigned-off-by: A <a@b>\n"), Trailers::default());
    }
}
