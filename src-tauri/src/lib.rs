pub mod backend;
pub mod bibfetch;
pub mod compiler;
pub mod history;
pub mod layout;
pub mod markers;
pub mod project;
pub mod review;
pub mod showlatex;
pub mod styles;
pub mod synctex;
pub mod zotero;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use backend::{Backend, EngineInfo, Reply};
use bibfetch::Lookup;
use compiler::{CompileMode, CompileOutcome, Toolchain};
use project::PaperMeta;
use serde_json::{Value, json};
use showlatex::BlockLatex;
use synctex::{PdfBox, SourceSpot};

fn sidecar(name: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    let dir = exe.parent().expect("exe dir");
    dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() })
}

#[tauri::command]
async fn engine_info(state: State<'_, Backend>) -> Result<EngineInfo, String> {
    Ok(state.engine_info())
}

#[tauri::command]
fn startup_project(state: State<'_, Backend>) -> Option<String> {
    state.startup_project.clone()
}

/// Runs a command through `Backend::dispatch`, which holds the project lock and records autosaves
/// before destructive structure changes.
async fn delegate(state: &Backend, command: &str, args: Value) -> Result<Value, String> {
    match state.dispatch(command, args).await? {
        Reply::Json(value) => Ok(value),
        Reply::Bytes(_) => Err(format!("{command} returned bytes")),
    }
}

#[tauri::command]
async fn project_create(
    state: State<'_, Backend>,
    dir: String,
    template: String,
    title: String,
    language: String,
    sample: bool,
) -> Result<Value, String> {
    let args = json!({"dir": dir, "template": template, "title": title, "language": language, "sample": sample});
    delegate(&state, "project_create", args).await
}

#[tauri::command]
async fn project_open(state: State<'_, Backend>, dir: String) -> Result<Value, String> {
    delegate(&state, "project_open", json!({"dir": dir})).await
}

#[tauri::command]
async fn project_save(
    state: State<'_, Backend>,
    dir: String,
    meta: Option<PaperMeta>,
    bib: Option<String>,
) -> Result<Value, String> {
    delegate(&state, "project_save", json!({"dir": dir, "meta": meta, "bib": bib})).await
}

#[tauri::command]
async fn part_save(state: State<'_, Backend>, dir: String, file: String, content: String) -> Result<Value, String> {
    delegate(&state, "part_save", json!({"dir": dir, "file": file, "content": content})).await
}

#[tauri::command]
async fn part_create(state: State<'_, Backend>, dir: String, index: usize, title: String) -> Result<Value, String> {
    delegate(&state, "part_create", json!({"dir": dir, "index": index, "title": title})).await
}

#[tauri::command]
async fn part_delete(state: State<'_, Backend>, dir: String, file: String) -> Result<Value, String> {
    delegate(&state, "part_delete", json!({"dir": dir, "file": file})).await
}

#[tauri::command]
async fn parts_reorder(state: State<'_, Backend>, dir: String, parts: Vec<String>) -> Result<Value, String> {
    delegate(&state, "parts_reorder", json!({"dir": dir, "parts": parts})).await
}

#[tauri::command]
async fn part_split(state: State<'_, Backend>, dir: String, file: String, level: u8) -> Result<Value, String> {
    delegate(&state, "part_split", json!({"dir": dir, "file": file, "level": level})).await
}

#[tauri::command]
async fn parts_merge(state: State<'_, Backend>, dir: String, files: Vec<String>) -> Result<Value, String> {
    delegate(&state, "parts_merge", json!({"dir": dir, "files": files})).await
}

#[tauri::command]
async fn figure_import(state: State<'_, Backend>, dir: String, source: String) -> Result<Value, String> {
    delegate(&state, "figure_import", json!({"dir": dir, "source": source})).await
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
    compiler::flatten_tex(Path::new(&dir)).await
}

#[tauri::command]
async fn compile(
    state: State<'_, Backend>,
    dir: String,
    mode: CompileMode,
    focus: Option<String>,
    review: Option<bool>,
) -> Result<CompileOutcome, String> {
    state.compile(dir, mode, focus, review.unwrap_or(false)).await
}

#[tauri::command]
async fn export_pdf(dir: String, dest: String, review: Option<bool>) -> Result<(), String> {
    let pdf = review::build_dir(&project::build_dir(Path::new(&dir)), review.unwrap_or(false)).join("paper.pdf");
    tokio::fs::copy(&pdf, &dest).await.map(|_| ()).map_err(|e| format!("{dest}: {e}"))
}

#[tauri::command]
async fn export_zip(dir: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || project::export_zip(Path::new(&dir), Path::new(&dest)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn synctex_to_source(
    state: State<'_, Backend>,
    dir: String,
    page: u32,
    x: f64,
    y: f64,
    review: Option<bool>,
) -> Result<Option<SourceSpot>, String> {
    state.synctex_to_source(&dir, page, x, y, review.unwrap_or(false)).await
}

#[tauri::command]
async fn synctex_to_pdf(
    state: State<'_, Backend>,
    dir: String,
    part: String,
    line: usize,
    review: Option<bool>,
) -> Result<Option<PdfBox>, String> {
    state.synctex_to_pdf(&dir, &part, line, review.unwrap_or(false)).await
}

#[tauri::command]
async fn dictionary_read(dir: String) -> Result<Vec<String>, String> {
    project::read_dictionary(Path::new(&dir))
}

#[tauri::command]
async fn dictionary_add(state: State<'_, Backend>, dir: String, words: Vec<String>) -> Result<Value, String> {
    delegate(&state, "dictionary_add", json!({"dir": dir, "words": words})).await
}

#[tauri::command]
async fn figure_import_bytes(state: State<'_, Backend>, dir: String, name: String, data: String) -> Result<Value, String> {
    delegate(&state, "figure_import_bytes", json!({"dir": dir, "name": name, "data": data})).await
}

#[tauri::command]
async fn preamble_save(state: State<'_, Backend>, dir: String, content: String) -> Result<Value, String> {
    delegate(&state, "preamble_save", json!({"dir": dir, "content": content})).await
}

#[tauri::command]
async fn template_eject(state: State<'_, Backend>, dir: String) -> Result<Value, String> {
    delegate(&state, "template_eject", json!({"dir": dir})).await
}

#[tauri::command]
async fn template_restore(state: State<'_, Backend>, dir: String) -> Result<Value, String> {
    delegate(&state, "template_restore", json!({"dir": dir})).await
}

#[tauri::command]
async fn bib_lookup(query: String, existing_keys: Vec<String>) -> Result<Lookup, String> {
    bibfetch::lookup(&query, &existing_keys).await
}

#[tauri::command]
async fn zotero_linked(dir: String) -> Result<Option<String>, String> {
    zotero::linked(Path::new(&dir))
}

#[tauri::command]
async fn zotero_link(state: State<'_, Backend>, dir: String, path: Option<String>) -> Result<Value, String> {
    delegate(&state, "zotero_link", json!({"dir": dir, "path": path})).await
}

#[tauri::command]
async fn zotero_read(dir: String) -> Result<Option<String>, String> {
    zotero::read_linked(Path::new(&dir))
}

/// The watcher of the open project's linked bibliography; replaced when another project opens.
#[derive(Default)]
struct ZoteroWatch(Mutex<Option<notify::RecommendedWatcher>>);

/// Watches the project's linked bibliography; false when it has none.
#[tauri::command]
async fn zotero_watch(app: AppHandle, watch: State<'_, ZoteroWatch>, dir: String) -> Result<bool, String> {
    let mut current = watch.0.lock().unwrap();
    *current = None;
    let Some(bib) = zotero::linked(Path::new(&dir))? else { return Ok(false) };
    let watcher = zotero::watch(Path::new(&bib), move || {
        let _ = app.emit(zotero::CHANGED_EVENT, &dir);
    })?;
    *current = Some(watcher);
    Ok(true)
}

#[tauri::command]
async fn block_latex(dir: String, part: String, line: usize, content: Option<String>) -> Result<Option<BlockLatex>, String> {
    showlatex::block_latex(Path::new(&dir), &part, line, content).await
}

#[tauri::command]
async fn history_status(state: State<'_, Backend>, dir: String) -> Result<Value, String> {
    delegate(&state, "history_status", json!({"dir": dir})).await
}

#[tauri::command]
async fn history_enable(state: State<'_, Backend>, dir: String) -> Result<Value, String> {
    delegate(&state, "history_enable", json!({"dir": dir})).await
}

#[tauri::command]
async fn history_autosave(state: State<'_, Backend>, dir: String, reason: Option<String>) -> Result<Value, String> {
    delegate(&state, "history_autosave", json!({"dir": dir, "reason": reason})).await
}

#[tauri::command]
async fn history_save_version(
    state: State<'_, Backend>,
    dir: String,
    label: Option<String>,
    note: Option<String>,
    reason: Option<String>,
) -> Result<Value, String> {
    delegate(&state, "history_save_version", json!({"dir": dir, "label": label, "note": note, "reason": reason})).await
}

#[tauri::command]
async fn history_list(
    state: State<'_, Backend>,
    dir: String,
    include_autosaves: bool,
    before: Option<String>,
    limit: usize,
) -> Result<Value, String> {
    let args = json!({"dir": dir, "includeAutosaves": include_autosaves, "before": before, "limit": limit});
    delegate(&state, "history_list", args).await
}

#[tauri::command]
async fn history_label(state: State<'_, Backend>, dir: String, id: String, label: Option<String>) -> Result<Value, String> {
    delegate(&state, "history_label", json!({"dir": dir, "id": id, "label": label})).await
}

#[tauri::command]
async fn history_diff(state: State<'_, Backend>, dir: String, from: String, to: Option<String>) -> Result<Value, String> {
    delegate(&state, "history_diff", json!({"dir": dir, "from": from, "to": to})).await
}

#[tauri::command]
async fn history_read_part(state: State<'_, Backend>, dir: String, id: String, file: String) -> Result<Value, String> {
    delegate(&state, "history_read_part", json!({"dir": dir, "id": id, "file": file})).await
}

#[tauri::command]
async fn history_restore(state: State<'_, Backend>, dir: String, id: String) -> Result<Value, String> {
    delegate(&state, "history_restore", json!({"dir": dir, "id": id})).await
}

#[tauri::command]
async fn history_restore_part(state: State<'_, Backend>, dir: String, id: String, file: String) -> Result<Value, String> {
    delegate(&state, "history_restore_part", json!({"dir": dir, "id": id, "file": file})).await
}

fn build_backend(app: &AppHandle) -> Result<Backend, Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let data = app.path().app_local_data_dir()?;
    Ok(Backend::new(
        Toolchain {
            pandoc: sidecar("pandoc"),
            tectonic: sidecar("tectonic"),
            templates: resources.join("templates"),
            tex_cache: data.join("tex-cache"),
        },
        Some(resources.join("tex-cache")),
        resources.join("sample"),
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(build_backend(app.handle())?);
            app.manage(ZoteroWatch::default());
            // Seed the TeX cache while the user is still picking a project.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle.state::<Backend>().ensure_cache().await;
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
            synctex_to_source,
            synctex_to_pdf,
            dictionary_read,
            dictionary_add,
            figure_import_bytes,
            preamble_save,
            template_eject,
            template_restore,
            bib_lookup,
            zotero_linked,
            zotero_link,
            zotero_read,
            zotero_watch,
            block_latex,
            history_status,
            history_enable,
            history_autosave,
            history_save_version,
            history_list,
            history_label,
            history_diff,
            history_read_part,
            history_restore,
            history_restore_part,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
