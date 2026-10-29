//! The collaboration listener. `GET /collab` upgrades to the WebSocket every participant edits
//! through (the host's own window included); any other `GET` serves the frontend, so a guest can
//! join from a browser with just the link. `/api` is never exposed here: guests reach the
//! backend only through `GUEST_COMMANDS`, with the project folder fixed by the session.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role as WsRole, WebSocketConfig};

use super::{Role, Session, frame, text_frame, unframe};
use crate::backend::Reply;

const MAX_HEAD: usize = 16 * 1024;
/// Open TCP connections, joined or not; the session itself admits `MAX_PEERS`.
const MAX_CONNECTIONS: usize = 32;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Pasted figures arrive base64-encoded in one message.
const MAX_MESSAGE: usize = 32 << 20;
/// Wrong codes an address may send before it is refused for the rest of the session.
pub(super) const MAX_FAILURES: u32 = 10;
const NAME_CHARS: usize = 40;

/// What a guest may ask the host's backend to do. Not here: opening or creating projects, paths
/// on the host's disk, exports, restoring versions, templates, Zotero and compiling, which the
/// host does for everyone.
const GUEST_COMMANDS: [&str; 23] = [
    "project_save",
    "part_create",
    "part_delete",
    "parts_reorder",
    "part_split",
    "parts_merge",
    "figure_list",
    "figure_import_bytes",
    "read_binary",
    "read_tex",
    "synctex_to_source",
    "synctex_to_pdf",
    "dictionary_read",
    "dictionary_add",
    "preamble_save",
    "bib_lookup",
    "block_latex",
    "history_status",
    "history_list",
    "history_diff",
    "history_read_part",
    "history_save_version",
    "history_label",
];

/// Boxed with a named type: guests' commands go through `dispatch`, which can start a session,
/// which spawns this; an opaque `async fn` type would depend on itself.
pub(super) fn serve(
    session: Arc<Session>,
    listener: TcpListener,
    stop: watch::Receiver<bool>,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(accept(session, listener, stop))
}

async fn accept(session: Arc<Session>, listener: TcpListener, mut stop: watch::Receiver<bool>) {
    let open = Arc::new(AtomicUsize::new(0));
    loop {
        let (stream, addr) = tokio::select! {
            _ = stop.changed() => return,
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(_) => continue,
            },
        };
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (session, open, stop) = (session.clone(), open.clone(), stop.clone());
        tokio::spawn(async move {
            let _ = connection(&session, stream, addr, stop).await;
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

struct Head {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

async fn read_head(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed".into());
        }
        head.extend_from_slice(&buf[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() > MAX_HEAD {
            return Err("request head too large".into());
        }
    }
}

fn parse_head(raw: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text[..text.find("\r\n\r\n")?].split("\r\n");
    let mut request = lines.next()?.split(' ');
    let method = request.next()?.to_string();
    let path = request.next()?.split(['?', '#']).next()?.to_string();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    Some(Head { method, path, headers })
}

/// Browsers send `Origin` on WebSockets and skip CORS, so a page on another site could open one:
/// only the app's own origins pass. Clients without `Origin` are not browsers; the code still
/// guards them.
fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    if matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost") {
        return true;
    }
    let Some(authority) = origin.strip_prefix("http://") else { return false };
    if host.is_some_and(|h| h.eq_ignore_ascii_case(authority)) {
        return true;
    }
    let hostname = authority.rsplit_once(':').map_or(authority, |(h, _)| h);
    matches!(hostname, "localhost" | "127.0.0.1")
}

async fn respond(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8]) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(body).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

async fn connection(session: &Arc<Session>, mut stream: TcpStream, addr: SocketAddr, stop: watch::Receiver<bool>) -> Result<(), String> {
    let raw = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_head(&mut stream)).await.map_err(|_| "timed out")??;
    let head = parse_head(&raw).ok_or("bad request")?;
    if head.path == "/collab" {
        let upgrade = head.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
        let Some(key) = head.header("sec-websocket-key").filter(|_| upgrade) else {
            return respond(&mut stream, "400 Bad Request", "text/plain", b"WebSocket only").await;
        };
        if !origin_allowed(head.header("origin"), head.header("host")) {
            return respond(&mut stream, "403 Forbidden", "text/plain", b"Forbidden origin").await;
        }
        let accept = derive_accept_key(key.as_bytes());
        let reply = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream.write_all(reply.as_bytes()).await.map_err(|e| e.to_string())?;
        let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
        let ws = WebSocketStream::from_raw_socket(stream, WsRole::Server, Some(config)).await;
        return participant(session, ws, addr.ip(), stop).await;
    }
    if head.method != "GET" {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"").await;
    }
    let rel = match head.path.trim_start_matches('/') {
        "" => "index.html",
        rel => rel,
    };
    if rel.split('/').any(|s| s.is_empty() || s == ".." || s.starts_with('.')) {
        return respond(&mut stream, "404 Not Found", "text/plain", b"Not found").await;
    }
    match session.assets.as_ref().and_then(|assets| assets(rel)) {
        Some((bytes, mime)) => respond(&mut stream, "200 OK", &mime, &bytes).await,
        None if rel == "index.html" => {
            let page = format!(
                "<!doctype html><meta charset=utf-8><title>PaperForge</title><p>Open PaperForge, choose \
                 <b>Join a session</b> and enter the code <b>{}</b>.",
                session.code.encode()
            );
            respond(&mut stream, "200 OK", "text/html; charset=utf-8", page.as_bytes()).await
        }
        None => respond(&mut stream, "404 Not Found", "text/plain", b"Not found").await,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Auth {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    host_key: Option<String>,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Control {
    Presence {
        file: Option<String>,
    },
    Call {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
}

fn clean_name(name: &str, role: Role) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(NAME_CHARS).collect();
    match name.trim() {
        "" if role == Role::Host => "Host".into(),
        "" => "Guest".into(),
        name => name.into(),
    }
}

async fn participant(
    session: &Arc<Session>,
    ws: WebSocketStream<TcpStream>,
    ip: IpAddr,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let (mut sink, mut stream) = ws.split();
    let denied = |reason: &str| text_frame(&json!({"t": "denied", "reason": reason}));
    if session.banned(ip) {
        let _ = sink.send(denied("Too many wrong codes from this computer.")).await;
        return Ok(());
    }
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.next()).await.map_err(|_| "no credentials")?;
    let Some(Ok(WsMessage::Text(first))) = first else { return Err("expected credentials".into()) };
    let auth: Auth = serde_json::from_str(&first).map_err(|e| e.to_string())?;
    let role = match session.authenticate(auth.code.as_deref(), auth.host_key.as_deref(), ip) {
        Ok(role) => role,
        Err(reason) => {
            let _ = sink.send(denied(reason)).await;
            return Ok(());
        }
    };
    let name = clean_name(&auth.name, role);
    let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();
    let (id, color) = match session.join(name.clone(), role, tx.clone()) {
        Ok(joined) => joined,
        Err(reason) => {
            let _ = sink.send(denied(&reason)).await;
            return Ok(());
        }
    };
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, WsMessage::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let result = async {
        session.flush().await;
        let snapshot = crate::project::open(&session.dir)?;
        let hello = json!({
            "t": "hello", "you": id, "role": role, "name": name, "color": color,
            "snapshot": snapshot, "peers": session.peers(),
        });
        let _ = tx.send(text_frame(&hello));
        if role == Role::Guest {
            session.send_last_compile(&tx);
        }
        loop {
            let message = tokio::select! {
                _ = stop.changed() => break,
                message = stream.next() => message,
            };
            match message {
                Some(Ok(WsMessage::Binary(data))) => {
                    let Some((room, payload)) = unframe(&data) else { continue };
                    if let Err(e) = session.room_message(id, room, payload) {
                        eprintln!("collaboration: {room}: {e}");
                        let _ = tx.send(text_frame(&json!({"t": "closed", "room": room})));
                    }
                }
                Some(Ok(WsMessage::Text(text))) => match serde_json::from_str::<Control>(&text) {
                    Ok(Control::Presence { file }) => session.set_presence(id, file),
                    Ok(Control::Call { id: call, cmd, args }) => {
                        let (session, tx) = (session.clone(), tx.clone());
                        tokio::spawn(async move {
                            let reply = match run_for_guest(&session, &cmd, args).await {
                                Ok(Reply::Json(value)) => text_frame(&json!({"t": "reply", "id": call, "ok": value})),
                                Ok(Reply::Bytes(bytes)) => frame(&format!("#reply:{call}"), &bytes),
                                Err(e) => text_frame(&json!({"t": "reply", "id": call, "err": e})),
                            };
                            let _ = tx.send(reply);
                        });
                    }
                    Err(_) => {}
                },
                Some(Ok(WsMessage::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
        Ok::<(), String>(())
    }
    .await;
    session.leave(id);
    drop(tx);
    let _ = writer.await;
    result
}

/// Runs a whitelisted command on the shared project, whatever folder the guest named.
async fn run_for_guest(session: &Session, command: &str, mut args: Value) -> Result<Reply, String> {
    if !GUEST_COMMANDS.contains(&command) {
        return Err("Only the host can do that in a shared session.".into());
    }
    let backend = session.backend.upgrade().ok_or("The session has ended.")?;
    let fields = args.as_object_mut().ok_or("bad arguments")?;
    fields.insert("dir".into(), Value::String(session.dir_string()));
    if command == "read_binary" {
        let path = fields.get("path").and_then(Value::as_str).ok_or("bad arguments")?;
        let inside = std::fs::canonicalize(Path::new(path))
            .ok()
            .zip(std::fs::canonicalize(&session.dir).ok())
            .is_some_and(|(path, dir)| path.starts_with(dir));
        if !inside {
            return Err("Only files of the shared project can be read.".into());
        }
    }
    backend.dispatch(command, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_heads() {
        let head = parse_head(b"GET /collab?x=1 HTTP/1.1\r\nHost: 10.0.0.2:1440\r\nUpgrade: WebSocket\r\n\r\n").unwrap();
        assert_eq!((head.method.as_str(), head.path.as_str()), ("GET", "/collab"));
        assert_eq!(head.header("upgrade"), Some("WebSocket"));
        assert_eq!(head.header("host"), Some("10.0.0.2:1440"));
        assert!(parse_head(b"GET / HTTP/1.1\r\n").is_none());
    }

    #[test]
    fn allows_only_the_apps_origins() {
        assert!(origin_allowed(None, None));
        assert!(origin_allowed(Some("tauri://localhost"), None));
        assert!(origin_allowed(Some("http://10.0.0.2:1440"), Some("10.0.0.2:1440")));
        assert!(origin_allowed(Some("http://localhost:1420"), Some("127.0.0.1:1440")));
        assert!(!origin_allowed(Some("http://evil.example"), Some("10.0.0.2:1440")));
        assert!(!origin_allowed(Some("https://10.0.0.2:1440"), Some("10.0.0.2:1440")));
    }

    #[test]
    fn cleans_names() {
        assert_eq!(clean_name("  Ana\u{7}  ", Role::Guest), "Ana");
        assert_eq!(clean_name("", Role::Host), "Host");
        assert_eq!(clean_name(&"x".repeat(99), Role::Guest).len(), NAME_CHARS);
    }
}
