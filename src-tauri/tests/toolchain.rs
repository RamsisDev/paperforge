//! End-to-end compiles through the real sidecars. Ignored by default because the first run
//! downloads TeX packages; `npm run warm-tex-cache` runs it to seed `resources/tex-cache`.
//!
//! PAPERFORGE_TEX_CACHE overrides the cache directory (default: resources/tex-cache), and
//! PAPERFORGE_PANDOC / PAPERFORGE_TECTONIC / PAPERFORGE_TEMPLATES point the tests at an
//! installed bundle instead of the development sidecars.

use std::path::{Path, PathBuf};

use paperforge_lib::backend::Backend;
use paperforge_lib::compiler::{self, CompileMode, CompileOutcome, Severity, TEMPLATES, Toolchain};
use paperforge_lib::project;

const INTRO: &str = "sections/introduction.md";
const METHOD: &str = "sections/method.md";
const CONCLUSION: &str = "sections/conclusion.md";

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn toolchain() -> Toolchain {
    let triple = env!("PAPERFORGE_TARGET_TRIPLE");
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let bin = |name: &str| manifest().join("binaries").join(format!("{name}-{triple}{exe}"));
    let env = |key: &str| std::env::var_os(key).map(PathBuf::from);
    Toolchain {
        pandoc: env("PAPERFORGE_PANDOC").unwrap_or_else(|| bin("pandoc")),
        tectonic: env("PAPERFORGE_TECTONIC").unwrap_or_else(|| bin("tectonic")),
        templates: env("PAPERFORGE_TEMPLATES").unwrap_or_else(|| manifest().join("resources/templates")),
        tex_cache: std::env::var_os("PAPERFORGE_TEX_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| manifest().join("resources/tex-cache")),
    }
}

fn sample_project(template: &str, language: &str) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    project::create(tmp.path(), Some(&manifest().join("resources/sample")), template, "", language)
        .unwrap();
    tmp
}

fn edit_part(dir: &Path, file: &str, edit: impl FnOnce(String) -> String) {
    let content = std::fs::read_to_string(dir.join(file)).unwrap();
    project::save_part(dir, file, &edit(content)).unwrap();
}

fn update_meta(dir: &Path, edit: impl FnOnce(&mut project::PaperMeta)) {
    let mut meta = project::read_meta(dir).unwrap();
    edit(&mut meta);
    project::save(dir, Some(&meta), None).unwrap();
}

async fn compile(dir: &Path, mode: CompileMode, focus: Option<&str>) -> CompileOutcome {
    compiler::compile(&toolchain(), dir, mode, focus).await.unwrap()
}

fn errors(outcome: &CompileOutcome) -> Vec<&compiler::Diagnostic> {
    outcome.diagnostics.iter().filter(|d| d.severity == Severity::Error).collect()
}

fn undefined(outcome: &CompileOutcome) -> Vec<&compiler::Diagnostic> {
    outcome.diagnostics.iter().filter(|d| d.message.contains("undefined")).collect()
}

/// LaTeX records the page count in the .aux as `\gdef \@abspage@last{N}`.
fn page_count(dir: &Path) -> usize {
    let aux = std::fs::read_to_string(project::build_dir(dir).join("paper.aux")).unwrap();
    aux.lines()
        .find_map(|l| l.strip_prefix("\\gdef \\@abspage@last{")?.strip_suffix('}')?.parse().ok())
        .expect("page count in paper.aux")
}

fn top_level_numbers(outcome: &CompileOutcome, level: &str) -> Vec<String> {
    outcome
        .toc
        .iter()
        .filter(|e| e.list == "toc" && e.level == level && !e.number.is_empty())
        .map(|e| e.number.clone())
        .collect()
}

#[tokio::test]
#[ignore = "runs the TeX toolchain; may download packages"]
async fn every_template_compiles_the_sample() {
    std::fs::create_dir_all(toolchain().tex_cache).unwrap();
    for template in TEMPLATES {
        let chapters = template == "report" || template == "book";
        for language in ["en", "es"] {
            let tmp = sample_project(template, language);
            // Spanish runs also print the contents and both lists.
            let printed = language == "es";
            update_meta(tmp.path(), |m| (m.toc, m.lof, m.lot) = (printed, printed, printed));

            let outcome = compile(tmp.path(), CompileMode::Full, None).await;
            assert!(outcome.ok, "{template}/{language} failed: {:#?}", errors(&outcome));
            assert!(undefined(&outcome).is_empty(), "{template}/{language}: {:#?}", undefined(&outcome));
            assert_eq!(outcome.converted_parts, 3);

            let level = if chapters { "chapter" } else { "section" };
            let numbers = top_level_numbers(&outcome, level);
            assert_eq!(numbers.len(), 3, "{template}/{language}: {:#?}", outcome.toc);
            if template != "ieee" {
                assert_eq!(numbers, ["1", "2", "3"], "{template}/{language}");
            }
            let figure = outcome.toc.iter().find(|e| e.list == "lof").expect("a figure entry");
            assert_eq!((figure.level.as_str(), figure.depth), ("figure", 1));
            assert!(figure.title.starts_with("A sample figure"), "{figure:?}");
            let table = outcome.toc.iter().find(|e| e.list == "lot").expect("a table entry");
            assert_eq!(table.title, "Results on the test set.");
            assert!(outcome.toc.iter().all(|e| !e.page.is_empty()), "{:#?}", outcome.toc);

            let toc_file = project::build_dir(tmp.path()).join("paper.toc");
            let toc_text = std::fs::read_to_string(&toc_file).unwrap_or_default();
            assert_eq!(toc_text.contains("contentsline"), printed, "{template}/{language}");
            let tex = std::fs::read_to_string(project::build_dir(tmp.path()).join("paper.tex")).unwrap();
            assert_eq!(tex.contains("\\tableofcontents"), printed, "{template}/{language}");
            println!(
                "{template:<9} {language}  pandoc {:>4} ms  tex {:>5} ms  pages {:>2}  network={}",
                outcome.pandoc_ms,
                outcome.tex_ms,
                page_count(tmp.path()),
                outcome.used_network
            );
        }
    }
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn preview_after_an_edit_reconverts_one_part_with_references_resolved() {
    for template in TEMPLATES {
        let tmp = sample_project(template, "");
        let full = compile(tmp.path(), CompileMode::Full, None).await;
        assert!(full.ok, "{template}: {:#?}", full.diagnostics);

        edit_part(tmp.path(), CONCLUSION, |c| c.replace("Lists, *emphasis*", "Edited lists, *emphasis*"));
        let preview = compile(tmp.path(), CompileMode::Preview, None).await;

        assert!(preview.ok, "{template}: {:#?}", preview.diagnostics);
        assert_eq!(preview.converted_parts, 1, "{template}");
        assert!(!preview.needs_rerun, "{template}: an unchanged label set needs no rerun");
        assert!(undefined(&preview).is_empty(), "{template}: {:#?}", preview.diagnostics);
        let fragment = project::build_dir(tmp.path()).join("part-sections-conclusion.tex");
        assert!(std::fs::read_to_string(fragment).unwrap().contains("Edited lists"));
        println!(
            "{template:<9} full pandoc {:>4} ms tex {:>5} ms   preview pandoc {:>4} ms tex {:>5} ms",
            full.pandoc_ms, full.tex_ms, preview.pandoc_ms, preview.tex_ms
        );
    }
}

/// LaTeX needs two passes after BibTeX for a new citation: one to read the .bbl into the .aux,
/// one to use it. The editor follows `needs_rerun`, so previews must converge within three.
#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn new_citation_in_preview_converges_by_following_reruns() {
    for template in ["ieee", "report"] {
        let tmp = sample_project(template, "");
        assert!(compile(tmp.path(), CompileMode::Full, None).await.ok);

        edit_part(tmp.path(), INTRO, |c| c.replace("[@knuth1984; @lamport1994]", "[@knuth1984]"));
        assert!(compile(tmp.path(), CompileMode::Full, None).await.ok);

        edit_part(tmp.path(), INTRO, |c| c.replace("[@knuth1984]", "[@knuth1984; @lamport1994]"));
        assert_converges(tmp.path(), template).await;
    }
}

async fn assert_converges(dir: &Path, label: &str) {
    let first = compile(dir, CompileMode::Preview, None).await;
    assert!(first.ok && first.needs_rerun, "{label}: {first:#?}");
    let mut passes = 1;
    let mut last = first;
    while last.needs_rerun {
        assert!(passes < 3, "{label}: previews did not converge: {last:#?}");
        last = compile(dir, CompileMode::Preview, None).await;
        passes += 1;
    }
    assert!(last.ok, "{label}: {last:#?}");
    assert!(undefined(&last).is_empty(), "{label}: {last:#?}");
}

/// LaTeX prints nothing when only the table of contents changed, yet the printed table reads the
/// previous pass's .toc.
#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn new_heading_with_printed_toc_requests_a_rerun() {
    let tmp = sample_project("report", "");
    update_meta(tmp.path(), |m| m.toc = true);
    assert!(compile(tmp.path(), CompileMode::Full, None).await.ok);

    edit_part(tmp.path(), METHOD, |c| c.replace("## Results", "## Setup\n\nText.\n\n## Results"));
    assert_converges(tmp.path(), "report toc").await;
    let toc = std::fs::read_to_string(project::build_dir(tmp.path()).join("paper.toc")).unwrap();
    assert!(toc.contains("Setup"), "{toc}");
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn focused_report_preview_compiles_only_that_chapter() {
    let tmp = sample_project("report", "");
    let full = compile(tmp.path(), CompileMode::Full, None).await;
    assert!(full.ok, "{:#?}", full.diagnostics);
    let full_pages = page_count(tmp.path());

    edit_part(tmp.path(), METHOD, |c| c.replace("Inline math", "As @sec:intro and @tbl:results say, inline math"));
    let focused = compile(tmp.path(), CompileMode::Preview, Some(METHOD)).await;
    assert!(focused.ok, "{:#?}", focused.diagnostics);
    assert_eq!(focused.converted_parts, 1);
    assert!(undefined(&focused).is_empty(), "{:#?}", focused.diagnostics);
    let focused_pages = page_count(tmp.path());
    assert!(focused_pages < full_pages, "focused {focused_pages} vs full {full_pages}");
    assert_eq!(top_level_numbers(&focused, "chapter"), ["1", "2", "3"], "{:#?}", focused.toc);
    let tex = std::fs::read_to_string(project::build_dir(tmp.path()).join("paper.tex")).unwrap();
    assert!(tex.contains("\\includeonly{part-sections-method}"));

    let unfocused = compile(tmp.path(), CompileMode::Preview, None).await;
    assert!(unfocused.ok && undefined(&unfocused).is_empty(), "{:#?}", unfocused.diagnostics);
    assert_eq!(unfocused.converted_parts, 0);
    assert_eq!(page_count(tmp.path()), full_pages);

    let article = sample_project("article", "");
    assert!(compile(article.path(), CompileMode::Full, None).await.ok);
    assert!(compile(article.path(), CompileMode::Preview, Some(METHOD)).await.ok);
    let tex = std::fs::read_to_string(project::build_dir(article.path()).join("paper.tex")).unwrap();
    assert!(!tex.contains("\\includeonly"), "focus only applies to chapter templates");
    println!(
        "report full tex {:>5} ms ({full_pages} pages)   focused preview pandoc {:>4} ms tex {:>5} ms \
         ({focused_pages} pages)   unfocused preview tex {:>5} ms",
        full.tex_ms, focused.pandoc_ms, focused.tex_ms, unfocused.tex_ms
    );
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn exported_zip_compiles_from_its_root() {
    let tc = toolchain();
    let tmp = sample_project("book", "es");
    update_meta(tmp.path(), |m| m.toc = true);
    assert!(compile(tmp.path(), CompileMode::Full, None).await.ok);
    assert!(compile(tmp.path(), CompileMode::Preview, Some(METHOD)).await.ok);

    let zip_path = tmp.path().join("export.zip");
    project::export_zip(tmp.path(), &zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
    let mut names: Vec<String> = archive.file_names().map(str::to_string).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "figures/example.png",
            "paper.tex",
            "part-sections-conclusion.tex",
            "part-sections-introduction.tex",
            "part-sections-method.tex",
            "refs.bib",
        ]
    );
    let out = tempfile::tempdir().unwrap();
    archive.extract(out.path()).unwrap();
    let main = std::fs::read_to_string(out.path().join("paper.tex")).unwrap();
    assert!(!main.contains("\\includeonly"));

    let status = std::process::Command::new(&tc.tectonic)
        .current_dir(out.path())
        .env("TECTONIC_CACHE_DIR", &tc.tex_cache)
        .args(["--bundle", compiler::BUNDLE_URL, "--only-cached", "--chatter", "minimal", "paper.tex"])
        .status()
        .unwrap();
    assert!(status.success());
    assert!(out.path().join("paper.pdf").exists());

    let flat = compiler::flatten_tex(&project::build_dir(tmp.path())).await.unwrap();
    assert!(!flat.contains("\\include{") && flat.contains("\\chapter{Method}"), "{flat}");
}

/// The app aborts a running compile when the user keeps typing; the abort must kill TeX and
/// leave a build directory the next compile can use.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs the TeX toolchain"]
async fn aborted_compile_kills_tex_and_leaves_a_usable_build() {
    let tc = toolchain();
    let tmp = sample_project("acm", "");

    let dir = tmp.path().to_path_buf();
    let tc2 = tc.clone();
    let task = tokio::spawn(async move { compiler::compile(&tc2, &dir, CompileMode::Full, None).await });
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let marker = tmp.path().to_string_lossy().into_owned();
    let ps = std::process::Command::new("ps").args(["-axo", "command"]).output().unwrap();
    let survivors: Vec<_> = String::from_utf8_lossy(&ps.stdout)
        .lines()
        .filter(|l| (l.contains("tectonic") || l.contains("pandoc")) && l.contains(&marker))
        .map(str::to_string)
        .collect();
    assert!(survivors.is_empty(), "TeX kept running after abort: {survivors:?}");

    let after = compile(tmp.path(), CompileMode::Preview, None).await;
    assert!(after.ok, "{:#?}", after.diagnostics);
}

const MARCO_TEXT: &str = "# Marco Teorico\n\nAlgun texto Sasdasd\n\n# Subtema\n\nTexto 2\nadasd\n";

fn project_with_marco(template: &str) -> tempfile::TempDir {
    let tmp = sample_project(template, "");
    project::create_part(tmp.path(), usize::MAX, "Marco Teorico").unwrap();
    let part = project::read_meta(tmp.path()).unwrap().parts.pop().unwrap();
    project::save_part(tmp.path(), &part, MARCO_TEXT).unwrap();
    tmp
}

fn toc_entry<'a>(outcome: &'a CompileOutcome, title: &str) -> &'a compiler::TocEntry {
    outcome
        .toc
        .iter()
        .find(|e| e.list == "toc" && e.title == title)
        .unwrap_or_else(|| panic!("no toc entry {title}: {:#?}", outcome.toc))
}

/// In chapter templates a part is one chapter: a second `#` in the same file is a section of it,
/// on the same page, not a new chapter.
#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn later_top_level_headings_of_a_chapter_part_are_its_sections() {
    for template in ["report", "book"] {
        let tmp = project_with_marco(template);
        let outcome = compile(tmp.path(), CompileMode::Full, None).await;
        assert!(outcome.ok, "{template}: {:#?}", errors(&outcome));
        assert_eq!(top_level_numbers(&outcome, "chapter"), ["1", "2", "3", "4"], "{template}");

        let chapter = toc_entry(&outcome, "Marco Teorico");
        let section = toc_entry(&outcome, "Subtema");
        assert_eq!((chapter.level.as_str(), chapter.number.as_str()), ("chapter", "4"), "{template}");
        assert_eq!((section.level.as_str(), section.number.as_str()), ("section", "4.1"), "{template}");
        assert_eq!(section.page, chapter.page, "{template}: {:#?}", outcome.toc);
        let results = toc_entry(&outcome, "Results");
        assert_eq!((results.level.as_str(), results.number.as_str()), ("section", "2.1"), "{template}");
        for e in [chapter, section] {
            println!("{template:<6} {:<8} {:<4} {:<14} page {}", e.level, e.number, e.title, e.page);
        }
    }

    let tmp = project_with_marco("article");
    let outcome = compile(tmp.path(), CompileMode::Full, None).await;
    assert!(outcome.ok, "article: {:#?}", errors(&outcome));
    assert_eq!(top_level_numbers(&outcome, "section"), ["1", "2", "3", "4", "5"], "{:#?}", outcome.toc);
    assert_eq!(toc_entry(&outcome, "Marco Teorico").number, "4");
    assert_eq!(toc_entry(&outcome, "Subtema").number, "5");
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn latex_errors_point_at_the_fragment_line() {
    for template in ["article", "report"] {
        let tmp = tempfile::tempdir().unwrap();
        project::create(tmp.path(), None, template, "", "").unwrap();
        project::save_part(tmp.path(), INTRO, "# Intro\n\nSome text \\undefinedmacro here.\n").unwrap();

        let outcome = compile(tmp.path(), CompileMode::Preview, None).await;
        assert!(!outcome.ok);
        let error = errors(&outcome)[0];
        assert!(error.message.contains("Undefined control sequence"), "{error:?}");
        assert_eq!(error.file.as_deref(), Some("part-sections-introduction.tex"), "{error:?}");
        assert_eq!(error.part.as_deref(), Some(INTRO), "{error:?}");
        assert!(error.source.as_deref().unwrap().contains("\\undefinedmacro"), "{error:?}");
        assert_eq!(error.part_line, Some(3), "{error:?}");

        project::save_part(tmp.path(), INTRO, "# Intro\n\nFixed, see @fig:nope.\n").unwrap();
        let fixed = compile(tmp.path(), CompileMode::Preview, None).await;
        assert!(fixed.ok, "{template}: {:#?}", fixed.diagnostics);
        let warning = fixed.diagnostics.iter().find(|d| d.message.contains("fig:nope")).unwrap();
        assert_eq!(warning.file.as_deref(), Some("part-sections-introduction.tex"), "{warning:?}");
        assert_eq!(warning.part.as_deref(), Some(INTRO), "{warning:?}");
        assert!(warning.source.as_deref().unwrap().contains("\\ref{fig:nope}"), "{warning:?}");
        assert_eq!(warning.part_line, Some(3), "{warning:?}");
    }
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn sample_labels_get_their_numbers_and_pages() {
    for template in ["article", "report"] {
        let tmp = sample_project(template, "");
        let outcome = compile(tmp.path(), CompileMode::Full, None).await;
        assert!(outcome.ok, "{template}: {:#?}", errors(&outcome));
        for key in ["fig:example", "tbl:results", "eq:entropy", "sec:method"] {
            let label = outcome.labels.get(key).unwrap_or_else(|| panic!("{template}: no {key}: {:#?}", outcome.labels));
            assert!(
                label.number.chars().next().is_some_and(|c| c.is_ascii_digit()),
                "{template} {key}: {label:?}"
            );
            assert!(label.page.parse::<u32>().is_ok_and(|p| p >= 1), "{template} {key}: {label:?}");
            println!("{template:<8} {key:<12} {:<4} p. {}", label.number, label.page);
        }
        if template == "report" {
            assert_eq!(outcome.labels["sec:method"].number, "2", "{:#?}", outcome.labels);
            assert!(outcome.labels["fig:example"].number.starts_with("2."), "{:#?}", outcome.labels);
        }
    }
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn synctex_links_markdown_lines_and_pdf_spots_both_ways() {
    for template in ["article", "report"] {
        let tmp = sample_project(template, "");
        let outcome = compile(tmp.path(), CompileMode::Preview, None).await;
        assert!(outcome.ok, "{template}: {:#?}", errors(&outcome));
        let backend = Backend::new(toolchain(), None, manifest().join("resources/sample"));
        let dir = tmp.path().to_str().unwrap();
        for (part, text) in [(INTRO, "Cite with"), (METHOD, "Inline math works"), (METHOD, "Raw LaTeX passes")] {
            let markdown = std::fs::read_to_string(tmp.path().join(part)).unwrap();
            let line = markdown.lines().position(|l| l.contains(text)).unwrap() + 1;
            let spot = backend.synctex_to_pdf(dir, part, line).await.unwrap();
            let spot = spot.unwrap_or_else(|| panic!("{template}: no PDF spot for {part}:{line}"));
            assert!(spot.page >= 1 && spot.height > 0.0, "{template}: {spot:?}");
            let back = backend.synctex_to_source(dir, spot.page, spot.x + 2.0, spot.y + spot.height / 2.0).await;
            let back = back.unwrap().unwrap_or_else(|| panic!("{template}: no source at {spot:?}"));
            assert_eq!((back.part.as_str(), back.line), (part, line), "{template}: {text} at {spot:?}");
        }
        // The title block comes from the metadata, not from a part.
        let title = backend.synctex_to_source(dir, 1, 300.0, 5.0).await.unwrap();
        assert_eq!(title, None, "{template}");
    }
}
