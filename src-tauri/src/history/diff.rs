//! Comparing snapshots: word diff of parts, plain-language changes of `paper.json` and `refs.bib`.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use git2::{Delta, DiffFile, DiffFindOptions, Oid, Repository, Tree};
use similar::{ChangeTag, TextDiff};

use super::{
    ChangeStatus, DiffSegment, FileChange, MetaChange, PartDiff, SegmentKind, VersionDiff, bib, git_err,
    open_repo, part_title, resolve_commit, worktree_tree,
};
use crate::project::{BIB_FILE, META_FILE, PaperMeta, SECTIONS_DIR};

/// A word diff still running after this settles for a coarser, still correct, result.
const WORD_DIFF_TIMEOUT: Duration = Duration::from_secs(1);

/// `MetaChange::field` when a side's `paper.json` is missing or unreadable.
const WHOLE_META: &str = "";

/// One side of the comparison.
struct Side<'a, 'r> {
    repo: &'r Repository,
    tree: &'a Tree<'r>,
    /// `None` when `paper.json` is missing or unparseable.
    meta: Option<PaperMeta>,
}

impl<'a, 'r> Side<'a, 'r> {
    fn new(repo: &'r Repository, tree: &'a Tree<'r>) -> Self {
        let mut side = Side { repo, tree, meta: None };
        side.meta = side.read(META_FILE).and_then(|raw| serde_json::from_slice(&raw).ok());
        side
    }

    fn blob_id(&self, path: &str) -> Option<Oid> {
        self.tree.get_path(Path::new(path)).ok().map(|e| e.id())
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        let blob = self.repo.find_blob(self.blob_id(path)?).ok()?;
        Some(blob.content().to_vec())
    }

    /// The file's text, empty when it is absent.
    fn text(&self, path: &str) -> String {
        self.read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
    }

    fn title(&self, file: &str) -> String {
        part_title(&self.text(file), file)
    }

    fn parts(&self) -> &[String] {
        self.meta.as_ref().map_or(&[], |m| &m.parts)
    }
}

pub fn diff(dir: &Path, from: &str, to: Option<&str>) -> Result<VersionDiff, String> {
    let repo = open_repo(dir)?;
    let from_commit = resolve_commit(&repo, from)?;
    let old_tree = from_commit.tree().map_err(git_err)?;
    let (to_id, new_tree) = match to {
        Some(id) => {
            let commit = resolve_commit(&repo, id)?;
            (Some(commit.id().to_string()), commit.tree().map_err(git_err)?)
        }
        None => (None, repo.find_tree(worktree_tree(&repo, false)?).map_err(git_err)?),
    };
    let old = Side::new(&repo, &old_tree);
    let new = Side::new(&repo, &new_tree);

    let mut changes = repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None).map_err(git_err)?;
    changes.find_similar(Some(DiffFindOptions::new().renames(true))).map_err(git_err)?;

    let listed: HashSet<&str> = old.parts().iter().chain(new.parts()).map(String::as_str).collect();
    let sections = format!("{SECTIONS_DIR}/");
    let is_part = |path: &str| path.ends_with(".md") && (listed.contains(path) || path.starts_with(&sections));
    let blob_text = |id: Oid| {
        repo.find_blob(id).map(|b| String::from_utf8_lossy(b.content()).into_owned()).unwrap_or_default()
    };

    let mut renames = HashMap::new();
    let mut parts = Vec::new();
    let mut files = Vec::new();
    for delta in changes.deltas() {
        let status = match delta.status() {
            Delta::Unmodified => continue,
            Delta::Added => ChangeStatus::Added,
            Delta::Deleted => ChangeStatus::Deleted,
            Delta::Renamed => ChangeStatus::Renamed,
            _ => ChangeStatus::Modified,
        };
        let path_of = |f: DiffFile| f.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let old_path = path_of(delta.old_file());
        let new_path = path_of(delta.new_file());
        let path = if status == ChangeStatus::Deleted { old_path.clone() } else { new_path.clone() };
        if path == META_FILE || path == BIB_FILE {
            continue;
        }
        let old_file = if status == ChangeStatus::Renamed {
            renames.insert(old_path.clone(), new_path);
            Some(old_path)
        } else {
            None
        };
        if !is_part(&path) && !old_file.as_deref().is_some_and(is_part) {
            files.push(FileChange { path, old_path: old_file, status });
            continue;
        }
        let before = if status == ChangeStatus::Added { String::new() } else { blob_text(delta.old_file().id()) };
        let after = if status == ChangeStatus::Deleted { String::new() } else { blob_text(delta.new_file().id()) };
        let title = part_title(if status == ChangeStatus::Deleted { &before } else { &after }, &path);
        parts.push(PartDiff { file: path, old_file, title, status, segments: word_diff(&before, &after) });
    }
    parts.sort_by_key(|p| part_rank(p, old.parts(), new.parts()));

    let meta = match (&old.meta, &new.meta) {
        _ if old.blob_id(META_FILE) == new.blob_id(META_FILE) => Vec::new(),
        (Some(a), Some(b)) => meta_changes(a, b, &renames, &|f| old.title(f), &|f| new.title(f)),
        _ => vec![MetaChange { field: WHOLE_META.into(), description: "Paper settings changed".into() }],
    };

    let mut bib = Vec::new();
    let (old_bib, new_bib) = (old.blob_id(BIB_FILE), new.blob_id(BIB_FILE));
    if old_bib != new_bib {
        bib = bib::changes(&old.text(BIB_FILE), &new.text(BIB_FILE));
        if bib.is_empty() {
            let status = match (old_bib, new_bib) {
                (None, _) => ChangeStatus::Added,
                (_, None) => ChangeStatus::Deleted,
                _ => ChangeStatus::Modified,
            };
            files.push(FileChange { path: BIB_FILE.into(), old_path: None, status });
        }
    }

    Ok(VersionDiff { from: from_commit.id().to_string(), to: to_id, parts, meta, bib, files })
}

/// Document order on the newer side, then parts present but not listed, then deleted parts in
/// the older side's order.
fn part_rank(part: &PartDiff, old_order: &[String], new_order: &[String]) -> (u8, usize) {
    let position = |order: &[String]| order.iter().position(|p| *p == part.file);
    if part.status == ChangeStatus::Deleted {
        (2, position(old_order).unwrap_or(usize::MAX))
    } else {
        position(new_order).map_or((1, 0), |i| (0, i))
    }
}

/// Words, whitespace runs and single other characters, so Markdown marks (`**`, `#`, `[`) and
/// punctuation never glue a changed word to its neighbors.
fn tokenize(text: &str) -> Vec<&str> {
    #[derive(PartialEq)]
    enum Class {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_alphanumeric() {
            Class::Word
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    };
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        let kind = class(c);
        let end = match chars.peek() {
            Some(&(_, next)) if kind != Class::Other && class(next) == kind => continue,
            Some(&(at, _)) => at,
            None => text.len(),
        };
        tokens.push(&text[start..end]);
        start = end;
    }
    tokens
}

/// The whole text as runs of unchanged, deleted and inserted words. Within a changed stretch the
/// deleted run comes first; whitespace between two changes joins them into one stretch.
fn word_diff(old: &str, new: &str) -> Vec<DiffSegment> {
    let old_tokens = tokenize(old);
    let new_tokens = tokenize(new);
    let diff = TextDiff::configure().timeout(WORD_DIFF_TIMEOUT).diff_slices(&old_tokens, &new_tokens);
    let changes: Vec<_> = diff.iter_all_changes().map(|c| (c.tag(), c.value())).collect();

    let mut segments: Vec<DiffSegment> = Vec::new();
    let (mut deleted, mut inserted) = (String::new(), String::new());
    for (i, &(tag, token)) in changes.iter().enumerate() {
        match tag {
            ChangeTag::Delete => deleted.push_str(token),
            ChangeTag::Insert => inserted.push_str(token),
            ChangeTag::Equal => {
                let pending = !deleted.is_empty() || !inserted.is_empty();
                let next_changed = changes.get(i + 1).is_some_and(|&(t, _)| t != ChangeTag::Equal);
                if pending && next_changed && token.chars().all(char::is_whitespace) {
                    deleted.push_str(token);
                    inserted.push_str(token);
                    continue;
                }
                flush(&mut segments, &mut deleted, &mut inserted);
                push(&mut segments, SegmentKind::Equal, token);
            }
        }
    }
    flush(&mut segments, &mut deleted, &mut inserted);
    segments
}

fn flush(segments: &mut Vec<DiffSegment>, deleted: &mut String, inserted: &mut String) {
    push(segments, SegmentKind::Delete, deleted);
    push(segments, SegmentKind::Insert, inserted);
    deleted.clear();
    inserted.clear();
}

fn push(segments: &mut Vec<DiffSegment>, kind: SegmentKind, text: &str) {
    if text.is_empty() {
        return;
    }
    match segments.last_mut() {
        Some(last) if last.kind == kind => last.text.push_str(text),
        _ => segments.push(DiffSegment { kind, text: text.to_string() }),
    }
}

/// `paper.json` changes in plain language, in `PaperMeta` field order. `renames` maps older part
/// paths to newer ones; `old_title` and `new_title` name a part on each side.
fn meta_changes(
    a: &PaperMeta,
    b: &PaperMeta,
    renames: &HashMap<String, String>,
    old_title: &dyn Fn(&str) -> String,
    new_title: &dyn Fn(&str) -> String,
) -> Vec<MetaChange> {
    let toc_depth = if a.toc_depth == b.toc_depth {
        Vec::new()
    } else {
        vec![format!("Table of contents depth: {} → {}", a.toc_depth, b.toc_depth)]
    };
    let (old_options, new_options) = (a.class_options.join(", "), b.class_options.join(", "));
    let fields = [
        ("template", replaced("Template", &a.template, &b.template, "none")),
        ("title", replaced("Title", &a.title, &b.title, "none")),
        ("authors", named_changes(&a.authors, &b.authors, |x| x.name.as_str(), "Author", "Authors")),
        ("abstract", abstract_change(&a.abstract_text, &b.abstract_text)),
        ("keywords", named_changes(&a.keywords, &b.keywords, String::as_str, "Keyword", "Keywords")),
        ("language", replaced("Language", &a.language, &b.language, "none")),
        ("date", replaced("Date", &a.date, &b.date, "none")),
        ("bibStyle", replaced("Citation style", &a.bib_style, &b.bib_style, "the template's default")),
        ("parts", part_changes(&a.parts, &b.parts, renames, old_title, new_title)),
        ("toc", switched("Table of contents", a.toc, b.toc)),
        ("lof", switched("List of figures", a.lof, b.lof)),
        ("lot", switched("List of tables", a.lot, b.lot)),
        ("tocDepth", toc_depth),
        ("classOptions", replaced("Document class options", &old_options, &new_options, "none")),
        ("templateFile", replaced("Template file", &a.template_file, &b.template_file, "built-in")),
        ("layout", if a.layout == b.layout { Vec::new() } else { vec!["Page setup changed".into()] }),
        ("styles", named_changes(&a.styles, &b.styles, |s| s.name.as_str(), "Style", "Styles")),
    ];
    fields
        .into_iter()
        .flat_map(|(field, descriptions)| {
            descriptions.into_iter().map(move |description| MetaChange { field: field.into(), description })
        })
        .collect()
}

/// "Title: “Old” → “New”", with `empty` standing for an empty value.
fn replaced(label: &str, old: &str, new: &str, empty: &str) -> Vec<String> {
    let shown = |v: &str| if v.is_empty() { empty.to_string() } else { format!("“{v}”") };
    if old == new { Vec::new() } else { vec![format!("{label}: {} → {}", shown(old), shown(new))] }
}

fn switched(label: &str, old: bool, new: bool) -> Vec<String> {
    match (old, new) {
        (false, true) => vec![format!("{label} turned on")],
        (true, false) => vec![format!("{label} turned off")],
        _ => Vec::new(),
    }
}

fn abstract_change(old: &str, new: &str) -> Vec<String> {
    let description = match (old.trim().is_empty(), new.trim().is_empty()) {
        _ if old == new => return Vec::new(),
        (true, false) => "Abstract added",
        (false, true) => "Abstract removed",
        _ => "Abstract edited",
    };
    vec![description.into()]
}

/// Items matched by name: "<One> added: x", "<One> removed: x", "<One> changed: x"; when none of
/// these explains the difference, "Order of <many> changed" or "<Many> changed" (unnamed items).
fn named_changes<T: PartialEq>(old: &[T], new: &[T], name: fn(&T) -> &str, one: &str, many: &str) -> Vec<String> {
    let key = |x: &T| name(x).trim().to_string();
    let mut used = vec![false; new.len()];
    let mut matched = Vec::new();
    let (mut removed, mut edited) = (Vec::new(), Vec::new());
    for a in old.iter().filter(|a| !key(a).is_empty()) {
        match (0..new.len()).find(|&j| !used[j] && key(&new[j]) == key(a)) {
            Some(j) => {
                used[j] = true;
                matched.push(j);
                if *a != new[j] {
                    edited.push(format!("{one} changed: {}", key(a)));
                }
            }
            None => removed.push(format!("{one} removed: {}", key(a))),
        }
    }
    let added = (0..new.len())
        .filter(|&j| !used[j] && !key(&new[j]).is_empty())
        .map(|j| format!("{one} added: {}", key(&new[j])));
    let mut out: Vec<String> = added.chain(removed).chain(edited).collect();
    if out.is_empty() && old != new {
        out.push(if matched.windows(2).any(|w| w[0] > w[1]) {
            format!("Order of {} changed", many.to_lowercase())
        } else {
            format!("{many} changed")
        });
    }
    out
}

/// "Part added: <title>", "Part removed: <title>" and "Order of parts changed"; a renamed part
/// keeps its place.
fn part_changes(
    old: &[String],
    new: &[String],
    renames: &HashMap<String, String>,
    old_title: &dyn Fn(&str) -> String,
    new_title: &dyn Fn(&str) -> String,
) -> Vec<String> {
    let moved: Vec<&str> = old.iter().map(|p| renames.get(p).unwrap_or(p).as_str()).collect();
    let before: HashSet<&str> = moved.iter().copied().collect();
    let after: HashSet<&str> = new.iter().map(String::as_str).collect();
    let mut out: Vec<String> = new
        .iter()
        .filter(|p| !before.contains(p.as_str()))
        .map(|p| format!("Part added: {}", new_title(p)))
        .collect();
    for (file, now) in old.iter().zip(&moved) {
        if !after.contains(now) {
            out.push(format!("Part removed: {}", old_title(file)));
        }
    }
    let kept_before: Vec<&str> = moved.iter().copied().filter(|p| after.contains(p)).collect();
    let kept_after: Vec<&str> = new.iter().map(String::as_str).filter(|p| before.contains(p)).collect();
    if kept_before != kept_after {
        out.push("Order of parts changed".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use git2::{IndexAddOption, Signature};

    use super::*;
    use crate::project::{self, Author};

    fn segment(kind: SegmentKind, text: &str) -> DiffSegment {
        DiffSegment { kind, text: text.into() }
    }

    fn rebuilt(segments: &[DiffSegment], skip: SegmentKind) -> String {
        segments.iter().filter(|s| s.kind != skip).map(|s| s.text.as_str()).collect()
    }

    fn assert_word_diff(old: &str, new: &str, expected: &[DiffSegment]) {
        let segments = word_diff(old, new);
        assert_eq!(segments, expected);
        assert_eq!(rebuilt(&segments, SegmentKind::Insert), old);
        assert_eq!(rebuilt(&segments, SegmentKind::Delete), new);
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().to_path_buf();
            Repository::init(&dir).unwrap();
            Fixture { _tmp: tmp, dir }
        }

        fn write(&self, file: &str, content: impl AsRef<[u8]>) {
            let path = self.dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        fn remove(&self, file: &str) {
            std::fs::remove_file(self.dir.join(file)).unwrap();
        }

        fn meta(&self, parts: &[&str], edit: impl FnOnce(&mut PaperMeta)) {
            let mut meta = PaperMeta { parts: parts.iter().map(|p| p.to_string()).collect(), ..PaperMeta::default() };
            edit(&mut meta);
            project::write_meta(&self.dir, &meta).unwrap();
        }

        /// Commits the working copy on HEAD and returns the commit id.
        fn commit(&self) -> String {
            let repo = Repository::open(&self.dir).unwrap();
            let mut index = repo.index().unwrap();
            index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
            index.update_all(["*"], None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = Signature::now("Test", "test@example.com").unwrap();
            let parent = repo.head().ok().map(|h| h.peel_to_commit().unwrap());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, "snapshot", &tree, &parents).unwrap().to_string()
        }

        fn diff(&self, from: &str, to: Option<&str>) -> VersionDiff {
            diff(&self.dir, from, to).unwrap()
        }
    }

    fn descriptions(meta: &[MetaChange]) -> Vec<(&str, &str)> {
        meta.iter().map(|m| (m.field.as_str(), m.description.as_str())).collect()
    }

    const PARAGRAPH: &str = "Large language models are trained on vast corpora of text, and their behaviour \
        depends on the data they see.\n\nThe second paragraph stays as it was.\n";

    #[test]
    fn tokenizes_words_whitespace_and_marks() {
        assert_eq!(
            tokenize("## Intro, *très*  ok\n\n[@knuth84]"),
            ["#", "#", " ", "Intro", ",", " ", "*", "très", "*", "  ", "ok", "\n\n", "[", "@", "knuth84", "]"]
        );
    }

    #[test]
    fn a_one_word_edit_is_one_delete_and_one_insert() {
        use SegmentKind::*;
        assert_word_diff(
            PARAGRAPH,
            &PARAGRAPH.replace("vast", "huge"),
            &[
                segment(Equal, "Large language models are trained on "),
                segment(Delete, "vast"),
                segment(Insert, "huge"),
                segment(Equal, &PARAGRAPH["Large language models are trained on vast".len()..]),
            ],
        );
    }

    #[test]
    fn adjacent_word_edits_join_into_one_change() {
        use SegmentKind::*;
        assert_word_diff(
            "the cat sat on the mat",
            "a dog sat on the mat",
            &[segment(Delete, "the cat"), segment(Insert, "a dog"), segment(Equal, " sat on the mat")],
        );
    }

    #[test]
    fn markdown_marks_stay_out_of_the_changed_word() {
        use SegmentKind::*;
        assert_word_diff(
            "Some **bold** claim.",
            "Some **strong** claim.",
            &[
                segment(Equal, "Some **"),
                segment(Delete, "bold"),
                segment(Insert, "strong"),
                segment(Equal, "** claim."),
            ],
        );
        assert_word_diff("", "", &[]);
        assert_word_diff("", "# New\n", &[segment(Insert, "# New\n")]);
    }

    #[test]
    fn parts_added_deleted_and_edited_in_document_order() {
        let f = Fixture::new();
        f.write("sections/intro.md", "# Introduction\n\nWe study things.\n");
        f.write("sections/method.md", "# Method\n\nWe measure.\n");
        f.write("sections/notes.md", "# Old notes\n\nScratch.\n");
        f.meta(&["sections/intro.md", "sections/method.md", "sections/notes.md"], |_| {});
        let v1 = f.commit();
        f.write("sections/results.md", "# Results\n\nIt works.\n");
        f.write("sections/intro.md", "# Introduction\n\nWe study many things.\n");
        f.remove("sections/notes.md");
        f.meta(&["sections/results.md", "sections/intro.md", "sections/method.md"], |_| {});
        let v2 = f.commit();

        let d = f.diff(&v1, Some(&v2));
        assert_eq!((d.from.as_str(), d.to.as_deref()), (v1.as_str(), Some(v2.as_str())));
        let summary: Vec<_> = d.parts.iter().map(|p| (p.file.as_str(), p.title.as_str(), p.status)).collect();
        assert_eq!(
            summary,
            [
                ("sections/results.md", "Results", ChangeStatus::Added),
                ("sections/intro.md", "Introduction", ChangeStatus::Modified),
                ("sections/notes.md", "Old notes", ChangeStatus::Deleted),
            ]
        );
        assert_eq!(d.parts[0].segments, [segment(SegmentKind::Insert, "# Results\n\nIt works.\n")]);
        let intro = &d.parts[1].segments;
        assert_eq!(rebuilt(intro, SegmentKind::Delete), "# Introduction\n\nWe study many things.\n");
        assert_eq!(intro.iter().filter(|s| s.kind != SegmentKind::Equal).count(), 1);
        assert_eq!(d.parts[2].segments, [segment(SegmentKind::Delete, "# Old notes\n\nScratch.\n")]);
        assert_eq!(descriptions(&d.meta), [("parts", "Part added: Results"), ("parts", "Part removed: Old notes")]);
        assert!(d.bib.is_empty() && d.files.is_empty());
    }

    #[test]
    fn renamed_parts_are_detected() {
        let f = Fixture::new();
        let method = format!("# Method\n\n{PARAGRAPH}");
        f.write("sections/intro.md", "# Introduction\n");
        f.write("sections/method.md", &method);
        f.meta(&["sections/intro.md", "sections/method.md"], |_| {});
        let v1 = f.commit();
        f.remove("sections/method.md");
        f.write("sections/methods.md", method.replace("vast", "huge"));
        f.meta(&["sections/intro.md", "sections/methods.md"], |_| {});
        let v2 = f.commit();

        let d = f.diff(&v1, Some(&v2));
        assert_eq!(d.parts.len(), 1);
        let part = &d.parts[0];
        assert_eq!((part.file.as_str(), part.old_file.as_deref()), ("sections/methods.md", Some("sections/method.md")));
        assert_eq!((part.status, part.title.as_str()), (ChangeStatus::Renamed, "Method"));
        let changed: Vec<_> = part.segments.iter().filter(|s| s.kind != SegmentKind::Equal).collect();
        assert_eq!(changed, [&segment(SegmentKind::Delete, "vast"), &segment(SegmentKind::Insert, "huge")]);
        assert!(d.meta.is_empty(), "a renamed part is neither added nor removed: {:?}", d.meta);
    }

    #[test]
    fn compares_with_the_working_copy_without_touching_the_index() {
        let f = Fixture::new();
        f.write("sections/intro.md", "# Introduction\n\nDraft.\n");
        f.meta(&["sections/intro.md"], |_| {});
        let v1 = f.commit();
        f.write("sections/intro.md", "# Introduction\n\nFinal.\n");
        f.write("figures/new.png", [0x89, b'P', b'N', b'G', 0, 0, 0, 13]);

        let d = f.diff(&v1, None);
        assert_eq!(d.to, None);
        assert_eq!(d.parts.len(), 1);
        assert_eq!(d.parts[0].status, ChangeStatus::Modified);
        assert!(d.parts[0].segments.contains(&segment(SegmentKind::Insert, "Final")));
        let figure = FileChange { path: "figures/new.png".into(), old_path: None, status: ChangeStatus::Added };
        assert_eq!(d.files, [figure]);
        let index = Repository::open(&f.dir).unwrap().index().unwrap();
        assert!(index.get_path(Path::new("figures/new.png"), 0).is_none());

        let same = f.diff("HEAD", Some(&v1[..8]));
        assert_eq!((same.from.as_str(), same.to.as_deref()), (v1.as_str(), Some(v1.as_str())));
        assert!(same.parts.is_empty() && same.meta.is_empty() && same.bib.is_empty() && same.files.is_empty());
        assert!(diff(&f.dir, "nope", None).unwrap_err().contains("Unknown version"));
    }

    #[test]
    fn meta_changes_read_as_plain_language() {
        let ada = Author { name: "Ada Lovelace".into(), ..Author::default() };
        let grace = Author { name: "Grace Hopper".into(), ..Author::default() };
        let a = PaperMeta {
            title: "Old".into(),
            authors: vec![ada.clone()],
            keywords: vec!["graphs".into()],
            parts: vec!["a.md".into(), "b.md".into(), "c.md".into()],
            ..PaperMeta::default()
        };
        let mut b = PaperMeta {
            title: "New".into(),
            authors: vec![Author { affiliation: "Analytical Engines".into(), ..ada }, grace],
            abstract_text: "We show.".into(),
            keywords: vec!["trees".into()],
            bib_style: "ieee".into(),
            parts: vec!["c.md".into(), "a.md".into(), "d.md".into()],
            toc: true,
            toc_depth: 3,
            class_options: vec!["11pt".into()],
            ..PaperMeta::default()
        };
        b.layout.line_numbers = true;
        let title = |f: &str| f.trim_end_matches(".md").to_uppercase();
        assert_eq!(
            descriptions(&meta_changes(&a, &b, &HashMap::new(), &title, &title)),
            [
                ("title", "Title: “Old” → “New”"),
                ("authors", "Author added: Grace Hopper"),
                ("authors", "Author changed: Ada Lovelace"),
                ("abstract", "Abstract added"),
                ("keywords", "Keyword added: trees"),
                ("keywords", "Keyword removed: graphs"),
                ("bibStyle", "Citation style: the template's default → “ieee”"),
                ("parts", "Part added: D"),
                ("parts", "Part removed: B"),
                ("parts", "Order of parts changed"),
                ("toc", "Table of contents turned on"),
                ("tocDepth", "Table of contents depth: 2 → 3"),
                ("classOptions", "Document class options: none → “11pt”"),
                ("layout", "Page setup changed"),
            ]
        );
    }

    #[test]
    fn reordering_alone_reads_as_an_order_change() {
        let a = PaperMeta { parts: vec!["a.md".into(), "b.md".into()], ..PaperMeta::default() };
        let b = PaperMeta { parts: vec!["b.md".into(), "a.md".into()], ..PaperMeta::default() };
        let title = |f: &str| f.to_string();
        let reordered = meta_changes(&a, &b, &HashMap::new(), &title, &title);
        assert_eq!(descriptions(&reordered), [("parts", "Order of parts changed")]);
        let renames = HashMap::from([("a.md".to_string(), "z.md".to_string())]);
        let c = PaperMeta { parts: vec!["z.md".into(), "b.md".into()], ..PaperMeta::default() };
        assert!(meta_changes(&a, &c, &renames, &title, &title).is_empty());

        let authors = |old: &[&str], new: &[&str]| {
            let named = |names: &[&str]| {
                names.iter().map(|n| Author { name: n.to_string(), ..Author::default() }).collect::<Vec<_>>()
            };
            named_changes(&named(old), &named(new), |x| x.name.as_str(), "Author", "Authors")
        };
        assert_eq!(authors(&["A", "B"], &["B", "A"]), ["Order of authors changed"]);
        assert_eq!(authors(&["A"], &["A", ""]), ["Authors changed"]);
        assert_eq!(authors(&[""], &["Ada"]), ["Author added: Ada"]);
    }

    #[test]
    fn an_unreadable_paper_json_is_one_settings_change() {
        let f = Fixture::new();
        f.write("sections/intro.md", "# Introduction\n");
        f.meta(&["sections/intro.md"], |m| m.title = "Before".into());
        let v1 = f.commit();
        f.meta(&["sections/intro.md"], |m| m.title = "After".into());
        assert_eq!(descriptions(&f.diff(&v1, None).meta), [("title", "Title: “Before” → “After”")]);
        f.write(META_FILE, "{ \"title\": ");
        f.write("sections/intro.md", "# Introduction\n\nMore.\n");
        let d = f.diff(&v1, None);
        assert_eq!(descriptions(&d.meta), [(WHOLE_META, "Paper settings changed")]);
        assert_eq!(d.parts.len(), 1, "parts under sections/ count without a readable paper.json");
    }

    #[test]
    fn bibliography_changes_by_citation_key() {
        let f = Fixture::new();
        f.meta(&[], |_| {});
        let kept = "@article{kept, title = {Same}}\n";
        f.write(BIB_FILE, format!("{kept}@article{{edited, year = 2020}}\n@book{{gone, year = 1}}\n"));
        let v1 = f.commit();
        let rest = "@article{edited, year = 2021}\n@misc{added, year = 2}\n";
        f.write(BIB_FILE, format!("{kept}{rest}"));
        let v2 = f.commit();
        f.write(BIB_FILE, format!("@article{{kept,\n  title = {{Same}}\n}}\n{rest}"));
        let v3 = f.commit();

        let d = f.diff(&v1, Some(&v2));
        let keys: Vec<_> = d.bib.iter().map(|b| (b.key.as_str(), b.status)).collect();
        assert_eq!(
            keys,
            [("edited", ChangeStatus::Modified), ("added", ChangeStatus::Added), ("gone", ChangeStatus::Deleted)]
        );
        assert!(d.files.is_empty() && d.meta.is_empty());

        let reformatted = f.diff(&v2, Some(&v3));
        assert!(reformatted.bib.is_empty());
        assert_eq!(
            reformatted.files,
            [FileChange { path: BIB_FILE.into(), old_path: None, status: ChangeStatus::Modified }]
        );
    }

    #[test]
    fn figures_and_other_files_are_file_changes() {
        let f = Fixture::new();
        let png = |n: u8| [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, n, 0xff, 0];
        f.meta(&["sections/intro.md"], |_| {});
        f.write("sections/intro.md", "# Introduction\n");
        f.write("figures/plot.png", png(1));
        f.write("figures/old-name.png", png(7));
        let v1 = f.commit();
        f.write("figures/plot.png", png(2));
        f.remove("figures/old-name.png");
        f.write("figures/new-name.png", png(7));
        f.write("preamble.tex", "\\usepackage{siunitx}\n");
        f.write("template/paper.latex", "$body$\n");
        f.write("README.md", "Not a part.\n");
        let v2 = f.commit();

        let d = f.diff(&v1, Some(&v2));
        assert!(d.parts.is_empty() && d.meta.is_empty() && d.bib.is_empty());
        let file = |path: &str, old_path: Option<&str>, status| FileChange {
            path: path.into(),
            old_path: old_path.map(Into::into),
            status,
        };
        assert_eq!(
            d.files,
            [
                file("README.md", None, ChangeStatus::Added),
                file("figures/new-name.png", Some("figures/old-name.png"), ChangeStatus::Renamed),
                file("figures/plot.png", None, ChangeStatus::Modified),
                file("preamble.tex", None, ChangeStatus::Added),
                file("template/paper.latex", None, ChangeStatus::Added),
            ]
        );
    }
}
