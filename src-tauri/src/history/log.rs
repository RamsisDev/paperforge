//! The timeline: versions and autosaves merged by time, with milestone names.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{Commit, Oid, Repository};

use super::{VersionInfo, VersionKind, git_err, repo, resolve_commit, snapshot};
use crate::project;

const TAGS: &str = "refs/tags/";
const TAG_MAX_CHARS: usize = 48;

pub fn list(dir: &Path, include_autosaves: bool, before: Option<&str>, limit: usize) -> Result<Vec<VersionInfo>, String> {
    let repo = repo::open_enabled(dir)?;
    let mut entries: Vec<(i64, Oid)> = Vec::new();
    let mut next = repo::head_commit(&repo);
    while let Some(commit) = next {
        entries.push((commit.time().seconds(), commit.id()));
        next = commit.parent(0).ok();
    }
    if include_autosaves {
        let mut next = repo::autosave_tip(&repo);
        while let Some(commit) = next.filter(|c| kind(c) == VersionKind::Autosave) {
            entries.push((commit.time().seconds(), commit.id()));
            next = commit.parent(0).ok();
        }
    }
    let mut seen = HashSet::new();
    entries.retain(|(_, id)| seen.insert(*id));
    entries.sort_by_key(|(time, _)| std::cmp::Reverse(*time));

    let start = match before {
        None => 0,
        Some(id) => {
            let before = resolve_commit(&repo, id)?;
            match entries.iter().position(|(_, id)| *id == before.id()) {
                Some(at) => at + 1,
                None => entries.iter().position(|(time, _)| *time < before.time().seconds()).unwrap_or(entries.len()),
            }
        }
    };
    let milestones = milestones(&repo);
    entries[start..]
        .iter()
        .take(limit)
        .map(|(_, id)| info_with(&repo, &repo.find_commit(*id).map_err(git_err)?, &milestones))
        .collect()
}

pub fn label(dir: &Path, id: &str, label: Option<&str>) -> Result<VersionInfo, String> {
    let repo = repo::open_enabled(dir)?;
    let commit = resolve_commit(&repo, id)?;
    if kind(&commit) == VersionKind::Autosave {
        return Err("Only versions can be named: restore it and save a version".into());
    }
    match label.and_then(snapshot::one_line) {
        Some(label) => {
            let note = milestones(&repo).remove(&commit.id()).and_then(|m| m.note);
            name_version(&repo, dir, &commit, &label, note.as_deref())?;
        }
        None => remove_names(&repo, commit.id())?,
    }
    info(&repo, &commit)
}

/// Gives `commit` one annotated milestone tag, replacing the tags it had. The tag message is the
/// label, then a blank line and the note.
pub(super) fn name_version(
    repo: &Repository,
    dir: &Path,
    commit: &Commit,
    label: &str,
    note: Option<&str>,
) -> Result<(), String> {
    remove_names(repo, commit.id())?;
    let slug = tag_slug(label);
    let name = (1..)
        .map(|n| if n == 1 { slug.clone() } else { format!("{slug}-{n}") })
        .find(|name| repo.find_reference(&format!("{TAGS}{name}")).is_err())
        .expect("an unused tag name");
    let message = match note {
        Some(note) => format!("{label}\n\n{note}\n"),
        None => format!("{label}\n"),
    };
    let tagger = repo::signature(repo, dir, None)?;
    repo.tag(&name, commit.as_object(), &tagger, &message, false).map_err(git_err)?;
    Ok(())
}

/// Deletes every tag, annotated or not, that points at `id`.
fn remove_names(repo: &Repository, id: Oid) -> Result<(), String> {
    let names: Vec<String> = repo
        .references_glob(&format!("{TAGS}*"))
        .map_err(git_err)?
        .flatten()
        .filter(|r| r.peel_to_commit().is_ok_and(|c| c.id() == id))
        .filter_map(|r| r.name().ok().and_then(|n| n.strip_prefix(TAGS)).map(String::from))
        .collect();
    for name in names {
        repo.tag_delete(&name).map_err(git_err)?;
    }
    Ok(())
}

/// Tag names keep `[a-z0-9-]`; common accents fold to ASCII.
fn tag_slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars().flat_map(char::to_lowercase).map(project::fold_accent) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= TAG_MAX_CHARS {
            break;
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() { "version".into() } else { trimmed.into() }
}

struct Milestone {
    label: String,
    note: Option<String>,
    /// Tagger time; lightweight tags have none and lose to annotated ones.
    time: i64,
}

/// The newest tag on each commit. An annotated tag's label is the first line of its message, the
/// note the rest; a lightweight tag is labeled by its name.
fn milestones(repo: &Repository) -> HashMap<Oid, Milestone> {
    let mut out: HashMap<Oid, Milestone> = HashMap::new();
    let Ok(refs) = repo.references_glob(&format!("{TAGS}*")) else {
        return out;
    };
    for reference in refs.flatten() {
        let (Some(name), Ok(commit)) =
            (reference.name().ok().and_then(|n| n.strip_prefix(TAGS)), reference.peel_to_commit())
        else {
            continue;
        };
        let milestone = match reference.target().and_then(|t| repo.find_tag(t).ok()) {
            Some(tag) => {
                let message = tag.message().ok().flatten().unwrap_or("").trim();
                let (first, rest) = message.split_once('\n').unwrap_or((message, ""));
                let first = first.trim();
                Milestone {
                    label: if first.is_empty() { name.to_string() } else { first.to_string() },
                    note: Some(rest.trim()).filter(|n| !n.is_empty()).map(String::from),
                    time: tag.tagger().map_or(0, |t| t.when().seconds()),
                }
            }
            None => Milestone { label: name.to_string(), note: None, time: i64::MIN },
        };
        if out.get(&commit.id()).is_none_or(|m| milestone.time > m.time) {
            out.insert(commit.id(), milestone);
        }
    }
    out
}

/// Commits without trailers (made outside PaperForge) count as versions.
fn kind(commit: &Commit) -> VersionKind {
    snapshot::trailers(commit.message().unwrap_or("")).kind.unwrap_or(VersionKind::Version)
}

pub(super) fn info(repo: &Repository, commit: &Commit) -> Result<VersionInfo, String> {
    info_with(repo, commit, &milestones(repo))
}

fn info_with(repo: &Repository, commit: &Commit, milestones: &HashMap<Oid, Milestone>) -> Result<VersionInfo, String> {
    let trailers = snapshot::trailers(commit.message().unwrap_or(""));
    let changed_parts = match trailers.changed {
        Some(changed) => changed,
        None => changed_since_parent(repo, commit)?,
    };
    let milestone = milestones.get(&commit.id());
    let id = commit.id().to_string();
    Ok(VersionInfo {
        short_id: id[..7].to_string(),
        id,
        kind: trailers.kind.unwrap_or(VersionKind::Version),
        label: milestone.map(|m| m.label.clone()),
        note: milestone.and_then(|m| m.note.clone()),
        summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
        time: commit.time().seconds(),
        author: commit.author().name().unwrap_or("").to_string(),
        changed_parts,
    })
}

fn changed_since_parent(repo: &Repository, commit: &Commit) -> Result<Vec<String>, String> {
    let tree = commit.tree().map_err(git_err)?;
    let parent = commit.parent(0).ok().map(|p| p.tree()).transpose().map_err(git_err)?;
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None).map_err(git_err)?;
    Ok(diff
        .deltas()
        .filter_map(|d| d.new_file().path().or(d.old_file().path()).and_then(Path::to_str).map(String::from))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::repo::tests::project;
    use crate::history::{autosave, save_version};

    fn edit(dir: &Path, text: &str) {
        project::write_part(dir, "sections/introduction.md", &format!("# Introduction\n\n{text}\n")).unwrap();
    }

    fn ids(list: &[VersionInfo]) -> Vec<&str> {
        list.iter().map(|v| v.id.as_str()).collect()
    }

    #[test]
    fn list_merges_versions_and_autosaves_newest_first_with_paging() {
        let tmp = project();
        let dir = tmp.path();
        let created = list(dir, false, None, 10).unwrap();
        assert_eq!(created.len(), 1);
        let v0 = &created[0];
        edit(dir, "One.");
        let a1 = autosave(dir, None).unwrap().unwrap();
        edit(dir, "Two.");
        let a2 = autosave(dir, None).unwrap().unwrap();
        edit(dir, "Three.");
        let v1 = save_version(dir, None, None, None).unwrap().unwrap();
        edit(dir, "Four.");
        let a3 = autosave(dir, None).unwrap().unwrap();

        let all = list(dir, true, None, 10).unwrap();
        assert_eq!(ids(&all), [&a3.id, &v1.id, &a2.id, &a1.id, &v0.id]);
        assert_eq!(all[4].summary, "Project created");
        assert_eq!(all[4].kind, VersionKind::Version);
        assert!(all[4].changed_parts.contains(&"paper.json".to_string()));
        assert_eq!(ids(&list(dir, false, None, 10).unwrap()), [&v1.id, &v0.id]);

        assert_eq!(ids(&list(dir, true, None, 2).unwrap()), [&a3.id, &v1.id]);
        assert_eq!(ids(&list(dir, true, Some(&v1.id), 2).unwrap()), [&a2.id, &a1.id]);
        assert_eq!(ids(&list(dir, true, Some(&a1.id), 2).unwrap()), [&v0.id]);
        assert!(list(dir, true, Some(&v0.id), 2).unwrap().is_empty());
        // An autosave id while autosaves are hidden pages by its time.
        assert_eq!(ids(&list(dir, false, Some(&a3.id), 5).unwrap()), [&v1.id, &v0.id]);
        assert!(list(dir, true, Some("nope"), 2).is_err());
    }

    #[test]
    fn label_names_renames_and_unnames_versions_only() {
        let tmp = project();
        let dir = tmp.path();
        let v0 = list(dir, false, None, 1).unwrap().remove(0);
        let named = label(dir, &v0.id, Some("Sent to reviewer")).unwrap();
        assert_eq!(named.label.as_deref(), Some("Sent to reviewer"));
        let repo = Repository::open(dir).unwrap();
        assert!(repo.find_reference("refs/tags/sent-to-reviewer").is_ok());

        edit(dir, "Revised.");
        let v1 = save_version(dir, Some("Sent to reviewer"), Some("Second round"), None).unwrap().unwrap();
        assert!(repo.find_reference("refs/tags/sent-to-reviewer-2").is_ok());
        let renamed = label(dir, &v1.id, Some("Accepted")).unwrap();
        assert_eq!((renamed.label.as_deref(), renamed.note.as_deref()), (Some("Accepted"), Some("Second round")));
        assert!(repo.find_reference("refs/tags/sent-to-reviewer-2").is_err());
        assert!(repo.find_reference("refs/tags/accepted").is_ok());

        let unnamed = label(dir, &v0.id, None).unwrap();
        assert_eq!((unnamed.label, unnamed.note), (None, None));
        assert!(repo.find_reference("refs/tags/sent-to-reviewer").is_err());
        assert_eq!(list(dir, false, None, 10).unwrap()[0].label.as_deref(), Some("Accepted"));

        edit(dir, "Unsaved.");
        let a1 = autosave(dir, None).unwrap().unwrap();
        let err = label(dir, &a1.id, Some("Nope")).unwrap_err();
        assert_eq!(err, "Only versions can be named: restore it and save a version");
    }

    #[test]
    fn foreign_tags_and_commits_still_read() {
        let tmp = project();
        let dir = tmp.path();
        let repo = Repository::open(dir).unwrap();
        let head = repo::head_commit(&repo).unwrap();
        repo.tag_lightweight("v1.0", head.as_object(), false).unwrap();
        let sig = git2::Signature::now("Someone", "someone@example.org").unwrap();
        edit(dir, "From the command line.");
        let tree = repo.find_tree(crate::history::worktree_tree(&repo, true).unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Fix a typo", &tree, &[&head]).unwrap();

        let all = list(dir, true, None, 10).unwrap();
        assert_eq!(all[0].summary, "Fix a typo");
        assert_eq!((all[0].kind, all[0].author.as_str()), (VersionKind::Version, "Someone"));
        assert_eq!(all[0].changed_parts, ["sections/introduction.md"]);
        assert_eq!(all[1].label.as_deref(), Some("v1.0"));
    }

    #[test]
    fn tag_slugs_are_ascii() {
        assert_eq!(tag_slug("Envío a revisión #2"), "envio-a-revision-2");
        assert_eq!(tag_slug("日本語"), "version");
    }
}
