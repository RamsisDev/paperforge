pub mod compiler;
pub mod project;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};
use tokio::sync::OnceCell;
use tokio::task::AbortHandle;

use compiler::{CompileMode, CompileOutcome, Toolchain};
use project::{PaperMeta, ProjectSnapshot};

struct AppState {
    toolchain: Toolchain,
    seed_cache: PathBuf,
    sample_dir: PathBuf,
    /// The bundled TeX cache is copied to a writable location once, before the first compile.
    cache_ready: OnceCell<Result<(), String>>,
    /// One compile per window at a time: a new request aborts the running one.
    running: Mutex<Option<AbortHandle>>,
    build_lock: Arc<tokio::sync::Mutex<()>>,
}

fn sidecar(name: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    let dir = exe.parent().expect("exe dir");
    dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() })
}

/// Copies files the user's cache does not have yet; never deletes packages fetched later.
fn seed_tex_cache(seed: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| format!("{}: {e}", target.display()))?;
    if !seed.exists() {
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

impl AppState {
    async fn ensure_cache(&self) -> Result<(), String> {
        self.cache_ready
            .get_or_init(|| async {
                let seed = self.seed_cache.clone();
                let target = self.toolchain.tex_cache.clone();
                tokio::task::spawn_blocking(move || seed_tex_cache(&seed, &target))
                    .await
                    .map_err(|e| e.to_string())?
            })
            .await
            .clone()
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    pandoc: String,
    tectonic: String,
    tex_cache: String,
    bundle_url: &'static str,
}

#[tauri::command]
async fn engine_info(state: State<'_, AppState>) -> Result<EngineInfo, String> {
    Ok(EngineInfo {
        pandoc: state.toolchain.pandoc.to_string_lossy().into_owned(),
        tectonic: state.toolchain.tectonic.to_string_lossy().into_owned(),
        tex_cache: state.toolchain.tex_cache.to_string_lossy().into_owned(),
        bundle_url: compiler::BUNDLE_URL,
    })
}

/// A project folder passed on the command line (`paperforge ~/papers/thesis`).
#[tauri::command]
fn startup_project() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    // Not canonicalize: on Windows it yields `\\?\C:\…` paths that TeX tools reject.
    let dir = std::path::absolute(arg).ok()?;
    dir.join(project::META_FILE).exists().then(|| dir.to_string_lossy().into_owned())
}

#[tauri::command]
async fn project_create(
    state: State<'_, AppState>,
    dir: String,
    template: String,
    title: String,
    language: String,
    sample: bool,
) -> Result<ProjectSnapshot, String> {
    let sample_dir = sample.then_some(state.sample_dir.as_path());
    project::create(Path::new(&dir), sample_dir, &template, &title, &language)
}

#[tauri::command]
async fn project_open(dir: String) -> Result<ProjectSnapshot, String> {
    project::open(Path::new(&dir))
}

#[tauri::command]
async fn project_save(dir: String, meta: Option<PaperMeta>, bib: Option<String>) -> Result<(), String> {
    project::save(Path::new(&dir), meta.as_ref(), bib.as_deref())
}

#[tauri::command]
async fn part_save(dir: String, file: String, content: String) -> Result<(), String> {
    project::save_part(Path::new(&dir), &file, &content)
}

#[tauri::command]
async fn part_create(dir: String, index: usize, title: String) -> Result<ProjectSnapshot, String> {
    project::create_part(Path::new(&dir), index, &title)
}

#[tauri::command]
async fn part_delete(dir: String, file: String) -> Result<ProjectSnapshot, String> {
    project::delete_part(Path::new(&dir), &file)
}

#[tauri::command]
async fn parts_reorder(dir: String, parts: Vec<String>) -> Result<ProjectSnapshot, String> {
    project::reorder_parts(Path::new(&dir), &parts)
}

#[tauri::command]
async fn part_split(dir: String, file: String, level: u8) -> Result<ProjectSnapshot, String> {
    project::split_part(Path::new(&dir), &file, level)
}

#[tauri::command]
async fn parts_merge(dir: String, files: Vec<String>) -> Result<ProjectSnapshot, String> {
    project::merge_parts(Path::new(&dir), &files)
}

#[tauri::command]
async fn figure_import(dir: String, source: String) -> Result<String, String> {
    project::import_figure(Path::new(&dir), Path::new(&source))
}

#[tauri::command]
async fn figure_list(dir: String) -> Vec<String> {
    project::list_figures(Path::new(&dir))
}

#[tauri::command]
async fn read_binary(path: String) -> Result<Response, String> {
    tokio::fs::read(&path).await.map(Response::new).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn read_tex(dir: String) -> Result<String, String> {
    compiler::flatten_tex(&project::build_dir(Path::new(&dir))).await
}

#[tauri::command]
async fn compile(
    state: State<'_, AppState>,
    dir: String,
    mode: CompileMode,
    focus: Option<String>,
) -> Result<CompileOutcome, String> {
    state.ensure_cache().await?;
    let toolchain = state.toolchain.clone();
    let lock = state.build_lock.clone();
    let task = tokio::spawn(async move {
        let _guard = lock.lock().await;
        compiler::compile(&toolchain, Path::new(&dir), mode, focus.as_deref()).await
    });
    if let Some(previous) = state.running.lock().unwrap().replace(task.abort_handle()) {
        previous.abort();
    }
    match task.await {
        Ok(outcome) => outcome,
        Err(e) if e.is_cancelled() => Ok(CompileOutcome::cancelled()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn export_pdf(dir: String, dest: String) -> Result<(), String> {
    let pdf = project::build_dir(Path::new(&dir)).join("paper.pdf");
    tokio::fs::copy(&pdf, &dest).await.map(|_| ()).map_err(|e| format!("{dest}: {e}"))
}

#[tauri::command]
async fn export_zip(dir: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || project::export_zip(Path::new(&dir), Path::new(&dest)))
        .await
        .map_err(|e| e.to_string())?
}

fn build_state(app: &AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let data = app.path().app_local_data_dir()?;
    Ok(AppState {
        toolchain: Toolchain {
            pandoc: sidecar("pandoc"),
            tectonic: sidecar("tectonic"),
            templates: resources.join("templates"),
            tex_cache: data.join("tex-cache"),
        },
        seed_cache: resources.join("tex-cache"),
        sample_dir: resources.join("sample"),
        cache_ready: OnceCell::new(),
        running: Mutex::new(None),
        build_lock: Arc::new(tokio::sync::Mutex::new(())),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(build_state(app.handle())?);
            // Seed the TeX cache while the user is still picking a project.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle.state::<AppState>().ensure_cache().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            startup_project,
            project_create,
            project_open,
            project_save,
            part_save,
            part_create,
            part_delete,
            parts_reorder,
            part_split,
            parts_merge,
            figure_import,
            figure_list,
            read_binary,
            read_tex,
            compile,
            export_pdf,
            export_zip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
