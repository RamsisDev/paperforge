//! Discovering, creating and adopting the project's repository.

use std::collections::HashSet;
use std::path::Path;

use git2::{Commit, ConfigLevel, Repository, RepositoryInitOptions, Signature, Time};

use super::{HistoryStatus, RepoMode, git_err, log, open_repo, snapshot, worktree_tree};
use crate::project::{self, Author};

const ENABLED_KEY: &str = "paperforge.enabled";
const ADOPTED_KEY: &str = "paperforge.adopted";
const DEFAULT_BRANCH: &str = "main";
const AUTOSAVE_REFS: &str = "refs/paperforge/autosave";
const HEADER: &str = "# PaperForge";
const FALLBACK_NAME: &str = "PaperForge";
const FALLBACK_EMAIL: &str = "paperforge@localhost";

const IGNORE: [&str; 5] = [".build/", "*.tmp~", ".DS_Store", "Thumbs.db", "desktop.ini"];
const ATTRIBUTES: [&str; 8] = [
    "* text=auto eol=lf",
    "*.md   text eol=lf diff=markdown",
    "*.bib  text eol=lf diff=bibtex",
    "*.json text eol=lf",
    "*.png binary",
    "*.jpg binary",
    "*.jpeg binary",
    "*.pdf binary",
];

pub fn status(dir: &Path) -> Result<HistoryStatus, String> {
    let off = |mode| HistoryStatus { enabled: false, mode, branch: None, dirty: false, last_version: None, remote: None };
    let repo = match Repository::open(dir) {
        Ok(repo) => repo,
        Err(_) if Repository::discover(dir).is_ok() => return Ok(off(RepoMode::ParentRepo)),
        Err(_) => return Ok(off(RepoMode::None)),
    };
    if !flag(&repo, ENABLED_KEY) {
        return Ok(off(RepoMode::None));
    }
    let head = head_commit(&repo);
    let tree = worktree_tree(&repo, false)?;
    Ok(HistoryStatus {
        enabled: true,
        mode: if flag(&repo, ADOPTED_KEY) { RepoMode::Adopted } else { RepoMode::Own },
        branch: branch(&repo),
        dirty: head.as_ref().is_none_or(|c| c.tree_id() != tree),
        last_version: head.as_ref().map(|c| log::info(&repo, c)).transpose()?,
        remote: repo.find_remote("origin").ok().and_then(|r| r.url().ok().map(String::from)),
    })
}

pub fn enable(dir: &Path, summary: &str) -> Result<HistoryStatus, String> {
    let current = status(dir)?;
    if current.mode == RepoMode::ParentRepo {
        let parent = Repository::discover(dir)
            .ok()
            .and_then(|r| r.workdir().map(|w| w.display().to_string()))
            .unwrap_or_else(|| "a parent folder".into());
        return Err(format!(
            "This project is inside another git repository ({parent}); version history is not available for it yet"
        ));
    }
    if current.enabled {
        return Ok(current);
    }
    if !dir.join(project::META_FILE).is_file() {
        return Err(format!("{} is not a PaperForge project (no {})", dir.display(), project::META_FILE));
    }
    let repo = match Repository::open(dir) {
        Ok(repo) => {
            set_flag(&repo, ADOPTED_KEY)?;
            repo
        }
        Err(_) => {
            Repository::init_opts(dir, RepositoryInitOptions::new().initial_head(DEFAULT_BRANCH)).map_err(git_err)?
        }
    };
    complete(&dir.join(".gitignore"), &IGNORE, ignore_key)?;
    complete(&dir.join(".gitattributes"), &ATTRIBUTES, attribute_key)?;
    set_flag(&repo, ENABLED_KEY)?;
    drop(repo);
    snapshot::save_version(dir, None, None, Some(summary))?;
    status(dir)
}

/// The repository at `dir`, when PaperForge history is on for it.
pub(super) fn open_enabled(dir: &Path) -> Result<Repository, String> {
    let repo = open_repo(dir)?;
    if flag(&repo, ENABLED_KEY) { Ok(repo) } else { Err("Version history is not enabled for this project".into()) }
}

/// Only the repository's own config counts: a global setting must not switch history on.
fn flag(repo: &Repository, key: &str) -> bool {
    repo.config()
        .and_then(|c| c.open_level(ConfigLevel::Local))
        .and_then(|c| c.get_bool(key))
        .unwrap_or(false)
}

fn set_flag(repo: &Repository, key: &str) -> Result<(), String> {
    repo.config()
        .and_then(|c| c.open_level(ConfigLevel::Local))
        .and_then(|mut c| c.set_bool(key, true))
        .map_err(git_err)
}

/// The checked-out branch; `None` when HEAD is detached.
pub(super) fn branch(repo: &Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    head.symbolic_target().ok()??.strip_prefix("refs/heads/").map(String::from)
}

/// The hidden autosave chain of the checked-out branch (`HEAD` when detached).
pub(super) fn autosave_ref(repo: &Repository) -> String {
    format!("{AUTOSAVE_REFS}/{}", branch(repo).as_deref().unwrap_or("HEAD"))
}

/// The last version; `None` before the first one.
pub(super) fn head_commit(repo: &Repository) -> Option<Commit<'_>> {
    repo.head().ok()?.peel_to_commit().ok()
}

/// The last autosave of the checked-out branch.
pub(super) fn autosave_tip(repo: &Repository) -> Option<Commit<'_>> {
    repo.find_reference(&autosave_ref(repo)).ok()?.peel_to_commit().ok()
}

/// Signs snapshots and milestones. The time is now, or one second after `floor` (the newest
/// snapshot) when the clock has not moved past it, so snapshots taken within one second still
/// order by time.
pub(super) fn signature(repo: &Repository, dir: &Path, floor: Option<i64>) -> Result<Signature<'static>, String> {
    let config = repo.config().ok();
    let get = |key| config.as_ref().and_then(|c| c.get_string(key).ok());
    let authors = project::read_meta(dir).map(|m| m.authors).unwrap_or_default();
    let (name, email) = identity(get("user.name"), get("user.email"), &authors);
    let now = Signature::now(&name, &email).map_err(git_err)?;
    let seconds = floor.map_or(now.when().seconds(), |f| now.when().seconds().max(f + 1));
    Signature::new(&name, &email, &Time::new(seconds, now.when().offset_minutes())).map_err(git_err)
}

/// git's `user.name`/`user.email`, else the paper's first author, else "PaperForge". Never
/// written to the config.
fn identity(name: Option<String>, email: Option<String>, authors: &[Author]) -> (String, String) {
    let clean = |s: Option<String>| {
        s.map(|s| s.chars().filter(|c| !matches!(c, '<' | '>' | '\n' | '\r')).collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let email_or_fallback = |e| clean(e).unwrap_or_else(|| FALLBACK_EMAIL.into());
    if let Some(name) = clean(name) {
        return (name, email_or_fallback(email));
    }
    if let Some(author) = authors.first()
        && let Some(name) = clean(Some(author.name.clone()))
    {
        return (name, email_or_fallback(Some(author.email.clone())));
    }
    (FALLBACK_NAME.into(), FALLBACK_EMAIL.into())
}

/// Appends the `lines` the file lacks under a `# PaperForge` header. Lines match by `key`, so a
/// user's own rule for a pattern is kept and wins.
fn complete(path: &Path, lines: &[&str], key: fn(&str) -> &str) -> Result<(), String> {
    let existing = project::read_optional(path)?;
    let present: HashSet<&str> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(key)
        .collect();
    let missing: Vec<&str> = lines.iter().copied().filter(|l| !present.contains(key(l))).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out.push_str(HEADER);
    out.push('\n');
    for line in missing {
        out.push_str(line);
        out.push('\n');
    }
    project::write_atomic(path, out.as_bytes())
}

fn ignore_key(line: &str) -> &str {
    line.trim_matches('/')
}

fn attribute_key(line: &str) -> &str {
    line.split_whitespace().next().unwrap_or(line)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A blank project with history enabled ("Project created").
    pub(in crate::history) fn project() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        project::create(tmp.path(), None, "article", "Paper", "en").unwrap();
        enable(tmp.path(), "Project created").unwrap();
        tmp
    }

    pub(in crate::history) fn tree_paths(commit: &Commit) -> Vec<String> {
        let mut paths = Vec::new();
        commit
            .tree()
            .unwrap()
            .walk(git2::TreeWalkMode::PreOrder, |root, entry| {
                if entry.kind() == Some(git2::ObjectType::Blob) {
                    paths.push(format!("{root}{}", entry.name().unwrap()));
                }
                git2::TreeWalkResult::Ok
            })
            .unwrap();
        paths
    }

    #[test]
    fn enable_ignores_build_output_and_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        project::create(dir, None, "article", "Paper", "en").unwrap();
        std::fs::create_dir_all(dir.join(".build")).unwrap();
        std::fs::write(dir.join(".build/paper.pdf"), "PDF").unwrap();
        std::fs::write(dir.join("sections/introduction.tmp~"), "partial").unwrap();

        let status = enable(dir, "Project created").unwrap();
        assert!(status.enabled && !status.dirty);
        assert_eq!(status.mode, RepoMode::Own);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.last_version.unwrap().summary, "Project created");

        let repo = Repository::open(dir).unwrap();
        let head = head_commit(&repo).unwrap();
        assert_eq!(
            tree_paths(&head),
            [".gitattributes", ".gitignore", "paper.json", "refs.bib", "sections/introduction.md"]
        );
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(ignore, "# PaperForge\n.build/\n*.tmp~\n.DS_Store\nThumbs.db\ndesktop.ini\n");
        assert!(std::fs::read_to_string(dir.join(".gitattributes")).unwrap().contains("*.md   text eol=lf diff=markdown\n"));
        let local = repo.config().unwrap().open_level(ConfigLevel::Local).unwrap();
        assert!(local.get_string("user.name").is_err() && local.get_string("user.email").is_err());
    }

    #[test]
    fn enabling_twice_is_a_no_op() {
        let tmp = project();
        let repo = Repository::open(tmp.path()).unwrap();
        let first = head_commit(&repo).unwrap().id();
        let again = enable(tmp.path(), "Version history enabled").unwrap();
        assert_eq!(again.last_version.unwrap().id, first.to_string());
        assert_eq!(head_commit(&Repository::open(tmp.path()).unwrap()).unwrap().id(), first);
    }

    #[test]
    fn a_project_inside_another_repository_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        Repository::init(tmp.path()).unwrap();
        let dir = tmp.path().join("paper");
        project::create(&dir, None, "article", "Paper", "en").unwrap();
        assert_eq!(status(&dir).unwrap().mode, RepoMode::ParentRepo);
        let err = enable(&dir, "Version history enabled").unwrap_err();
        assert!(err.contains("inside another git repository"), "{err}");
        assert!(!dir.join(".git").exists() && !dir.join(".gitignore").exists());
    }

    #[test]
    fn status_reports_modes_and_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        project::create(dir, None, "article", "Paper", "en").unwrap();
        assert_eq!(status(dir).unwrap(), HistoryStatus {
            enabled: false,
            mode: RepoMode::None,
            branch: None,
            dirty: false,
            last_version: None,
            remote: None,
        });
        enable(dir, "Project created").unwrap();
        Repository::open(dir).unwrap().remote("origin", "https://example.org/paper.git").unwrap();
        let clean = status(dir).unwrap();
        assert!(clean.enabled && !clean.dirty);
        assert_eq!(clean.remote.as_deref(), Some("https://example.org/paper.git"));
        std::fs::write(dir.join("sections/introduction.md"), "# Introduction\n\nMore.\n").unwrap();
        assert!(status(dir).unwrap().dirty);
        assert!(open_enabled(tempfile::tempdir().unwrap().path()).is_err());
    }

    #[test]
    fn an_existing_repository_is_adopted_and_its_rules_completed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        project::create(dir, None, "article", "Paper", "en").unwrap();
        Repository::init(dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules\n/.build").unwrap();
        std::fs::write(dir.join(".gitattributes"), "*.md text\n").unwrap();
        assert_eq!(status(dir).unwrap().mode, RepoMode::None);
        assert!(super::super::save_version(dir, None, None, None).is_err());

        let status = enable(dir, "Version history enabled").unwrap();
        assert_eq!((status.enabled, status.mode), (true, RepoMode::Adopted));
        assert_eq!(status.last_version.unwrap().summary, "Version history enabled");
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "node_modules\n/.build\n\n# PaperForge\n*.tmp~\n.DS_Store\nThumbs.db\ndesktop.ini\n"
        );
        let attributes = std::fs::read_to_string(dir.join(".gitattributes")).unwrap();
        assert!(attributes.starts_with("*.md text\n\n# PaperForge\n* text=auto eol=lf\n*.bib"), "{attributes}");
    }

    #[test]
    fn identity_prefers_git_config_then_the_first_author() {
        let author = |name: &str, email: &str| Author { name: name.into(), email: email.into(), ..Author::default() };
        let ana = [author("Ana <Ruiz>", ""), author("Ben", "ben@example.org")];
        assert_eq!(
            identity(Some("Git User".into()), Some("git@example.org".into()), &ana),
            ("Git User".into(), "git@example.org".into())
        );
        assert_eq!(identity(Some("Git User".into()), None, &ana), ("Git User".into(), FALLBACK_EMAIL.into()));
        assert_eq!(identity(None, Some("git@example.org".into()), &ana), ("Ana Ruiz".into(), FALLBACK_EMAIL.into()));
        assert_eq!(identity(Some(" ".into()), None, &[author("", "x@y")]), (FALLBACK_NAME.into(), FALLBACK_EMAIL.into()));
        assert_eq!(identity(None, None, &[]), (FALLBACK_NAME.into(), FALLBACK_EMAIL.into()));
    }
}
