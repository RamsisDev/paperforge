//! End-to-end compiles through the real sidecars. Ignored by default because the first run
//! downloads TeX packages; `npm run warm-tex-cache` runs it to seed `resources/tex-cache`.
//!
//! PAPERFORGE_TEX_CACHE overrides the cache directory (default: resources/tex-cache), and
//! PAPERFORGE_PANDOC / PAPERFORGE_TECTONIC / PAPERFORGE_TEMPLATES point the tests at an
//! installed bundle instead of the development sidecars.

use std::path::PathBuf;

use paperforge_lib::compiler::{self, CompileMode, Severity, TEMPLATES, Toolchain};
use paperforge_lib::project;

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

#[tokio::test]
#[ignore = "runs the TeX toolchain; may download packages"]
async fn every_template_compiles_the_sample() {
    let tc = toolchain();
    std::fs::create_dir_all(&tc.tex_cache).unwrap();
    let sample = manifest().join("resources/sample");

    for template in TEMPLATES {
        for language in ["en", "es"] {
            let tmp = tempfile::tempdir().unwrap();
            project::create(tmp.path(), Some(&sample)).unwrap();
            let mut meta = project::read_meta(tmp.path()).unwrap();
            meta.template = template.into();
            meta.language = language.into();
            project::save(tmp.path(), Some(&meta), None, None).unwrap();

            let outcome = compiler::compile(&tc, tmp.path(), CompileMode::Full).await.unwrap();
            let errors: Vec<_> =
                outcome.diagnostics.iter().filter(|d| d.severity == Severity::Error).collect();
            assert!(outcome.ok, "{template}/{language} failed: {errors:#?}");
            let undefined: Vec<_> = outcome
                .diagnostics
                .iter()
                .filter(|d| d.message.contains("undefined"))
                .collect();
            assert!(undefined.is_empty(), "{template}/{language} unresolved: {undefined:#?}");
            println!(
                "{template:<9} {language}  pandoc {:>4} ms  tex {:>5} ms  network={}",
                outcome.pandoc_ms, outcome.tex_ms, outcome.used_network
            );
        }
    }
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn preview_after_an_edit_is_one_pass_with_references_resolved() {
    let tc = toolchain();
    let sample = manifest().join("resources/sample");
    for template in TEMPLATES {
        let tmp = tempfile::tempdir().unwrap();
        project::create(tmp.path(), Some(&sample)).unwrap();
        let mut meta = project::read_meta(tmp.path()).unwrap();
        meta.template = template.into();
        project::save(tmp.path(), Some(&meta), None, None).unwrap();

        let full = compiler::compile(&tc, tmp.path(), CompileMode::Full).await.unwrap();
        assert!(full.ok, "{template}: {:#?}", full.diagnostics);

        let body = std::fs::read_to_string(tmp.path().join(project::BODY_FILE)).unwrap();
        let edited = body.replace("Lists, *emphasis*", "Edited lists, *emphasis*");
        project::save(tmp.path(), None, Some(&edited), None).unwrap();
        let preview = compiler::compile(&tc, tmp.path(), CompileMode::Preview).await.unwrap();

        assert!(preview.ok, "{template}: {:#?}", preview.diagnostics);
        assert!(!preview.needs_rerun, "{template}: an unchanged label set needs no rerun");
        assert!(
            !preview.diagnostics.iter().any(|d| d.message.contains("undefined")),
            "{template}: {:#?}",
            preview.diagnostics
        );
        println!("{template:<9} full tex {:>5} ms   preview tex {:>5} ms", full.tex_ms, preview.tex_ms);
    }
}

/// LaTeX needs two passes after BibTeX for a new citation: one to read the .bbl into the .aux,
/// one to use it. The editor follows `needs_rerun`, so previews must converge within three.
#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn new_citation_in_preview_converges_by_following_reruns() {
    let tc = toolchain();
    let tmp = tempfile::tempdir().unwrap();
    project::create(tmp.path(), Some(&manifest().join("resources/sample"))).unwrap();
    assert!(compiler::compile(&tc, tmp.path(), CompileMode::Full).await.unwrap().ok);

    let body = std::fs::read_to_string(tmp.path().join(project::BODY_FILE)).unwrap();
    let body = body.replace("[@knuth1984; @lamport1994]", "[@knuth1984]");
    project::save(tmp.path(), None, Some(&body), None).unwrap();
    assert!(compiler::compile(&tc, tmp.path(), CompileMode::Full).await.unwrap().ok);

    let body = body.replace("[@knuth1984]", "[@knuth1984; @lamport1994]");
    project::save(tmp.path(), None, Some(&body), None).unwrap();
    let first = compiler::compile(&tc, tmp.path(), CompileMode::Preview).await.unwrap();
    assert!(first.ok && first.needs_rerun, "{first:#?}");
    let mut passes = 1;
    let mut last = first;
    while last.needs_rerun {
        assert!(passes < 3, "previews did not converge: {last:#?}");
        last = compiler::compile(&tc, tmp.path(), CompileMode::Preview).await.unwrap();
        passes += 1;
    }
    assert!(last.ok, "{last:#?}");
    assert!(!last.diagnostics.iter().any(|d| d.message.contains("undefined")), "{last:#?}");
}

/// The app aborts a running compile when the user keeps typing; the abort must kill TeX and
/// leave a build directory the next compile can use.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs the TeX toolchain"]
async fn aborted_compile_kills_tex_and_leaves_a_usable_build() {
    let tc = toolchain();
    let tmp = tempfile::tempdir().unwrap();
    project::create(tmp.path(), Some(&manifest().join("resources/sample"))).unwrap();
    let mut meta = project::read_meta(tmp.path()).unwrap();
    meta.template = "acm".into();
    project::save(tmp.path(), Some(&meta), None, None).unwrap();

    let dir = tmp.path().to_path_buf();
    let tc2 = tc.clone();
    let task = tokio::spawn(async move { compiler::compile(&tc2, &dir, CompileMode::Full).await });
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let marker = tmp.path().to_string_lossy().into_owned();
    let ps = std::process::Command::new("ps").args(["-axo", "command"]).output().unwrap();
    let survivors: Vec<_> = String::from_utf8_lossy(&ps.stdout)
        .lines()
        .filter(|l| l.contains("tectonic") && l.contains(&marker))
        .map(str::to_string)
        .collect();
    assert!(survivors.is_empty(), "TeX kept running after abort: {survivors:?}");

    let after = compiler::compile(&tc, tmp.path(), CompileMode::Preview).await.unwrap();
    assert!(after.ok, "{:#?}", after.diagnostics);
}

#[tokio::test]
#[ignore = "runs the TeX toolchain"]
async fn latex_errors_point_at_the_tex_line() {
    let tc = toolchain();
    let tmp = tempfile::tempdir().unwrap();
    project::create(tmp.path(), None).unwrap();
    project::save(tmp.path(), None, Some("# Intro\n\nSome text \\undefinedmacro here.\n"), None)
        .unwrap();

    let outcome = compiler::compile(&tc, tmp.path(), CompileMode::Preview).await.unwrap();
    assert!(!outcome.ok);
    let error = outcome.diagnostics.iter().find(|d| d.severity == Severity::Error).unwrap();
    assert!(error.message.contains("Undefined control sequence"), "{error:?}");
    assert!(error.source.as_deref().unwrap().contains("\\undefinedmacro"), "{error:?}");
}
