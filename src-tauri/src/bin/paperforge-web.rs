//! Browser dev server: the desktop backend over HTTP, so the UI can be tried at
//! http://localhost:1420 (Vite proxies `/api` here). Development only; binds to 127.0.0.1.
//!
//! Usage: cargo run --features web --bin paperforge-web -- [project-dir]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use paperforge_lib::backend::{Backend, Reply};
use paperforge_lib::collab;
use paperforge_lib::compiler::Toolchain;
use paperforge_lib::project;
use serde_json::{Value, json};
use tiny_http::{Header, Method, Request, Response, Server};

const ADDR: &str = "127.0.0.1:1430";
/// A custom header forces a CORS preflight, which this server never answers, so other sites
/// open in the same browser cannot drive it.
const GUARD_HEADER: &str = "x-paperforge";

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn toolchain() -> Toolchain {
    let triple = env!("PAPERFORGE_TARGET_TRIPLE");
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let bin = |name: &str| manifest().join("binaries").join(format!("{name}-{triple}{exe}"));
    Toolchain {
        pandoc: bin("pandoc"),
        tectonic: bin("tectonic"),
        templates: manifest().join("resources/templates"),
        tex_cache: manifest().join("resources/tex-cache"),
    }
}

fn header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond_json(status: u16, value: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(value).expect("json"))
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

/// Folders under `path` for the browser's folder picker.
fn browse(args: &Value) -> Result<Value, String> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let path = match args.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => home.clone().ok_or("no home directory")?,
    };
    let mut dirs: Vec<Value> = std::fs::read_dir(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| {
            json!({
                "name": e.file_name().to_string_lossy(),
                "path": e.path().to_string_lossy(),
                "isProject": e.path().join(project::META_FILE).exists(),
            })
        })
        .collect();
    dirs.sort_by_key(|d| d["name"].as_str().unwrap_or_default().to_lowercase());
    Ok(json!({
        "path": path.to_string_lossy(),
        "parent": path.parent().map(|p| p.to_string_lossy().into_owned()),
        "home": home.map(|h| h.to_string_lossy().into_owned()),
        "isProject": path.join(project::META_FILE).exists(),
        "dirs": dirs,
    }))
}

/// An image picked or dropped in the browser: the bytes arrive here instead of a file path.
fn upload(request: &mut Request) -> Result<Value, String> {
    let dir = header(request, "x-pf-dir").map(|d| percent_decode(&d)).ok_or("missing x-pf-dir")?;
    let name = header(request, "x-pf-name").map(|n| percent_decode(&n)).ok_or("missing x-pf-name")?;
    let file_name = Path::new(&name).file_name().ok_or("bad file name")?.to_owned();
    let mut bytes = Vec::new();
    request.as_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let staging = tempfile_dir()?.join(file_name);
    std::fs::write(&staging, &bytes).map_err(|e| e.to_string())?;
    let result = project::import_figure(Path::new(&dir), &staging);
    let _ = std::fs::remove_file(&staging);
    result.map(Value::String)
}

fn tempfile_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("paperforge-upload-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

async fn handle(backend: Arc<Backend>, mut request: Request) {
    let url = request.url().to_string();
    let Some(command) = url.strip_prefix("/api/").map(|c| c.split('?').next().unwrap_or("").to_string()) else {
        let _ = request.respond(respond_json(404, &json!("not found")));
        return;
    };
    if *request.method() != Method::Post || header(&request, GUARD_HEADER).is_none() {
        let _ = request.respond(respond_json(403, &json!("forbidden")));
        return;
    }
    if command == "_upload" {
        let reply = upload(&mut request);
        let _ = request.respond(match reply {
            Ok(v) => respond_json(200, &v),
            Err(e) => respond_json(400, &json!(e)),
        });
        return;
    }
    let mut body = String::new();
    if let Err(e) = request.as_reader().read_to_string(&mut body) {
        let _ = request.respond(respond_json(400, &json!(e.to_string())));
        return;
    }
    let args: Value = if body.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                let _ = request.respond(respond_json(400, &json!(format!("bad JSON: {e}"))));
                return;
            }
        }
    };
    let reply = if command == "_browse" { browse(&args).map(Reply::Json) } else { backend.dispatch(&command, args).await };
    let response = match reply {
        Ok(Reply::Json(v)) => respond_json(200, &v),
        Ok(Reply::Bytes(bytes)) => Response::from_data(bytes)
            .with_header(Header::from_bytes("Content-Type", "application/octet-stream").unwrap()),
        Err(e) => respond_json(400, &json!(e)),
    };
    let _ = request.respond(response);
}

#[tokio::main]
async fn main() {
    let tc = toolchain();
    for tool in [&tc.pandoc, &tc.tectonic] {
        if !tool.exists() {
            eprintln!("missing {} — run `npm run sidecars` first", tool.display());
            std::process::exit(1);
        }
    }
    let backend = Backend::new(tc, None, manifest().join("resources/sample"));
    // Guests who open an invitation link get the last `npm run build`.
    backend.set_assets(collab::dist_assets(manifest().join("../dist")));
    let server = Server::http(ADDR).unwrap_or_else(|e| {
        eprintln!("cannot listen on {ADDR}: {e}");
        std::process::exit(1);
    });
    println!("PaperForge web backend on http://{ADDR} (open http://localhost:1420)");
    if let Some(project) = &backend.startup_project {
        println!("opening {project}");
    }
    let runtime = tokio::runtime::Handle::current();
    // tiny_http blocks; requests are handed to tokio so a new compile can abort a running one.
    tokio::task::spawn_blocking(move || {
        for request in server.incoming_requests() {
            runtime.spawn(handle(backend.clone(), request));
        }
    })
    .await
    .expect("server loop");
}
