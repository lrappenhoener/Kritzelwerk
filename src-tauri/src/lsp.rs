use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

struct Server {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
static SESSION: AtomicU64 = AtomicU64::new(0);

fn server() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Serialize)]
pub struct LspProject {
    pub root_uri: String,
    pub file_uri: String,
}

pub fn start(app: &AppHandle, snippet: Option<&str>) -> Result<LspProject, String> {
    let root = crate::languages::analysis_project(snippet)?;
    let project = LspProject {
        root_uri: file_uri(&root),
        file_uri: file_uri(&root.join("src").join("main.rs")),
    };

    let mut guard = server()
        .lock()
        .map_err(|_| "rust-analyzer-Zustand ist gesperrt.".to_string())?;

    // Ein neuer Client (z. B. nach einem Frontend-Reload oder Snippet-Wechsel)
    // braucht eine frische LSP-Sitzung; der Prozess bleibt für alle Anfragen
    // dieser Sitzung bestehen.
    if let Some(mut existing) = guard.take() {
        let _ = existing.child.kill();
        let _ = existing.child.wait();
    }

    let session = SESSION.fetch_add(1, Ordering::SeqCst) + 1;
    let mut child = Command::new("rust-analyzer")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "rust-analyzer konnte nicht gestartet werden: {error} (Nix-Dev-Shell prüfen)"
            )
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "rust-analyzer-stdin nicht verfügbar.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "rust-analyzer-stdout nicht verfügbar.".to_string())?;
    let stderr = child.stderr.take();
    let stdin = Arc::new(Mutex::new(stdin));

    spawn_reader(app.clone(), stdout, Arc::clone(&stdin), session);

    if let Some(stderr) = stderr {
        let log_path = root
            .parent()
            .unwrap_or(&root)
            .join("rust-analyzer.log");
        std::thread::spawn(move || {
            let Ok(mut log) = File::create(log_path) else {
                let mut sink = std::io::sink();
                let _ = std::io::copy(&mut BufReader::new(stderr), &mut sink);
                return;
            };
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut log);
        });
    }

    *guard = Some(Server { child, stdin });
    Ok(project)
}

pub fn send(message: &str) -> Result<(), String> {
    let guard = server()
        .lock()
        .map_err(|_| "rust-analyzer-Zustand ist gesperrt.".to_string())?;
    let Some(server) = guard.as_ref() else {
        return Err("rust-analyzer ist nicht gestartet.".to_string());
    };
    write_message(&server.stdin, message)
        .map_err(|error| format!("Nachricht an rust-analyzer fehlgeschlagen: {error}"))
}

pub fn shutdown() {
    let Ok(mut guard) = server().lock() else {
        return;
    };
    if let Some(mut server) = guard.take() {
        let _ = server.child.kill();
        let _ = server.child.wait();
    }
}

fn spawn_reader(
    app: AppHandle,
    stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    session: u64,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(message)) => {
                    if handle_server_request(&stdin, &message) {
                        continue;
                    }
                    let _ = app.emit("lsp-message", message);
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        // Eine absichtlich beendete Sitzung darf den Zustand des neuen
        // rust-analyzers nicht zurücksetzen.
        if SESSION.load(Ordering::SeqCst) == session {
            let _ = app.emit(
                "lsp-closed",
                "rust-analyzer wurde beendet. Vorschläge sind nicht verfügbar.",
            );
        }
    });
}

fn read_frame(reader: &mut BufReader<ChildStdout>) -> std::io::Result<Option<String>> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        if let Some(value) = header.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }

    let Some(length) = content_length else {
        return Ok(None);
    };
    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer)?;
    Ok(Some(String::from_utf8_lossy(&buffer).into_owned()))
}

fn handle_server_request(stdin: &Arc<Mutex<ChildStdin>>, message: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(message) else {
        return false;
    };
    let Some(method) = value["method"].as_str() else {
        return false;
    };
    let Some(id) = value.get("id") else {
        return false;
    };

    let result = match method {
        "workspace/configuration" => {
            let count = value["params"]["items"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0);
            Value::Array((0..count).map(|_| json!({})).collect())
        }
        "workspace/workspaceFolders" => json!([]),
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create" => Value::Null,
        _ => return false,
    };

    let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let _ = write_message(stdin, &response.to_string());
    true
}

fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &str) -> std::io::Result<()> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "stdin gesperrt"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n{}", message.len(), message)?;
    stdin.flush()
}

fn file_uri(path: &Path) -> String {
    let encoded = path
        .to_string_lossy()
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    format!("file://{encoded}")
}
