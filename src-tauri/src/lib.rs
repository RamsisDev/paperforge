pub mod backend;
pub mod compiler;
pub mod markers;
pub mod project;
pub mod synctex;

use std::path::{Path, PathBuf};

use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

use backend::{Backend, EngineInfo};
use compiler::{CompileMode, CompileOutcome, Toolchain};
use project::{PaperMeta, ProjectSnapshot};
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

#[tauri::command]
async fn project_create(
    state: State<'_, Backend>,
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
    state: State<'_, Backend>,
    dir: String,
    mode: CompileMode,
    focus: Option<String>,
) -> Result<CompileOutcome, String> {
    state.compile(dir, mode, focus).await
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

#[tauri::command]
async fn synctex_to_source(
    state: State<'_, Backend>,
    dir: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<SourceSpot>, String> {
    state.synctex_to_source(&dir, page, x, y).await
}

#[tauri::command]
async fn synctex_to_pdf(state: State<'_, Backend>, dir: String, part: String, line: usize) -> Result<Option<PdfBox>, String> {
    state.synctex_to_pdf(&dir, &part, line).await
}

#[tauri::command]
async fn dictionary_read(dir: String) -> Result<Vec<String>, String> {
    project::read_dictionary(Path::new(&dir))
}

#[tauri::command]
async fn dictionary_add(dir: String, words: Vec<String>) -> Result<Vec<String>, String> {
    project::add_to_dictionary(Path::new(&dir), &words)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
