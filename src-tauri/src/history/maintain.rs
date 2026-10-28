//! Keeping the repository small. libgit2 has no `git gc`, so this thins old autosaves and packs
//! every reachable object into one pack, like `git repack -a -d` followed by
//! `git prune --expire=2.weeks.ago`. Objects are reachable from refs, reflogs and `.git/index`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use git2::{ConfigLevel, ObjectType, Oid, Repository};

use super::{VersionKind, git_err, log, repo};

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;
/// Every autosave younger than this is kept; then one per hour, then one per day, then none.
const KEEP_ALL: i64 = 2 * DAY;
const KEEP_HOURLY: i64 = 14 * DAY;
const KEEP_DAILY: i64 = 90 * DAY;
/// Unreachable loose objects younger than this may belong to a snapshot or a `git` command still
/// running (git's default `gc.pruneExpire`).
const PRUNE_AFTER: Duration = Duration::from_secs(14 * DAY as u64);
/// With fewer loose objects, at most one pack and nothing thinned, packing is skipped.
const LOOSE_LIMIT: usize = 256;
const MAINTAIN_EVERY: i64 = DAY;
const LAST_KEY: &str = "paperforge.lastMaintenance";
const AUTOSAVE_GLOB: &str = "refs/paperforge/autosave/*";

#[derive(Debug, Default, PartialEq)]
pub struct Maintenance {
    pub dropped_autosaves: usize,
    /// Objects in the new pack; 0 when packing was not needed.
    pub packed_objects: usize,
    pub removed_loose: usize,
    pub removed_packs: usize,
}

/// Maintains the repository at most once a day; `None` when history is off or it is not due.
pub fn maintain_if_due(dir: &Path, now: i64) -> Result<Option<Maintenance>, String> {
    let Ok(repo) = repo::open_enabled(dir) else { return Ok(None) };
    let mut config = repo.config().and_then(|c| c.open_level(ConfigLevel::Local)).map_err(git_err)?;
    if now - config.get_i64(LAST_KEY).unwrap_or(0) < MAINTAIN_EVERY {
        return Ok(None);
    }
    drop(repo);
    let done = maintain(dir, now)?;
    config.set_i64(LAST_KEY, now).map_err(git_err)?;
    Ok(Some(done))
}

pub fn maintain(dir: &Path, now: i64) -> Result<Maintenance, String> {
    let repo = repo::open_enabled(dir)?;
    let mut done = Maintenance::default();
    let chains: Vec<String> = repo
        .references_glob(AUTOSAVE_GLOB)
        .map_err(git_err)?
        .filter_map(|r| r.ok()?.name().ok().map(String::from))
        .collect();
    for name in chains {
        done.dropped_autosaves += thin(&repo, &name, now)?;
    }

    // Linked worktrees have a HEAD and an index of their own, which this pass does not read.
    if repo.path().join("worktrees").is_dir() {
        return Ok(done);
    }
    let objects = repo.path().join("objects");
    let pack_dir = objects.join("pack");
    let packs = packs(&pack_dir)?;
    let loose = loose_objects(&objects)?;
    if done.dropped_autosaves == 0 && packs.len() <= 1 && loose.len() < LOOSE_LIMIT {
        return Ok(done);
    }
    let (reachable, tips) = reachable(&repo)?;
    if reachable.is_empty() {
        return Ok(done);
    }
    let new_pack = write_pack(&repo, &reachable, &tips, &pack_dir)?;
    done.packed_objects = reachable.len();
    drop(repo);

    for pack in packs.iter().filter(|p| **p != new_pack) {
        remove_pack(pack)?;
        done.removed_packs += 1;
    }
    if done.removed_packs > 0 {
        remove_if_present(&pack_dir.join("multi-pack-index"))?;
    }
    let expired = SystemTime::now() - PRUNE_AFTER;
    for (id, path) in loose {
        let old = fs::metadata(&path).and_then(|m| m.modified()).is_ok_and(|t| t < expired);
        if reachable.contains(&id) || old {
            remove_if_present(&path)?;
            done.removed_loose += 1;
        }
    }
    Ok(done)
}

/// Which autosaves survive, given their times newest first: all of the last 48 hours, then the
/// newest of each hour for two weeks, then the newest of each day for three months.
fn retained(times: &[i64], now: i64) -> Vec<bool> {
    let mut buckets = HashSet::new();
    times
        .iter()
        .map(|&time| match now - time {
            age if age < KEEP_ALL => true,
            age if age < KEEP_HOURLY => buckets.insert((HOUR, time.div_euclid(HOUR))),
            age if age < KEEP_DAILY => buckets.insert((DAY, time.div_euclid(DAY))),
            _ => false,
        })
        .collect()
}

/// Rewrites the autosave chain `name` without the autosaves retention drops, reusing their trees
/// and messages; the ref moves only if nobody moved it meanwhile. Returns how many were dropped.
fn thin(repo: &Repository, name: &str, now: i64) -> Result<usize, String> {
    let Some(tip) = repo.find_reference(name).map_err(git_err)?.target() else { return Ok(0) };
    let mut chain = Vec::new();
    let mut base = None;
    let mut next = repo.find_commit(tip).ok();
    while let Some(commit) = next {
        if log::kind(&commit) != VersionKind::Autosave {
            base = Some(commit.id());
            break;
        }
        next = commit.parent(0).ok();
        chain.push(commit);
    }
    let times: Vec<i64> = chain.iter().map(|c| c.time().seconds()).collect();
    let keep = retained(&times, now);
    let dropped = keep.iter().filter(|k| !**k).count();
    if dropped == 0 {
        return Ok(0);
    }

    let mut parent = base;
    let mut kept_any = false;
    for (commit, _) in chain.iter().zip(&keep).rev().filter(|(_, keep)| **keep) {
        kept_any = true;
        parent = Some(if commit.parent_ids().next() == parent {
            commit.id()
        } else {
            let parents = parent.map(|p| repo.find_commit(p)).transpose().map_err(git_err)?;
            let tree = commit.tree().map_err(git_err)?;
            let message = commit.message().unwrap_or_default();
            repo.commit(None, &commit.author(), &commit.committer(), message, &tree, &parents.iter().collect::<Vec<_>>())
                .map_err(git_err)?
        });
    }
    match parent.filter(|_| kept_any) {
        Some(new_tip) => {
            repo.reference_matching(name, new_tip, true, tip, "PaperForge: thin autosaves").map_err(git_err)?;
        }
        None => {
            let mut reference = repo.find_reference(name).map_err(git_err)?;
            if reference.target() == Some(tip) {
                reference.delete().map_err(git_err)?;
            }
        }
    }
    Ok(dropped)
}

/// Every object reachable from refs, reflogs, HEAD and `.git/index`, and the tips it starts from.
fn reachable(repo: &Repository) -> Result<(HashSet<Oid>, Vec<Oid>), String> {
    let mut tips = Vec::new();
    let mut names = vec!["HEAD".to_string()];
    for reference in repo.references().map_err(git_err)? {
        let reference = reference.map_err(git_err)?;
        tips.extend(reference.target());
        names.extend(reference.name().ok().map(String::from));
    }
    tips.extend(repo.find_reference("HEAD").ok().and_then(|h| h.target()));
    for name in names {
        if let Ok(reflog) = repo.reflog(&name) {
            for entry in reflog.iter() {
                tips.extend([entry.id_old(), entry.id_new()]);
            }
        }
    }
    tips.extend(repo.index().map_err(git_err)?.iter().map(|e| e.id));

    let odb = repo.odb().map_err(git_err)?;
    tips.retain(|id| !id.is_zero() && odb.exists(*id));
    let mut seen = HashSet::new();
    let mut stack = tips.clone();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Ok(object) = repo.find_object(id, None) else { continue };
        match object.kind() {
            Some(ObjectType::Commit) => {
                let commit = object.peel_to_commit().map_err(git_err)?;
                stack.push(commit.tree_id());
                stack.extend(commit.parent_ids());
            }
            Some(ObjectType::Tag) => stack.extend(object.as_tag().map(|t| t.target_id())),
            Some(ObjectType::Tree) => {
                for entry in object.peel_to_tree().map_err(git_err)?.iter() {
                    match entry.kind() {
                        Some(ObjectType::Tree) => stack.push(entry.id()),
                        // Blobs are not read, only listed; submodule commits live elsewhere.
                        Some(ObjectType::Blob) if odb.exists(entry.id()) => {
                            seen.insert(entry.id());
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok((seen, tips))
}

/// Writes `reachable` as one pack into `pack_dir` and returns its path. Commits go in through
/// their trees, so blobs carry their paths and delta well against older versions of themselves.
fn write_pack(repo: &Repository, reachable: &HashSet<Oid>, tips: &[Oid], pack_dir: &Path) -> Result<PathBuf, String> {
    let mut builder = repo.packbuilder().map_err(git_err)?;
    let mut walk = repo.revwalk().map_err(git_err)?;
    for id in tips {
        if repo.find_commit(*id).is_ok() {
            walk.push(*id).map_err(git_err)?;
        }
    }
    builder.insert_walk(&mut walk).map_err(git_err)?;
    for id in reachable {
        builder.insert_object(*id, None).map_err(git_err)?;
    }
    builder.write(pack_dir, 0).map_err(git_err)?;
    let name = builder.name().map_err(git_err)?.ok_or("The pack was not written")?;
    Ok(pack_dir.join(format!("pack-{name}.pack")))
}

/// The packs in `pack_dir`, without those a `.keep` file protects.
fn packs(pack_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let Ok(entries) = fs::read_dir(pack_dir) else { return Ok(Vec::new()) };
    let mut packs = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "pack") && !path.with_extension("keep").exists() {
            packs.push(path);
        }
    }
    Ok(packs)
}

/// Loose objects as `objects/ab/cdef…` files with their ids.
fn loose_objects(objects: &Path) -> Result<Vec<(Oid, PathBuf)>, String> {
    let mut found = Vec::new();
    for entry in fs::read_dir(objects).map_err(|e| format!("{}: {e}", objects.display()))? {
        let fanout = entry.map_err(|e| e.to_string())?;
        let prefix = fanout.file_name().to_string_lossy().into_owned();
        if prefix.len() != 2 || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        for object in fs::read_dir(fanout.path()).map_err(|e| e.to_string())? {
            let object = object.map_err(|e| e.to_string())?;
            if let Ok(id) = Oid::from_str(&format!("{prefix}{}", object.file_name().to_string_lossy())) {
                found.push((id, object.path()));
            }
        }
    }
    Ok(found)
}

fn remove_pack(pack: &Path) -> Result<(), String> {
    // The index goes last: without it git ignores the pack, without the pack the index is an error.
    for extension in ["pack", "rev", "bitmap", "mtimes", "promisor", "idx"] {
        remove_if_present(&pack.with_extension(extension))?;
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::repo::tests::project;
    use crate::history::{self, snapshot};
    use crate::project;
    use git2::{Signature, Time};

    const NOW: i64 = 1_800_000_000;

    /// Autosaves on the chain at the given ages (seconds before `NOW`), oldest first.
    fn autosaves_at(dir: &Path, ages: &[i64]) {
        let repo = Repository::open(dir).unwrap();
        let name = repo::autosave_ref(&repo);
        let mut parent = repo::head_commit(&repo).unwrap();
        for (i, age) in ages.iter().enumerate() {
            project::write_part(dir, "sections/introduction.md", &format!("# Introduction\n\nDraft {i}.\n")).unwrap();
            let tree = repo.find_tree(history::worktree_tree(&repo, false).unwrap()).unwrap();
            let sig = Signature::new("Ada", "ada@example.org", &Time::new(NOW - age, 0)).unwrap();
            let message = format!("Draft {i}\n\nPaperForge-Kind: autosave\nPaperForge-Changed: sections/introduction.md");
            let id = repo.commit(Some(&name), &sig, &sig, &message, &tree, &[&parent]).unwrap();
            parent = repo.find_commit(id).unwrap();
        }
    }

    fn chain_summaries(dir: &Path) -> Vec<String> {
        history::list(dir, true, None, 1000)
            .unwrap()
            .into_iter()
            .filter(|v| v.kind == VersionKind::Autosave)
            .map(|v| v.summary)
            .collect()
    }

    fn pack_count(dir: &Path) -> usize {
        packs(&dir.join(".git/objects/pack")).unwrap().len()
    }

    #[test]
    fn retention_keeps_recent_hourly_and_daily_autosaves() {
        // `NOW` is on the hour; `day` starts a day twenty days back.
        let day = (NOW - 20 * DAY).div_euclid(DAY) * DAY;
        let times = [
            NOW - 600,
            NOW - 47 * HOUR,
            NOW - 50 * HOUR + 1200,
            NOW - 50 * HOUR + 600,
            NOW - 51 * HOUR,
            day + 3600,
            day + 60,
            NOW - 100 * DAY,
        ];
        assert_eq!(retained(&times, NOW), [true, true, true, false, true, true, false, false]);
    }

    #[test]
    fn thinning_rewrites_the_autosave_chain_and_leaves_versions_alone() {
        let tmp = project();
        let dir = tmp.path();
        let head = Repository::open(dir).unwrap().head().unwrap().target().unwrap();
        // `NOW` is on the hour: drafts 1–3 fall in one hour three days ago, draft 0 is too old.
        let three_days = 72 * HOUR;
        autosaves_at(dir, &[200 * DAY, three_days + 1800, three_days + 1200, three_days + 600, HOUR]);
        assert_eq!(chain_summaries(dir).len(), 5);

        let done = maintain(dir, NOW).unwrap();
        assert_eq!(done.dropped_autosaves, 3);
        assert_eq!(chain_summaries(dir), ["Draft 4", "Draft 3"]);
        let repo = Repository::open(dir).unwrap();
        assert_eq!(repo.head().unwrap().target().unwrap(), head);
        let tip = repo::autosave_tip(&repo).unwrap();
        assert_eq!(tip.message().unwrap(), "Draft 4\n\nPaperForge-Kind: autosave\nPaperForge-Changed: sections/introduction.md");
        assert_eq!(tip.parent(0).unwrap().parent_id(0).unwrap(), head);
    }

    #[test]
    fn a_chain_of_only_expired_autosaves_is_removed() {
        let tmp = project();
        let dir = tmp.path();
        autosaves_at(dir, &[120 * DAY, 100 * DAY]);
        assert_eq!(maintain(dir, NOW).unwrap().dropped_autosaves, 2);
        let repo = Repository::open(dir).unwrap();
        assert!(repo::autosave_tip(&repo).is_none());
        assert_eq!(chain_summaries(dir), Vec::<String>::new());
    }

    #[test]
    fn packing_keeps_every_snapshot_readable_and_prunes_old_garbage() {
        let now = history::unix_now();
        let tmp = project();
        let dir = tmp.path();
        for i in 0..80 {
            project::write_part(dir, "sections/introduction.md", &format!("# Introduction\n\nEdit {i}.\n")).unwrap();
            if i % 2 == 0 {
                snapshot::autosave(dir, None).unwrap().unwrap();
            } else {
                snapshot::save_version(dir, (i == 7).then_some("Sent to reviewer"), None, None).unwrap().unwrap();
            }
        }
        let repo = Repository::open(dir).unwrap();
        let odb = repo.odb().unwrap();
        let fresh_garbage = odb.write(ObjectType::Blob, b"unreferenced, written just now").unwrap();
        let old_garbage = odb.write(ObjectType::Blob, b"unreferenced, written long ago").unwrap();
        let old_path = dir.join(".git/objects").join(&old_garbage.to_string()[..2]).join(&old_garbage.to_string()[2..]);
        fs::File::open(&old_path)
            .unwrap()
            .set_modified(SystemTime::now() - PRUNE_AFTER - Duration::from_secs(60))
            .unwrap();
        drop(odb);
        drop(repo);
        let before = history::list(dir, true, None, 1000).unwrap();
        let first = before.last().unwrap().id.clone();

        let done = maintain(dir, now).unwrap();
        assert!(done.packed_objects > 0);
        assert_eq!(pack_count(dir), 1);
        let left: Vec<Oid> = loose_objects(&dir.join(".git/objects")).unwrap().into_iter().map(|(id, _)| id).collect();
        assert_eq!(left, [fresh_garbage]);

        assert_eq!(history::list(dir, true, None, 1000).unwrap(), before);
        assert_eq!(history::read_part(dir, &first, "sections/introduction.md").unwrap(), "# Introduction\n\nStart writing here.\n");
        assert!(!history::diff(dir, &first, None).unwrap().parts.is_empty());
        assert!(!history::status(dir).unwrap().dirty);
        // The git CLI must read the result too, when it is installed.
        if let Ok(fsck) = std::process::Command::new("git").arg("-C").arg(dir).args(["fsck", "--full", "--strict"]).output() {
            assert!(fsck.status.success(), "{}", String::from_utf8_lossy(&fsck.stderr));
        }

        project::write_part(dir, "sections/introduction.md", "# Introduction\n\nAfter packing.\n").unwrap();
        snapshot::save_version(dir, None, None, None).unwrap().unwrap();
        assert_eq!(maintain(dir, now).unwrap(), Maintenance::default(), "few loose objects: nothing to do");

        let repo = Repository::open(dir).unwrap();
        let odb = repo.odb().unwrap();
        for i in 0..LOOSE_LIMIT {
            odb.write(ObjectType::Blob, format!("fresh garbage {i}").as_bytes()).unwrap();
        }
        drop(odb);
        drop(repo);
        let repacked = maintain(dir, now).unwrap();
        assert_eq!(repacked.removed_packs, 1);
        assert_eq!(pack_count(dir), 1);
        assert_eq!(history::list(dir, true, None, 1000).unwrap().len(), before.len() + 1);
    }

    #[test]
    fn maintenance_runs_at_most_once_a_day() {
        let tmp = project();
        let dir = tmp.path();
        assert!(maintain_if_due(dir, NOW).unwrap().is_some());
        assert!(maintain_if_due(dir, NOW + HOUR).unwrap().is_none());
        assert!(maintain_if_due(dir, NOW + DAY).unwrap().is_some());

        let plain = tempfile::tempdir().unwrap();
        project::create(plain.path(), None, "article", "", "").unwrap();
        assert_eq!(maintain_if_due(plain.path(), NOW).unwrap(), None);
    }
}
