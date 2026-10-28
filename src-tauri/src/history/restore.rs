//! Reading files of a snapshot and bringing the project (or one part) back to it.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{FileMode, ObjectType, Repository, Tree, TreeWalkMode, TreeWalkResult};

use super::{git_err, open_repo, part_title, repo, resolve_commit, snapshot, worktree_tree};
use crate::project::{self, META_FILE, PaperMeta, ProjectSnapshot};

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

pub fn read_part(dir: &Path, id: &str, file: &str) -> Result<String, String> {
    let repo = open_repo(dir)?;
    let tree = resolve_commit(&repo, id)?.tree().map_err(git_err)?;
    text_at(&repo, &tree, file)
}

pub fn restore(dir: &Path, id: &str) -> Result<ProjectSnapshot, String> {
    let (files, when) = {
        let repo = repo::open_enabled(dir)?;
        let target = resolve_commit(&repo, id)?;
        let files = files_of(&repo, &target.tree().map_err(git_err)?)?;
        (files, when(target.time()))
    };
    if !files.iter().any(|(path, _)| path == META_FILE) {
        return Err(format!("That version has no {META_FILE} and cannot be restored"));
    }
    snapshot::autosave(dir, Some(&format!("Before restoring the version of {when}")))?;
    let current = {
        let repo = open_repo(dir)?;
        let tree = repo.find_tree(worktree_tree(&repo, false)?).map_err(git_err)?;
        blob_paths(&tree)?
    };
    for (path, content) in files.iter().filter(|(path, _)| path != META_FILE) {
        write_file(dir, path, content)?;
    }
    let restored: HashSet<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
    for path in current.iter().filter(|p| !restored.contains(p.as_str()) && inside(dir, p)) {
        project::remove_optional(&dir.join(path))?;
    }
    let meta = &files.iter().find(|(path, _)| path == META_FILE).expect("checked above").1;
    write_file(dir, META_FILE, meta)?;
    let opened = project::open(dir)?;
    snapshot::save_version(dir, None, None, Some(&format!("Restored the version of {when}")))?;
    Ok(opened)
}

pub fn restore_part(dir: &Path, id: &str, file: &str) -> Result<ProjectSnapshot, String> {
    project::check_part_path(file)?;
    let (content, target_parts, when) = {
        let repo = repo::open_enabled(dir)?;
        let target = resolve_commit(&repo, id)?;
        let tree = target.tree().map_err(git_err)?;
        let parts = text_at(&repo, &tree, META_FILE)
            .ok()
            .and_then(|raw| serde_json::from_str::<PaperMeta>(&raw).ok())
            .map(|meta| meta.parts)
            .unwrap_or_default();
        (text_at(&repo, &tree, file)?, parts, when(target.time()))
    };
    if !inside(dir, file) {
        return Err(format!("'{file}' is not a path inside the project"));
    }
    let title = part_title(&content, file);
    snapshot::autosave(dir, Some(&format!("Before restoring “{title}” from the version of {when}")))?;
    project::write_part(dir, file, &content)?;
    let mut meta = project::read_meta(dir)?;
    if !meta.parts.iter().any(|p| p == file) {
        let at = insertion_index(&meta.parts, &target_parts, file);
        meta.parts.insert(at, file.to_string());
        project::write_meta(dir, &meta)?;
    }
    let opened = project::open(dir)?;
    snapshot::save_version(dir, None, None, Some(&format!("Restored “{title}” from the version of {when}")))?;
    Ok(opened)
}

/// Right after the nearest part that precedes `file` in the restored version and still exists;
/// first when there is none.
fn insertion_index(current: &[String], target: &[String], file: &str) -> usize {
    target
        .iter()
        .position(|p| p == file)
        .and_then(|at| target[..at].iter().rev().find_map(|p| current.iter().position(|c| c == p)))
        .map_or(0, |i| i + 1)
}

/// The text of `file` in `tree`; binary files and paths outside the project are refused.
fn text_at(repo: &Repository, tree: &Tree, file: &str) -> Result<String, String> {
    if !relative(file) {
        return Err(format!("'{file}' is not a path inside the project"));
    }
    let blob = tree
        .get_path(Path::new(file))
        .ok()
        .filter(|e| e.kind() == Some(ObjectType::Blob))
        .and_then(|e| repo.find_blob(e.id()).ok())
        .ok_or_else(|| format!("'{file}' is not in that version"))?;
    if blob.is_binary() {
        return Err(format!("'{file}' is not a text file"));
    }
    String::from_utf8(blob.content().to_vec()).map_err(|_| format!("'{file}' is not a text file"))
}

/// Plain `/`-separated names below the project, never into `.git`.
fn relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(name) if !name.eq_ignore_ascii_case(".git")))
}

/// `rel` is a relative path with no link on the way, which could point out of the project.
fn inside(dir: &Path, rel: &str) -> bool {
    if !relative(rel) {
        return false;
    }
    let mut at = dir.to_path_buf();
    Path::new(rel).parent().into_iter().flat_map(Path::components).all(|c| {
        at.push(c);
        !fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink())
    })
}

/// Every regular file of `tree` with its content; links and submodules are left out.
fn files_of(repo: &Repository, tree: &Tree) -> Result<Vec<(String, Vec<u8>)>, String> {
    let regular = [i32::from(FileMode::Blob), i32::from(FileMode::BlobExecutable)];
    let mut ids = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if let Some(name) = entry.name().ok().filter(|_| regular.contains(&entry.filemode())) {
            ids.push((format!("{root}{name}"), entry.id()));
        }
        TreeWalkResult::Ok
    })
    .map_err(git_err)?;
    ids.into_iter()
        .filter(|(path, _)| relative(path))
        .map(|(path, id)| Ok((path, repo.find_blob(id).map_err(git_err)?.content().to_vec())))
        .collect()
}

fn blob_paths(tree: &Tree) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if let (Some(ObjectType::Blob), Some(name)) = (entry.kind(), entry.name().ok()) {
            paths.push(format!("{root}{name}"));
        }
        TreeWalkResult::Ok
    })
    .map_err(git_err)?;
    Ok(paths)
}

/// Parts go through `write_part`; a file that already has the content is left untouched.
fn write_file(dir: &Path, path: &str, content: &[u8]) -> Result<(), String> {
    if !inside(dir, path) {
        return Err(format!("'{path}' is not a path inside the project"));
    }
    let target = dir.join(path);
    if fs::read(&target).is_ok_and(|current| current == content) {
        return Ok(());
    }
    match std::str::from_utf8(content) {
        Ok(text) if project::check_part_path(path).is_ok() => project::write_part(dir, path, text),
        _ => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            project::write_atomic(&target, content)
        }
    }
}

/// "28 Oct 10:02" in the snapshot's own time zone, with the year when it is not this year.
fn when(time: git2::Time) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    when_at(time, now)
}

fn when_at(time: git2::Time, now: i64) -> String {
    let offset = i64::from(time.offset_minutes()) * 60;
    let local = time.seconds() + offset;
    let (year, month, day) = civil(local.div_euclid(86_400));
    let minutes = local.rem_euclid(86_400) / 60;
    let date = format!("{day} {}", MONTHS[month as usize - 1]);
    let date = if civil((now + offset).div_euclid(86_400)).0 == year { date } else { format!("{date} {year}") };
    format!("{date} {:02}:{:02}", minutes / 60, minutes % 60)
}

/// Year, month and day of a count of days since 1970-01-01 (proleptic Gregorian calendar).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::repo::tests::project;
    use crate::history::{list, save_version};
    use git2::{StatusOptions, Time};

    fn parts(snapshot: &ProjectSnapshot) -> Vec<&str> {
        snapshot.parts.iter().map(|p| p.file.as_str()).collect()
    }

    fn set_title(dir: &Path, title: &str) {
        let mut meta = project::read_meta(dir).unwrap();
        meta.title = title.into();
        project::save(dir, Some(&meta), None).unwrap();
    }

    #[test]
    fn when_shows_the_year_only_for_other_years() {
        let now = 1_793_199_720;
        assert_eq!(when_at(Time::new(1_793_199_720, -300), now), "28 Oct 10:02");
        assert_eq!(when_at(Time::new(1_741_162_020, 60), now), "5 Mar 2025 09:07");
        assert_eq!(when_at(Time::new(1_798_759_800, 0), now), "31 Dec 23:30");
        assert_eq!(when_at(Time::new(1_798_759_800, 60), now), "1 Jan 2027 00:30");
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(-1), (1969, 12, 31));
        assert_eq!(civil(11_016), (2000, 2, 29));
    }

    #[test]
    fn read_part_returns_text_and_refuses_binaries_and_escapes() {
        let tmp = project();
        let dir = tmp.path();
        std::fs::write(dir.join("figures/plot.png"), b"\x89PNG\0\0data").unwrap();
        let v = save_version(dir, None, None, None).unwrap().unwrap();
        project::write_part(dir, "sections/introduction.md", "# Changed\n").unwrap();

        let text = read_part(dir, &v.id, "sections/introduction.md").unwrap();
        assert_eq!(text, "# Introduction\n\nStart writing here.\n");
        assert_eq!(read_part(dir, &v.short_id, "refs.bib").unwrap(), "");
        assert!(read_part(dir, &v.id, "figures/plot.png").unwrap_err().contains("not a text file"));
        assert!(read_part(dir, &v.id, "sections/missing.md").unwrap_err().contains("not in that version"));
        for bad in ["../paper.json", "/etc/passwd", ".git/config", "sections\\introduction.md", ""] {
            assert!(read_part(dir, &v.id, bad).is_err(), "{bad:?}");
        }
        assert!(read_part(dir, "nope", "paper.json").is_err());
    }

    #[test]
    fn restore_round_trips_added_and_deleted_parts_and_the_meta() {
        let tmp = project();
        let dir = tmp.path();
        let v0 = list(dir, false, None, 1).unwrap().remove(0);
        project::create_part(dir, 1, "Method").unwrap();
        project::write_part(dir, "sections/method.md", "# Method\n\nWe measured.\n").unwrap();
        set_title(dir, "Second");
        let v1 = save_version(dir, None, None, None).unwrap().unwrap();

        project::delete_part(dir, "sections/method.md").unwrap();
        project::create_part(dir, 1, "Results").unwrap();
        std::fs::write(dir.join("figures/plot.png"), b"png").unwrap();
        set_title(dir, "Third");
        let v2 = save_version(dir, None, None, None).unwrap().unwrap();
        project::write_part(dir, "sections/introduction.md", "# Introduction\n\nUnsaved.\n").unwrap();

        let restored = restore(dir, &v1.id).unwrap();
        assert_eq!(parts(&restored), ["sections/introduction.md", "sections/method.md"]);
        assert_eq!(restored.meta.title, "Second");
        assert_eq!(restored.parts[1].content, "# Method\n\nWe measured.\n");
        assert_eq!(restored.parts[0].content, "# Introduction\n\nStart writing here.\n");
        assert!(!dir.join("sections/results.md").exists() && !dir.join("figures/plot.png").exists());

        let timeline = list(dir, true, None, 3).unwrap();
        let repo = Repository::open(dir).unwrap();
        let when = when(resolve_commit(&repo, &v1.id).unwrap().time());
        assert_eq!(timeline[0].summary, format!("Restored the version of {when}"));
        assert_eq!(timeline[1].summary, format!("Before restoring the version of {when}"));
        assert_eq!(timeline[2].id, v2.id);
        assert_eq!(timeline[0].changed_parts.len(), 4, "{:?}", timeline[0].changed_parts);
        let mut options = StatusOptions::new();
        options.include_untracked(true).include_ignored(false);
        assert_eq!(Repository::open(dir).unwrap().statuses(Some(&mut options)).unwrap().len(), 0);

        // The unsaved text before the restore is kept in the autosave.
        let unsaved = read_part(dir, &timeline[1].id, "sections/introduction.md").unwrap();
        assert_eq!(unsaved, "# Introduction\n\nUnsaved.\n");

        let back = restore(dir, &v0.id).unwrap();
        assert_eq!(parts(&back), ["sections/introduction.md"]);
        assert_eq!(back.meta.title, "Paper");
        assert!(!dir.join("sections/method.md").exists());
        let raw = std::fs::read(dir.join(META_FILE)).unwrap();
        assert_eq!(raw, read_part(dir, &v0.id, META_FILE).unwrap().into_bytes());
    }

    #[test]
    fn restore_part_reinserts_a_deleted_part_after_its_predecessor() {
        let tmp = project();
        let dir = tmp.path();
        project::create_part(dir, 1, "Method").unwrap();
        project::create_part(dir, 2, "Results").unwrap();
        project::write_part(dir, "sections/method.md", "# Method\n\nWe measured.\n").unwrap();
        let v1 = save_version(dir, None, None, None).unwrap().unwrap();
        project::delete_part(dir, "sections/method.md").unwrap();
        project::write_part(dir, "sections/results.md", "# Results\n\nKept.\n").unwrap();

        let restored = restore_part(dir, &v1.id, "sections/method.md").unwrap();
        assert_eq!(parts(&restored), ["sections/introduction.md", "sections/method.md", "sections/results.md"]);
        assert_eq!(restored.parts[1].content, "# Method\n\nWe measured.\n");
        assert_eq!(restored.parts[2].content, "# Results\n\nKept.\n");
        let latest = list(dir, true, None, 2).unwrap();
        assert!(latest[0].summary.starts_with("Restored “Method” from the version of "), "{}", latest[0].summary);
        assert!(latest[1].summary.starts_with("Before restoring “Method”"), "{}", latest[1].summary);

        // Without its predecessor the part goes first.
        project::delete_part(dir, "sections/method.md").unwrap();
        project::delete_part(dir, "sections/introduction.md").unwrap();
        let restored = restore_part(dir, &v1.id, "sections/method.md").unwrap();
        assert_eq!(parts(&restored), ["sections/method.md", "sections/results.md"]);

        // A part still in the document is only rewritten.
        project::write_part(dir, "sections/method.md", "# Method\n\nChanged.\n").unwrap();
        let restored = restore_part(dir, &v1.id, "sections/method.md").unwrap();
        assert_eq!(parts(&restored), ["sections/method.md", "sections/results.md"]);
        assert_eq!(restored.parts[0].content, "# Method\n\nWe measured.\n");

        assert!(restore_part(dir, &v1.id, "../evil.md").is_err());
        assert!(restore_part(dir, &v1.id, "sections/missing.md").is_err());
    }

    #[test]
    fn insertion_follows_the_nearest_surviving_predecessor() {
        let s = |v: &[&str]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        assert_eq!(insertion_index(&s(&["a", "d"]), &s(&["a", "b", "c", "d"]), "c"), 1);
        assert_eq!(insertion_index(&s(&["d", "a"]), &s(&["a", "b", "c", "d"]), "c"), 2);
        assert_eq!(insertion_index(&s(&["d"]), &s(&["a", "b", "c", "d"]), "b"), 0);
        assert_eq!(insertion_index(&s(&["d"]), &s(&[]), "b"), 0);
    }
}
