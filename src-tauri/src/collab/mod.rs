//! Live collaboration on the local network. The host shares the open project: a listener on
//! `DEFAULT_PORT` that up to `MAX_PEERS` people (the host's own window included) join with a
//! code or a link. Every part and `refs.bib` is a Yjs document ("room") held here, the only
//! writer of those files: edits travel as small CRDT updates, and the text reaches the disk after
//! a short pause, before every compile and before every command that reads or rewrites the
//! project. Commands that rewrite files (split, merge, restore…) enter the rooms as minimal
//! diffs, so nobody's editor is replaced wholesale.

pub mod code;
mod server;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use similar::{DiffTag, TextDiff};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::sync::{Awareness, Message, SyncMessage};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{ClientID, Doc, GetString, ReadTxn, Text, TextRef, Transact, TransactionMut, Update};

use crate::backend::Backend;
use crate::project;
use code::JoinCode;

pub const DEFAULT_PORT: u16 = 1440;
/// People in a session, the host included.
pub const MAX_PEERS: usize = 10;
const MATERIALIZE_EVERY: Duration = Duration::from_millis(250);
const BIB_ROOM: &str = "bib";
const PART_ROOM: &str = "part:";
/// The `Y.Text` of every room; the frontend reads the same name.
const TEXT_NAME: &str = "content";
/// Binary channel of the last PDF, next to the rooms.
const PDF_CHANNEL: &str = "#pdf";
const COLORS: [&str; MAX_PEERS] = [
    "#e5484d", "#0090ff", "#30a46c", "#f76b15", "#8e4ec6", "#12a594", "#d6409f", "#e2a336", "#3e63dd", "#978365",
];

/// Frontend files for guests who join from a browser: path below the site root → bytes and MIME type.
pub type Assets = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// The frontend from a built `dist/` folder, for the browser dev server.
pub fn dist_assets(dist: PathBuf) -> Assets {
    Arc::new(move |path: &str| {
        let bytes = std::fs::read(dist.join(path)).ok()?;
        let mime = match Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("") {
            "html" => "text/html; charset=utf-8",
            "js" | "mjs" => "text/javascript",
            "css" => "text/css",
            "wasm" => "application/wasm",
            "json" => "application/json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "ico" => "image/x-icon",
            "woff2" => "font/woff2",
            "woff" => "font/woff",
            "ttf" => "font/ttf",
            _ => "application/octet-stream",
        };
        Some((bytes, mime.to_string()))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Guest,
}

/// What the host's Share dialog shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub code: String,
    /// Opens the session in a browser on another machine.
    pub link: String,
    pub address: String,
    pub port: u16,
    /// Lets the host's own window join as host; only accepted over loopback.
    pub host_key: String,
    pub max_peers: usize,
}

struct Peer {
    name: String,
    color: &'static str,
    role: Role,
    /// The file the peer has open, for the participants list.
    file: Option<String>,
    tx: mpsc::UnboundedSender<WsMessage>,
    /// Subscribed rooms, with the awareness clients (cursors) the peer created in each.
    rooms: HashMap<String, HashSet<ClientID>>,
}

struct Room {
    file: String,
    awareness: Awareness,
    text: TextRef,
    /// The file's text as last read or written, so unchanged rooms are never rewritten.
    last_written: String,
    dirty: bool,
}

#[derive(Default)]
struct State {
    rooms: HashMap<String, Room>,
    peers: BTreeMap<u64, Peer>,
    next_peer: u64,
    /// The last compile the host shared, sent to guests as they join.
    last_compile: Option<(Value, Option<Arc<Vec<u8>>>)>,
    /// Wrong codes per address; past `server::MAX_FAILURES` the address is refused.
    failures: HashMap<IpAddr, u32>,
}

pub struct Session {
    dir: PathBuf,
    code: JoinCode,
    host_key: String,
    /// The backend's project lock: writes here never interleave with a command's.
    lock: Arc<tokio::sync::Mutex<()>>,
    backend: Weak<Backend>,
    assets: Option<Assets>,
    state: Mutex<State>,
    stop: watch::Sender<bool>,
}

fn text_frame(value: &Value) -> WsMessage {
    WsMessage::text(value.to_string())
}

/// A binary frame: `[varuint length][channel UTF-8][payload]`, like lib0's `writeVarString`.
fn frame(channel: &str, payload: &[u8]) -> WsMessage {
    let mut out = Vec::with_capacity(channel.len() + payload.len() + 5);
    let mut len = channel.len();
    loop {
        let byte = (len & 0x7f) as u8;
        len >>= 7;
        if len == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
    out.extend_from_slice(channel.as_bytes());
    out.extend_from_slice(payload);
    WsMessage::binary(out)
}

fn unframe(data: &[u8]) -> Option<(&str, &[u8])> {
    let (mut len, mut shift, mut at) = (0usize, 0, 0);
    loop {
        let byte = *data.get(at)?;
        at += 1;
        len |= ((byte & 0x7f) as usize) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 28 {
            return None;
        }
    }
    let end = at.checked_add(len)?;
    Some((std::str::from_utf8(data.get(at..end)?).ok()?, &data[end..]))
}

/// Turns `old` into `new` inside `text` with as few character insertions and deletions as a
/// diff finds. Offsets are UTF-8 bytes, `yrs`'s default; JS clients count UTF-16 units, but
/// updates carry no offsets, so both interoperate.
fn apply_diff(text: &TextRef, txn: &mut TransactionMut, old: &str, new: &str) {
    let byte_offsets = |s: &str| s.char_indices().map(|(i, _)| i).chain([s.len()]).collect::<Vec<_>>();
    let (old_at, new_at) = (byte_offsets(old), byte_offsets(new));
    let diff = TextDiff::configure().timeout(Duration::from_millis(250)).diff_chars(old, new);
    for op in diff.ops() {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        let pos = new_at[new_range.start] as u32;
        if matches!(tag, DiffTag::Delete | DiffTag::Replace) {
            text.remove_range(txn, pos, (old_at[old_range.end] - old_at[old_range.start]) as u32);
        }
        if matches!(tag, DiffTag::Insert | DiffTag::Replace) {
            text.insert(txn, pos, &new[new_at[new_range.start]..new_at[new_range.end]]);
        }
    }
}

fn peers_json(peers: &BTreeMap<u64, Peer>) -> Value {
    let peers: Vec<Value> = peers
        .iter()
        .map(|(id, p)| json!({"id": id, "name": p.name, "color": p.color, "role": p.role, "file": p.file}))
        .collect();
    json!({"t": "peers", "peers": peers})
}

fn send_to_all(peers: &BTreeMap<u64, Peer>, message: &WsMessage) {
    for peer in peers.values() {
        let _ = peer.tx.send(message.clone());
    }
}

fn send_to_room(peers: &BTreeMap<u64, Peer>, room: &str, except: Option<u64>, message: &WsMessage) {
    for (id, peer) in peers {
        if Some(*id) != except && peer.rooms.contains_key(room) {
            let _ = peer.tx.send(message.clone());
        }
    }
}

fn send_to_guests(peers: &BTreeMap<u64, Peer>, message: &WsMessage) {
    for peer in peers.values().filter(|p| p.role == Role::Guest) {
        let _ = peer.tx.send(message.clone());
    }
}

impl Session {
    /// Opens the listener (`DEFAULT_PORT`, or any free port when it is taken) and starts serving.
    pub async fn start(
        dir: PathBuf,
        lock: Arc<tokio::sync::Mutex<()>>,
        backend: Weak<Backend>,
        assets: Option<Assets>,
    ) -> Result<Arc<Self>, String> {
        let listener = match TcpListener::bind((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)).await {
            Ok(listener) => listener,
            Err(_) => TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
                .await
                .map_err(|e| format!("Could not open a network port for collaboration: {e}"))?,
        };
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let session = Arc::new(Self {
            dir,
            code: JoinCode { ip: code::lan_ipv4(), port, secret: code::random_bytes() },
            host_key: code::hex(&code::random_bytes::<16>()),
            lock,
            backend,
            assets,
            state: Mutex::new(State::default()),
            stop: watch::channel(false).0,
        });
        tokio::spawn(server::serve(session.clone(), listener, session.stop.subscribe()));
        tokio::spawn(materialize(Arc::downgrade(&session), session.stop.subscribe()));
        Ok(session)
    }

    pub fn info(&self) -> Info {
        let code = self.code.encode();
        Info {
            link: format!("http://{}:{}/#join={code}", self.code.ip, self.code.port),
            address: self.code.ip.to_string(),
            port: self.code.port,
            host_key: self.host_key.clone(),
            max_peers: MAX_PEERS,
            code,
        }
    }

    pub fn shares(&self, dir: &str) -> bool {
        Path::new(dir) == self.dir
    }

    fn dir_string(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }

    /// Writes the rooms to disk, flushes, tells everyone the session is over and closes the port.
    pub async fn stop(&self) {
        self.flush().await;
        let state = self.state.lock().unwrap();
        send_to_all(&state.peers, &text_frame(&json!({"t": "ended"})));
        send_to_all(&state.peers, &WsMessage::Close(None));
        drop(state);
        let _ = self.stop.send(true);
    }

    fn any_dirty(&self) -> bool {
        self.state.lock().unwrap().rooms.values().any(|r| r.dirty)
    }

    pub async fn flush(&self) {
        let _guard = self.lock.lock().await;
        self.flush_held();
    }

    /// Writes changed rooms to their files; the caller holds the project lock.
    pub fn flush_held(&self) {
        let writes: Vec<(PathBuf, String)> = {
            let mut state = self.state.lock().unwrap();
            state
                .rooms
                .values_mut()
                .filter_map(|room| {
                    if !std::mem::take(&mut room.dirty) {
                        return None;
                    }
                    let text = room.text.get_string(&room.awareness.doc().transact());
                    (text != room.last_written).then(|| {
                        room.last_written = text.clone();
                        (self.dir.join(&room.file), text)
                    })
                })
                .collect()
        };
        for (path, text) in writes {
            if let Err(e) = project::write_atomic(&path, text.as_bytes()) {
                eprintln!("collaboration: could not save {}: {e}", path.display());
            }
        }
    }

    /// After a command rewrote files: rooms of deleted parts close, and every file the command
    /// changed enters its room as a diff. Files it left alone keep edits made meanwhile. The
    /// caller holds the project lock.
    pub fn resync_held(&self) {
        let parts = project::read_meta(&self.dir).map(|m| m.parts).unwrap_or_default();
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let mut closed = Vec::new();
        for (name, room) in state.rooms.iter_mut() {
            if name != BIB_ROOM && !parts.contains(&room.file) {
                closed.push(name.clone());
                continue;
            }
            let Ok(disk) = project::read_optional(&self.dir.join(&room.file)) else { continue };
            if disk == room.last_written {
                continue;
            }
            let update = {
                let mut txn = room.awareness.doc().transact_mut();
                let current = room.text.get_string(&txn);
                apply_diff(&room.text, &mut txn, &current, &disk);
                txn.encode_update_v1()
            };
            room.last_written = disk;
            room.dirty = false;
            send_to_room(&state.peers, name, None, &frame(name, &Message::Sync(SyncMessage::Update(update)).encode_v1()));
        }
        for name in closed {
            state.rooms.remove(&name);
            for peer in state.peers.values_mut() {
                if peer.rooms.remove(&name).is_some() {
                    let _ = peer.tx.send(text_frame(&json!({"t": "closed", "room": name})));
                }
            }
        }
    }

    /// The project as everyone should now see it: structure, settings, figures, preamble.
    pub fn broadcast_snapshot(&self) {
        match project::open(&self.dir) {
            Ok(snapshot) => {
                let state = self.state.lock().unwrap();
                send_to_all(&state.peers, &text_frame(&json!({"t": "snapshot", "snapshot": snapshot})));
            }
            Err(e) => eprintln!("collaboration: could not read the project: {e}"),
        }
    }

    /// A whole-file save of a shared part becomes a diff in its room; false when nobody has
    /// the part open, so the file can be written directly.
    pub fn replace_text(&self, file: &str, content: &str) -> bool {
        let name = format!("{PART_ROOM}{file}");
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let Some(room) = state.rooms.get_mut(&name) else { return false };
        let update = {
            let mut txn = room.awareness.doc().transact_mut();
            let current = room.text.get_string(&txn);
            if current == content {
                return true;
            }
            apply_diff(&room.text, &mut txn, &current, content);
            txn.encode_update_v1()
        };
        room.dirty = true;
        send_to_room(&state.peers, &name, None, &frame(&name, &Message::Sync(SyncMessage::Update(update)).encode_v1()));
        true
    }

    pub fn publish_compiling(&self) {
        send_to_guests(&self.state.lock().unwrap().peers, &text_frame(&json!({"t": "compiling"})));
    }

    /// Shares the host's compile with the guests; a failed one keeps the last PDF.
    pub fn publish_compile(&self, outcome: Value, pdf: Option<Vec<u8>>) {
        let mut state = self.state.lock().unwrap();
        let pdf = pdf.map(Arc::new).or_else(|| state.last_compile.as_ref().and_then(|(_, pdf)| pdf.clone()));
        send_to_guests(&state.peers, &text_frame(&json!({"t": "compiled", "outcome": outcome})));
        if let Some(pdf) = &pdf {
            send_to_guests(&state.peers, &frame(PDF_CHANNEL, pdf));
        }
        state.last_compile = Some((outcome, pdf));
    }

    fn send_last_compile(&self, tx: &mpsc::UnboundedSender<WsMessage>) {
        let state = self.state.lock().unwrap();
        if let Some((outcome, pdf)) = &state.last_compile {
            let _ = tx.send(text_frame(&json!({"t": "compiled", "outcome": outcome})));
            if let Some(pdf) = pdf {
                let _ = tx.send(frame(PDF_CHANNEL, pdf));
            }
        }
    }

    fn banned(&self, ip: IpAddr) -> bool {
        self.state.lock().unwrap().failures.get(&ip).is_some_and(|n| *n >= server::MAX_FAILURES)
    }

    fn authenticate(&self, code: Option<&str>, host_key: Option<&str>, ip: IpAddr) -> Result<Role, &'static str> {
        if let Some(key) = host_key
            && ip.is_loopback()
            && code::same_secret(key.as_bytes(), self.host_key.as_bytes())
        {
            return Ok(Role::Host);
        }
        if let Some(code) = code.and_then(JoinCode::parse)
            && code::same_secret(&code.secret, &self.code.secret)
        {
            return Ok(Role::Guest);
        }
        *self.state.lock().unwrap().failures.entry(ip).or_default() += 1;
        Err("That code does not match this session. Check it with the host.")
    }

    fn join(&self, name: String, role: Role, tx: mpsc::UnboundedSender<WsMessage>) -> Result<(u64, &'static str), String> {
        let mut state = self.state.lock().unwrap();
        if state.peers.len() >= MAX_PEERS {
            return Err(format!("The session is full: {MAX_PEERS} people are already in it."));
        }
        let color = COLORS
            .iter()
            .copied()
            .find(|c| !state.peers.values().any(|p| p.color == *c))
            .unwrap_or(COLORS[0]);
        let id = state.next_peer;
        state.next_peer += 1;
        state.peers.insert(id, Peer { name, color, role, file: None, tx, rooms: HashMap::new() });
        // The newcomer gets the list in its hello.
        let list = text_frame(&peers_json(&state.peers));
        for (_, peer) in state.peers.iter().filter(|(other, _)| **other != id) {
            let _ = peer.tx.send(list.clone());
        }
        Ok((id, color))
    }

    /// Removes a peer and the cursors it left in every room.
    fn leave(&self, id: u64) {
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let Some(peer) = state.peers.remove(&id) else { return };
        for (name, clients) in peer.rooms {
            let Some(room) = state.rooms.get_mut(&name) else { continue };
            if clients.is_empty() {
                continue;
            }
            for client in &clients {
                room.awareness.remove_state(*client);
            }
            if let Ok(update) = room.awareness.update_with_clients(clients) {
                send_to_room(&state.peers, &name, None, &frame(&name, &Message::Awareness(update).encode_v1()));
            }
        }
        send_to_all(&state.peers, &text_frame(&peers_json(&state.peers)));
    }

    fn peers(&self) -> Value {
        peers_json(&self.state.lock().unwrap().peers)["peers"].clone()
    }

    fn set_presence(&self, id: u64, file: Option<String>) {
        let mut state = self.state.lock().unwrap();
        let Some(peer) = state.peers.get_mut(&id) else { return };
        if peer.file == file {
            return;
        }
        peer.file = file;
        send_to_all(&state.peers, &text_frame(&peers_json(&state.peers)));
    }

    /// The file of a room, which must be `refs.bib` or a part of the document.
    fn room_file(&self, room: &str) -> Result<String, String> {
        if room == BIB_ROOM {
            return Ok(project::BIB_FILE.into());
        }
        let file = room.strip_prefix(PART_ROOM).ok_or_else(|| format!("unknown room '{room}'"))?;
        project::check_part_path(file)?;
        if !project::read_meta(&self.dir)?.parts.iter().any(|p| p == file) {
            return Err(format!("'{file}' is not a part of this document"));
        }
        Ok(file.into())
    }

    /// Only the host seeds a room, once, from the file: two replicas seeding the same text would
    /// duplicate it when they merge.
    fn open_room(&self, file: String) -> Result<Room, String> {
        let content = project::read_optional(&self.dir.join(&file))?;
        let doc = Doc::new();
        let text = doc.get_or_insert_text(TEXT_NAME);
        text.insert(&mut doc.transact_mut(), 0, &content);
        Ok(Room { file, awareness: Awareness::new(doc), text, last_written: content, dirty: false })
    }

    /// A y-protocols message from a peer for a room; the first one subscribes the peer.
    fn room_message(&self, id: u64, name: &str, payload: &[u8]) -> Result<(), String> {
        let message = Message::decode_v1(payload).map_err(|e| e.to_string())?;
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let subscribed = state.peers.get(&id).ok_or("unknown peer")?.rooms.contains_key(name);
        if !state.rooms.contains_key(name) {
            let room = self.open_room(self.room_file(name)?)?;
            state.rooms.insert(name.to_string(), room);
        }
        let room = state.rooms.get_mut(name).expect("room opened above");
        let mut replies = Vec::new();
        let mut relay = None;
        let mut owned: (Vec<ClientID>, Vec<ClientID>) = (Vec::new(), Vec::new());
        if !subscribed
            && let Ok(update) = room.awareness.update()
            && !update.clients.is_empty()
        {
            replies.push(Message::Awareness(update).encode_v1());
        }
        match message {
            Message::Sync(SyncMessage::SyncStep1(remote)) => {
                let txn = room.awareness.doc().transact();
                replies.push(Message::Sync(SyncMessage::SyncStep2(txn.encode_state_as_update_v1(&remote))).encode_v1());
                replies.push(Message::Sync(SyncMessage::SyncStep1(txn.state_vector())).encode_v1());
            }
            Message::Sync(SyncMessage::SyncStep2(update) | SyncMessage::Update(update)) => {
                let decoded = Update::decode_v1(&update).map_err(|e| e.to_string())?;
                room.awareness.doc().transact_mut().apply_update(decoded).map_err(|e| e.to_string())?;
                room.dirty = true;
                relay = Some(Message::Sync(SyncMessage::Update(update)).encode_v1());
            }
            Message::Awareness(update) => {
                if let Some(summary) = room.awareness.apply_update_summary(update.clone()).map_err(|e| e.to_string())? {
                    owned = (summary.added.into_iter().chain(summary.updated).collect(), summary.removed);
                    relay = Some(Message::Awareness(update).encode_v1());
                }
            }
            Message::AwarenessQuery => {
                if let Ok(update) = room.awareness.update() {
                    replies.push(Message::Awareness(update).encode_v1());
                }
            }
            Message::Auth(_) | Message::Custom(..) => {}
        }
        let peer = state.peers.get_mut(&id).expect("checked above");
        let clients = peer.rooms.entry(name.to_string()).or_default();
        clients.extend(owned.0);
        for removed in owned.1 {
            clients.remove(&removed);
        }
        for reply in replies {
            let _ = peer.tx.send(frame(name, &reply));
        }
        if let Some(relay) = relay {
            send_to_room(&state.peers, name, Some(id), &frame(name, &relay));
        }
        Ok(())
    }
}

async fn materialize(session: Weak<Session>, mut stop: watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(MATERIALIZE_EVERY);
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            _ = tick.tick() => {}
        }
        let Some(session) = session.upgrade() else { return };
        if session.any_dirty() {
            session.flush().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::Toolchain;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

    type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    fn backend() -> Arc<Backend> {
        let tmp = std::env::temp_dir();
        let tool = |name: &str| tmp.join(name);
        Backend::new(
            Toolchain { pandoc: tool("pandoc"), tectonic: tool("tectonic"), templates: tool("templates"), tex_cache: tool("tex") },
            None,
            tmp.join("sample"),
        )
    }

    /// A participant with its own replica of one room.
    struct Client {
        socket: Socket,
        doc: Doc,
        room: String,
    }

    impl Client {
        async fn join(port: u16, credentials: Value) -> Result<(Socket, Value), Value> {
            let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/collab")).await.unwrap();
            socket.send(WsMessage::text(credentials.to_string())).await.unwrap();
            let reply = Self::next_json(&mut socket).await;
            if reply["t"] == "hello" { Ok((socket, reply)) } else { Err(reply) }
        }

        async fn next_json(socket: &mut Socket) -> Value {
            loop {
                if let WsMessage::Text(text) = socket.next().await.unwrap().unwrap() {
                    return serde_json::from_str(&text).unwrap();
                }
            }
        }

        async fn subscribe(socket: Socket, room: &str) -> Self {
            let mut client = Client { socket, doc: Doc::new(), room: room.into() };
            let sv = client.doc.transact().state_vector();
            client.send(Message::Sync(SyncMessage::SyncStep1(sv))).await;
            client.receive_until(|c| !c.text().is_empty()).await;
            client
        }

        fn text(&self) -> String {
            self.doc.get_or_insert_text(TEXT_NAME).get_string(&self.doc.transact())
        }

        async fn send(&mut self, message: Message) {
            self.socket.send(frame(&self.room, &message.encode_v1())).await.unwrap();
        }

        async fn insert(&mut self, at: u32, chunk: &str) {
            let text = self.doc.get_or_insert_text(TEXT_NAME);
            let update = {
                let mut txn = self.doc.transact_mut();
                text.insert(&mut txn, at, chunk);
                txn.encode_update_v1()
            };
            self.send(Message::Sync(SyncMessage::Update(update))).await;
        }

        /// Applies room messages until `done` holds; answers the server's sync step 1.
        async fn receive_until(&mut self, done: impl Fn(&Self) -> bool) {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while !done(self) {
                let next = tokio::time::timeout_at(deadline, self.socket.next()).await.expect("timed out");
                let WsMessage::Binary(data) = next.unwrap().unwrap() else { continue };
                let (room, payload) = unframe(&data).unwrap();
                if room != self.room {
                    continue;
                }
                match Message::decode_v1(payload).unwrap() {
                    Message::Sync(SyncMessage::SyncStep1(sv)) => {
                        let update = self.doc.transact().encode_state_as_update_v1(&sv);
                        self.send(Message::Sync(SyncMessage::SyncStep2(update))).await;
                    }
                    Message::Sync(SyncMessage::SyncStep2(update) | SyncMessage::Update(update)) => {
                        self.doc.transact_mut().apply_update(Update::decode_v1(&update).unwrap()).unwrap();
                    }
                    _ => {}
                }
            }
        }
    }

    #[tokio::test]
    async fn guests_edit_the_same_part_and_the_host_writes_it() {
        let backend = backend();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let snapshot = project::create(tmp.path(), None, "article", "T", "en").unwrap();
        let file = snapshot.parts[0].file.clone();
        let info = backend.collab_start(dir.clone()).await.unwrap();
        let room = format!("{PART_ROOM}{file}");

        let wrong = JoinCode { secret: [0; code::SECRET_LEN], ..JoinCode::parse(&info.code).unwrap() }.encode();
        let denied = Client::join(info.port, json!({"t": "auth", "code": wrong, "name": "Eve"})).await.unwrap_err();
        assert_eq!(denied["t"], "denied");

        let (socket, hello) = Client::join(info.port, json!({"t": "auth", "code": info.code, "name": "Ana"})).await.unwrap();
        assert_eq!((hello["role"].clone(), hello["snapshot"]["meta"]["parts"][0].clone()), (json!("guest"), json!(file)));
        let mut ana = Client::subscribe(socket, &room).await;
        let (socket, _) = Client::join(info.port, json!({"t": "auth", "code": info.code, "name": "Bo"})).await.unwrap();
        let mut bo = Client::subscribe(socket, &room).await;
        assert_eq!(ana.text(), "# Introduction\n\nStart writing here.\n");

        ana.insert(2, "Big ").await;
        bo.receive_until(|c| c.text().starts_with("# Big Introduction")).await;
        bo.insert(bo.text().len() as u32, "Más.\n").await;
        ana.receive_until(|c| c.text().ends_with("Más.\n")).await;

        let session = backend.shared(Some(&dir)).unwrap();
        session.flush().await;
        let on_disk = std::fs::read_to_string(tmp.path().join(&file)).unwrap();
        assert_eq!(on_disk, "# Big Introduction\n\nStart writing here.\nMás.\n");
        assert_eq!(on_disk, ana.text());

        // A room outside the document is refused.
        ana.socket.send(frame("part:../paper.md", &Message::AwarenessQuery.encode_v1())).await.unwrap();
        let closed = Client::next_json(&mut ana.socket).await;
        assert_eq!(closed, json!({"t": "closed", "room": "part:../paper.md"}));

        // Guests reach only whitelisted commands, on the shared folder whatever they name.
        let call = json!({"t": "call", "id": 7, "cmd": "project_open", "args": {"dir": "/"}});
        bo.socket.send(WsMessage::text(call.to_string())).await.unwrap();
        let reply = loop {
            let message = Client::next_json(&mut bo.socket).await;
            if message["t"] == "reply" {
                break message;
            }
        };
        assert_eq!(reply["id"], 7);
        assert!(reply["err"].as_str().unwrap().contains("Only the host"));

        // A split rewrites the part on disk; the room follows as a diff.
        let first = "# One\n\nA.\n\n# Two\n\nB.\n";
        assert!(session.replace_text(&file, first));
        let split = backend.dispatch("part_split", json!({"dir": dir, "file": file, "level": 1})).await;
        assert!(split.is_ok(), "{:?}", split.err());
        ana.receive_until(|c| c.text() == "# One\n\nA.\n").await;

        backend.collab_stop().await;
        assert!(backend.shared(Some(&dir)).is_none());
    }

    #[test]
    fn frames_round_trip() {
        let WsMessage::Binary(data) = frame("part:sections/intro.md", &[1, 2, 3]) else { panic!() };
        assert_eq!(unframe(&data), Some(("part:sections/intro.md", &[1u8, 2, 3][..])));
        let long = "x".repeat(300);
        let WsMessage::Binary(data) = frame(&long, &[]) else { panic!() };
        assert_eq!(unframe(&data), Some((long.as_str(), &[][..])));
        assert_eq!(unframe(&[5, b'a']), None);
    }

    #[test]
    fn diffs_reach_the_new_text_with_small_edits() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text(TEXT_NAME);
        let old = "# Introducción\n\nUno, dos.\n";
        text.insert(&mut doc.transact_mut(), 0, old);
        let new = "# Introducción ✓\n\nUno, tres y dos.\n";
        let mut txn = doc.transact_mut();
        apply_diff(&text, &mut txn, old, new);
        assert_eq!(text.get_string(&txn), new);
        drop(txn);
        let mut txn = doc.transact_mut();
        apply_diff(&text, &mut txn, new, "");
        assert_eq!(text.get_string(&txn), "");
    }
}
