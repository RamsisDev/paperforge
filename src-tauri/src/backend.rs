//! State and behavior shared by the desktop app (Tauri IPC) and the browser dev server (HTTP).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::OnceCell;
use tokio::task::AbortHandle;

use crate::bibfetch;
use crate::compiler::{self, CompileMode, CompileOutcome, Toolchain};
use crate::history;
use crate::project::{self, PaperMeta};
use crate::review;
use crate::showlatex;
use crate::synctex::{self, PdfBox, SourceSpot, SyncTex};
use crate::zotero;

pub struct Backend {
    pub toolchain: Toolchain,
    pub seed_cache: Option<PathBuf>,
    pub sample_dir: PathBuf,
    /// Project folder to open at startup, from the command line.
    pub startup_project: Option<String>,
    /// The bundled TeX cache is copied to a writable location once, before the first compile.
    cache_ready: OnceCell<Result<(), String>>,
    /// One compile at a time: a new request aborts the running one.
    running: Mutex<Option<AbortHandle>>,
    build_lock: Arc<tokio::sync::Mutex<()>>,
    /// The last SyncTeX file read, kept until the next compile rewrites it.
    synctex: Mutex<Option<(PathBuf, SystemTime, Arc<SyncTex>)>>,
    /// One lock per project folder, held by writes and history commands, so a snapshot never sees
    /// a half-written multi-file change.
    projects: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// Commands that write the project or read it as a whole; they run under the project lock.
const LOCKED: [&str; 26] = [
    "project_create",
    "project_open",
    "project_save",
    "part_save",
    "part_create",
    "part_delete",
    "parts_reorder",
    "part_split",
    "parts_merge",
    "figure_import",
    "figure_import_bytes",
    "preamble_save",
    "template_eject",
    "template_restore",
    "dictionary_add",
    "zotero_link",
    "history_status",
    "history_enable",
    "history_autosave",
    "history_save_version",
    "history_list",
    "history_label",
    "history_diff",
    "history_read_part",
    "history_restore",
    "history_restore_part",
];

/// Runs blocking work (git, file trees) off the async runtime.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Records an autosave before a command that rewrites or removes parts. A project without history
/// is not affected; a failing snapshot stops the command, so nothing is lost unrecorded.
fn autosave_before(dir: &Path, action: &str, files: &[String]) -> Result<(), String> {
    let titles: Vec<String> = files
        .iter()
        .map(|f| {
            let content = project::read_optional(&dir.join(f)).unwrap_or_default();
            format!("“{}”", history::part_title(&content, f))
        })
        .collect();
    let reason = format!("Before {action} {}", titles.join(" and "));
    history::autosave(dir, Some(&reason)).map(|_| ()).map_err(|e| format!("Could not save a snapshot first: {e}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pandoc: String,
    tectonic: String,
    tex_cache: String,
    bundle_url: &'static str,
}

/// A command result: JSON, or raw bytes for files.
pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

/// Copies files the user's cache does not have yet; never deletes packages fetched later.
fn seed_tex_cache(seed: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| format!("{}: {e}", target.display()))?;
    if !seed.exists() || seed == target {
        return Ok(());
    }
    let mut stack = vec![seed.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let rel = path.strip_prefix(seed).expect("under seed");
            let dest = target.join(rel);
            if path.is_dir() {
                std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                stack.push(path);
            } else if !dest.exists() {
                std::fs::copy(&path, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            }
        }
    }
    Ok(())
}

/// A project folder named on the command line (`paperforge ~/papers/thesis`).
pub fn startup_project_from_args() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    // Not canonicalize: on Windows it yields `\\?\C:\…` paths that TeX tools reject.
    let dir = std::path::absolute(arg).ok()?;
    dir.join(project::META_FILE).exists().then(|| dir.to_string_lossy().into_owned())
}

impl Backend {
    pub fn new(toolchain: Toolchain, seed_cache: Option<PathBuf>, sample_dir: PathBuf) -> Self {
        Self {
            toolchain,
            seed_cache,
            sample_dir,
            startup_project: startup_project_from_args(),
            cache_ready: OnceCell::new(),
            running: Mutex::new(None),
            build_lock: Arc::new(tokio::sync::Mutex::new(())),
            synctex: Mutex::new(None),
            projects: Mutex::new(HashMap::new()),
        }
    }

    fn project_lock(&self, dir: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.projects.lock().unwrap().entry(dir.to_string()).or_default().clone()
    }

    pub async fn ensure_cache(&self) -> Result<(), String> {
        self.cache_ready
            .get_or_init(|| async {
                let seed = self.seed_cache.clone();
                let target = self.toolchain.tex_cache.clone();
                tokio::task::spawn_blocking(move || match seed {
                    Some(seed) => seed_tex_cache(&seed, &target),
                    None => std::fs::create_dir_all(&target).map_err(|e| e.to_string()),
                })
                .await
                .map_err(|e| e.to_string())?
            })
            .await
            .clone()
    }

    pub fn engine_info(&self) -> EngineInfo {
        EngineInfo {
            pandoc: self.toolchain.pandoc.to_string_lossy().into_owned(),
            tectonic: self.toolchain.tectonic.to_string_lossy().into_owned(),
            tex_cache: self.toolchain.tex_cache.to_string_lossy().into_owned(),
            bundle_url: compiler::BUNDLE_URL,
        }
    }

    pub async fn compile(
        &self,
        dir: String,
        mode: CompileMode,
        focus: Option<String>,
        review: bool,
    ) -> Result<CompileOutcome, String> {
        self.ensure_cache().await?;
        let toolchain = self.toolchain.clone();
        let lock = self.build_lock.clone();
        let task = tokio::spawn(async move {
            let _guard = lock.lock().await;
            compiler::compile(&toolchain, Path::new(&dir), mode, focus.as_deref(), review).await
        });
        if let Some(previous) = self.running.lock().unwrap().replace(task.abort_handle()) {
            previous.abort();
        }
        match task.await {
            Ok(outcome) => outcome,
            Err(e) if e.is_cancelled() => Ok(CompileOutcome::cancelled()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// The SyncTeX data of the project's last compile in `build`, `None` before the first one.
    async fn synctex(&self, build: &Path) -> Result<Option<Arc<SyncTex>>, String> {
        let path = build.join(synctex::SYNCTEX_FILE);
        let Ok(modified) = tokio::fs::metadata(&path).await.and_then(|m| m.modified()) else {
            return Ok(None);
        };
        if let Some((cached, at, sync)) = &*self.synctex.lock().unwrap()
            && *cached == path
            && *at == modified
        {
            return Ok(Some(sync.clone()));
        }
        let read = path.clone();
        let sync = Arc::new(
            tokio::task::spawn_blocking(move || SyncTex::read(&read)).await.map_err(|e| e.to_string())??,
        );
        *self.synctex.lock().unwrap() = Some((path, modified, sync.clone()));
        Ok(Some(sync))
    }

    /// The Markdown line typeset at a spot of a PDF page (1-based, PDF points from the top left),
    /// of the final or the review PDF.
    pub async fn synctex_to_source(
        &self,
        dir: &str,
        page: u32,
        x: f64,
        y: f64,
        review: bool,
    ) -> Result<Option<SourceSpot>, String> {
        let dir = Path::new(dir);
        let build = review::build_dir(&project::build_dir(dir), review);
        match self.synctex(&build).await? {
            Some(sync) => synctex::source_at(&sync, dir, &build, page, x, y).await,
            None => Ok(None),
        }
    }

    /// Where a Markdown line (1-based) of a part was typeset in the final or the review PDF.
    pub async fn synctex_to_pdf(&self, dir: &str, part: &str, line: usize, review: bool) -> Result<Option<PdfBox>, String> {
        let dir = Path::new(dir);
        let build = review::build_dir(&project::build_dir(dir), review);
        match self.synctex(&build).await? {
            Some(sync) => synctex::pdf_at(&sync, dir, &build, part, line).await,
            None => Ok(None),
        }
    }

    /// Runs a command by its IPC name with JSON arguments named as the frontend sends them.
    pub async fn dispatch(&self, command: &str, args: Value) -> Result<Reply, String> {
        fn parse<T: DeserializeOwned>(args: Value) -> Result<T, String> {
            serde_json::from_value(args).map_err(|e| format!("bad arguments: {e}"))
        }
        fn json<T: serde::Serialize>(value: T) -> Result<Reply, String> {
            serde_json::to_value(value).map(Reply::Json).map_err(|e| e.to_string())
        }

        #[derive(Deserialize)]
        struct Dir {
            dir: String,
        }
        #[derive(Deserialize)]
        struct Create {
            dir: String,
            template: String,
            title: String,
            language: String,
            sample: bool,
        }
        #[derive(Deserialize)]
        struct Save {
            dir: String,
            meta: Option<PaperMeta>,
            bib: Option<String>,
        }
        #[derive(Deserialize)]
        struct PartSave {
            dir: String,
            file: String,
            content: String,
        }
        #[derive(Deserialize)]
        struct PartCreate {
            dir: String,
            index: usize,
            title: String,
        }
        #[derive(Deserialize)]
        struct PartFile {
            dir: String,
            file: String,
        }
        #[derive(Deserialize)]
        struct Reorder {
            dir: String,
            parts: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Split {
            dir: String,
            file: String,
            level: u8,
        }
        #[derive(Deserialize)]
        struct Merge {
            dir: String,
            files: Vec<String>,
        }
        #[derive(Deserialize)]
        struct FigureImport {
            dir: String,
            source: String,
        }
        #[derive(Deserialize)]
        struct ReadPath {
            path: String,
        }
        #[derive(Deserialize)]
        struct Compile {
            dir: String,
            mode: CompileMode,
            focus: Option<String>,
            #[serde(default)]
            review: bool,
        }
        #[derive(Deserialize)]
        struct Export {
            dir: String,
            dest: String,
            #[serde(default)]
            review: bool,
        }
        #[derive(Deserialize)]
        struct PdfSpot {
            dir: String,
            page: u32,
            x: f64,
            y: f64,
            #[serde(default)]
            review: bool,
        }
        #[derive(Deserialize)]
        struct PartLine {
            dir: String,
            part: String,
            line: usize,
            #[serde(default)]
            review: bool,
        }
        #[derive(Deserialize)]
        struct DictionaryAdd {
            dir: String,
            words: Vec<String>,
        }
        #[derive(Deserialize)]
        struct FigureImportBytes {
            dir: String,
            name: String,
            data: String,
        }
        #[derive(Deserialize)]
        struct PreambleSave {
            dir: String,
            content: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct BibLookup {
            query: String,
            #[serde(default)]
            existing_keys: Vec<String>,
        }
        #[derive(Deserialize)]
        struct ZoteroLink {
            dir: String,
            path: Option<String>,
        }
        #[derive(Deserialize)]
        struct BlockLatexArgs {
            dir: String,
            part: String,
            line: usize,
            content: Option<String>,
        }
        #[derive(Deserialize)]
        struct Autosave {
            dir: String,
            reason: Option<String>,
        }
        #[derive(Deserialize)]
        struct SaveVersion {
            dir: String,
            label: Option<String>,
            note: Option<String>,
            reason: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct HistoryList {
            dir: String,
            #[serde(default)]
            include_autosaves: bool,
            before: Option<String>,
            limit: usize,
        }
        #[derive(Deserialize)]
        struct Label {
            dir: String,
            id: String,
            label: Option<String>,
        }
        #[derive(Deserialize)]
        struct HistoryDiff {
            dir: String,
            from: String,
            to: Option<String>,
        }
        #[derive(Deserialize)]
        struct Version {
            dir: String,
            id: String,
        }
        #[derive(Deserialize)]
        struct VersionFile {
            dir: String,
            id: String,
            file: String,
        }

        let lock = match args.get("dir").and_then(Value::as_str) {
            Some(dir) if LOCKED.contains(&command) => Some(self.project_lock(dir)),
            _ => None,
        };
        let _guard = match &lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };

        match command {
            "engine_info" => json(self.engine_info()),
            "startup_project" => json(&self.startup_project),
            "project_create" => {
                let a: Create = parse(args)?;
                let sample = a.sample.then_some(self.sample_dir.as_path());
                let snapshot = project::create(Path::new(&a.dir), sample, &a.template, &a.title, &a.language)?;
                // A project whose history could not start still opens; the panel offers to enable it.
                let dir = a.dir.clone();
                let _ = blocking(move || history::enable(Path::new(&dir), "Project created")).await;
                json(snapshot)
            }
            "project_open" => json(project::open(Path::new(&parse::<Dir>(args)?.dir))?),
            "project_save" => {
                let a: Save = parse(args)?;
                json(project::save(Path::new(&a.dir), a.meta.as_ref(), a.bib.as_deref())?)
            }
            "part_save" => {
                let a: PartSave = parse(args)?;
                json(project::save_part(Path::new(&a.dir), &a.file, &a.content)?)
            }
            "part_create" => {
                let a: PartCreate = parse(args)?;
                json(project::create_part(Path::new(&a.dir), a.index, &a.title)?)
            }
            "part_delete" => {
                let a: PartFile = parse(args)?;
                let dir = Path::new(&a.dir);
                autosave_before(dir, "deleting", std::slice::from_ref(&a.file))?;
                json(project::delete_part(dir, &a.file)?)
            }
            "parts_reorder" => {
                let a: Reorder = parse(args)?;
                json(project::reorder_parts(Path::new(&a.dir), &a.parts)?)
            }
            "part_split" => {
                let a: Split = parse(args)?;
                let dir = Path::new(&a.dir);
                autosave_before(dir, "splitting", std::slice::from_ref(&a.file))?;
                json(project::split_part(dir, &a.file, a.level)?)
            }
            "parts_merge" => {
                let a: Merge = parse(args)?;
                let dir = Path::new(&a.dir);
                autosave_before(dir, "merging", &a.files)?;
                json(project::merge_parts(dir, &a.files)?)
            }
            "figure_import" => {
                let a: FigureImport = parse(args)?;
                json(project::import_figure(Path::new(&a.dir), Path::new(&a.source))?)
            }
            "figure_list" => json(project::list_figures(Path::new(&parse::<Dir>(args)?.dir))),
            "read_binary" => {
                let path = parse::<ReadPath>(args)?.path;
                tokio::fs::read(&path).await.map(Reply::Bytes).map_err(|e| format!("{path}: {e}"))
            }
            "read_tex" => {
                let dir = parse::<Dir>(args)?.dir;
                json(compiler::flatten_tex(Path::new(&dir)).await?)
            }
            "compile" => {
                let a: Compile = parse(args)?;
                json(self.compile(a.dir, a.mode, a.focus, a.review).await?)
            }
            "export_pdf" => {
                let a: Export = parse(args)?;
                let pdf = review::build_dir(&project::build_dir(Path::new(&a.dir)), a.review).join("paper.pdf");
                tokio::fs::copy(&pdf, &a.dest).await.map_err(|e| format!("{}: {e}", a.dest))?;
                json(())
            }
            "export_zip" => {
                let a: Export = parse(args)?;
                tokio::task::spawn_blocking(move || project::export_zip(Path::new(&a.dir), Path::new(&a.dest)))
                    .await
                    .map_err(|e| e.to_string())??;
                json(())
            }
            "synctex_to_source" => {
                let a: PdfSpot = parse(args)?;
                json(self.synctex_to_source(&a.dir, a.page, a.x, a.y, a.review).await?)
            }
            "synctex_to_pdf" => {
                let a: PartLine = parse(args)?;
                json(self.synctex_to_pdf(&a.dir, &a.part, a.line, a.review).await?)
            }
            "dictionary_read" => json(project::read_dictionary(Path::new(&parse::<Dir>(args)?.dir))?),
            "dictionary_add" => {
                let a: DictionaryAdd = parse(args)?;
                json(project::add_to_dictionary(Path::new(&a.dir), &a.words)?)
            }
            "figure_import_bytes" => {
                let a: FigureImportBytes = parse(args)?;
                json(project::import_figure_bytes(Path::new(&a.dir), &a.name, &a.data)?)
            }
            "preamble_save" => {
                let a: PreambleSave = parse(args)?;
                json(project::save_preamble(Path::new(&a.dir), &a.content)?)
            }
            "template_eject" => {
                let dir = parse::<Dir>(args)?.dir;
                json(project::eject_template(Path::new(&dir), &self.toolchain.templates)?)
            }
            "template_restore" => json(project::restore_template(Path::new(&parse::<Dir>(args)?.dir))?),
            "bib_lookup" => {
                let a: BibLookup = parse(args)?;
                json(bibfetch::lookup(&a.query, &a.existing_keys).await?)
            }
            "zotero_linked" => json(zotero::linked(Path::new(&parse::<Dir>(args)?.dir))?),
            "zotero_link" => {
                let a: ZoteroLink = parse(args)?;
                json(zotero::link(Path::new(&a.dir), a.path.as_deref())?)
            }
            "zotero_read" => json(zotero::read_linked(Path::new(&parse::<Dir>(args)?.dir))?),
            // Over HTTP there is no way to push the change event; the browser syncs by hand.
            "zotero_watch" => {
                parse::<Dir>(args)?;
                json(false)
            }
            "block_latex" => {
                let a: BlockLatexArgs = parse(args)?;
                json(showlatex::block_latex(Path::new(&a.dir), &a.part, a.line, a.content).await?)
            }
            "history_status" => {
                let dir = parse::<Dir>(args)?.dir;
                json(blocking(move || history::status(Path::new(&dir))).await?)
            }
            "history_enable" => {
                let dir = parse::<Dir>(args)?.dir;
                json(blocking(move || history::enable(Path::new(&dir), "Version history enabled")).await?)
            }
            "history_autosave" => {
                let a: Autosave = parse(args)?;
                json(blocking(move || history::autosave(Path::new(&a.dir), a.reason.as_deref())).await?)
            }
            "history_save_version" => {
                let a: SaveVersion = parse(args)?;
                json(
                    blocking(move || {
                        history::save_version(Path::new(&a.dir), a.label.as_deref(), a.note.as_deref(), a.reason.as_deref())
                    })
                    .await?,
                )
            }
            "history_list" => {
                let a: HistoryList = parse(args)?;
                json(
                    blocking(move || history::list(Path::new(&a.dir), a.include_autosaves, a.before.as_deref(), a.limit))
                        .await?,
                )
            }
            "history_label" => {
                let a: Label = parse(args)?;
                json(blocking(move || history::label(Path::new(&a.dir), &a.id, a.label.as_deref())).await?)
            }
            "history_diff" => {
                let a: HistoryDiff = parse(args)?;
                json(blocking(move || history::diff(Path::new(&a.dir), &a.from, a.to.as_deref())).await?)
            }
            "history_read_part" => {
                let a: VersionFile = parse(args)?;
                json(blocking(move || history::read_part(Path::new(&a.dir), &a.id, &a.file)).await?)
            }
            "history_restore" => {
                let a: Version = parse(args)?;
                json(blocking(move || history::restore(Path::new(&a.dir), &a.id)).await?)
            }
            "history_restore_part" => {
                let a: VersionFile = parse(args)?;
                json(blocking(move || history::restore_part(Path::new(&a.dir), &a.id, &a.file)).await?)
            }
            other => Err(format!("unknown command '{other}'")),
        }
    }
}

/// Every command the frontend may call; the desktop handler list and `dispatch` must both cover it.
pub const COMMANDS: [&str; 42] = [
    "engine_info",
    "startup_project",
    "project_create",
    "project_open",
    "project_save",
    "part_save",
    "part_create",
    "part_delete",
    "parts_reorder",
    "part_split",
    "parts_merge",
    "figure_import",
    "figure_list",
    "read_binary",
    "read_tex",
    "compile",
    "export_pdf",
    "export_zip",
    "synctex_to_source",
    "synctex_to_pdf",
    "dictionary_read",
    "dictionary_add",
    "figure_import_bytes",
    "preamble_save",
    "template_eject",
    "template_restore",
    "bib_lookup",
    "zotero_linked",
    "zotero_link",
    "zotero_read",
    "zotero_watch",
    "block_latex",
    "history_status",
    "history_enable",
    "history_autosave",
    "history_save_version",
    "history_list",
    "history_label",
    "history_diff",
    "history_read_part",
    "history_restore",
    "history_restore_part",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn backend() -> Backend {
        let tmp = std::env::temp_dir();
        Backend::new(
            Toolchain {
                pandoc: tmp.join("pandoc"),
                tectonic: tmp.join("tectonic"),
                templates: tmp.join("templates"),
                tex_cache: tmp.join("tex-cache"),
            },
            None,
            tmp.join("sample"),
        )
    }

    #[tokio::test]
    async fn dispatch_knows_every_command() {
        let backend = backend();
        for command in COMMANDS {
            let err = match backend.dispatch(command, serde_json::json!({})).await {
                Ok(_) => continue,
                Err(e) => e,
            };
            assert!(!err.starts_with("unknown command"), "{command}: {err}");
        }
        assert!(backend.dispatch("nope", serde_json::json!({})).await.is_err());
    }

    #[tokio::test]
    async fn dispatch_round_trips_a_blank_project() {
        let backend = backend();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let created = backend
            .dispatch(
                "project_create",
                serde_json::json!({"dir": dir, "template": "report", "title": "T", "language": "es", "sample": false}),
            )
            .await
            .unwrap();
        let Reply::Json(snapshot) = created else { panic!("expected JSON") };
        assert_eq!(snapshot["meta"]["template"], "report");
        let file = snapshot["parts"][0]["file"].as_str().unwrap().to_string();
        backend
            .dispatch("part_save", serde_json::json!({"dir": dir, "file": file, "content": "# Hola"}))
            .await
            .unwrap();
        let Reply::Json(opened) = backend.dispatch("project_open", serde_json::json!({"dir": dir})).await.unwrap()
        else {
            panic!("expected JSON")
        };
        assert_eq!(opened["parts"][0]["content"], "# Hola");
    }

    #[tokio::test]
    async fn dispatch_round_trips_history() {
        let backend = backend();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let call = |command: &'static str, args: Value| {
            let backend = &backend;
            async move {
                match backend.dispatch(command, args).await {
                    Ok(Reply::Json(value)) => value,
                    Ok(Reply::Bytes(_)) => panic!("{command}: expected JSON"),
                    Err(e) => panic!("{command}: {e}"),
                }
            }
        };
        let created = call(
            "project_create",
            serde_json::json!({"dir": dir, "template": "article", "title": "T", "language": "en", "sample": false}),
        )
        .await;
        let file = created["parts"][0]["file"].as_str().unwrap().to_string();
        let status = call("history_status", serde_json::json!({"dir": dir})).await;
        assert_eq!((status["enabled"].clone(), status["mode"].clone()), (Value::Bool(true), "own".into()));
        assert_eq!(status["lastVersion"]["summary"], "Project created");

        call("part_save", serde_json::json!({"dir": dir, "file": file, "content": "# Hola\n\nUno.\n"})).await;
        let autosave = call("history_autosave", serde_json::json!({"dir": dir, "reason": null})).await;
        assert_eq!(autosave["kind"], "autosave");
        assert_eq!(autosave["summary"], "Edited: Hola");
        let version = call(
            "history_save_version",
            serde_json::json!({"dir": dir, "label": "Draft", "note": null, "reason": null}),
        )
        .await;
        assert_eq!((version["kind"].clone(), version["label"].clone()), ("version".into(), "Draft".into()));

        call("part_save", serde_json::json!({"dir": dir, "file": file, "content": "# Hola\n\nDos.\n"})).await;
        let list = call(
            "history_list",
            serde_json::json!({"dir": dir, "includeAutosaves": true, "before": null, "limit": 10}),
        )
        .await;
        let summaries: Vec<&str> = list.as_array().unwrap().iter().map(|v| v["summary"].as_str().unwrap()).collect();
        assert_eq!(summaries, ["Edited: Hola", "Edited: Hola", "Project created"]);
        assert_eq!(list[0]["id"], version["id"]);

        let restored = call("history_restore", serde_json::json!({"dir": dir, "id": version["id"]})).await;
        assert_eq!(restored["parts"][0]["content"], "# Hola\n\nUno.\n");
        let list = call(
            "history_list",
            serde_json::json!({"dir": dir, "includeAutosaves": true, "before": null, "limit": 2}),
        )
        .await;
        assert_eq!(list[0]["kind"], "autosave");
        assert!(list[0]["summary"].as_str().unwrap().starts_with("Before restoring the version of "));
        assert_eq!(list[1]["id"], version["id"]);
    }
}
