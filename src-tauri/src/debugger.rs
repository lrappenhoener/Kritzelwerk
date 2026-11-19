use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::languages::Diagnostic;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

struct DebugSession {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>,
    seq: AtomicI64,
    thread_id: Mutex<Option<i64>>,
    source_path: PathBuf,
}

static SESSION: OnceLock<Mutex<Option<Arc<DebugSession>>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<Arc<DebugSession>>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Serialize)]
pub struct DebugStartResult {
    pub started: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub stderr: String,
    pub message: Option<String>,
    pub breakpoints: Vec<BreakpointState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BreakpointState {
    pub line: u32,
    pub verified: bool,
}

#[derive(Debug, Serialize)]
pub struct DebugVariable {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct DebugSnapshot {
    pub line: Option<u32>,
    pub frame: Option<String>,
    pub variables: Vec<DebugVariable>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugEvent {
    pub event: String,
    pub thread_id: Option<i64>,
    pub reason: Option<String>,
    pub output: Option<String>,
    pub category: Option<String>,
    pub exit_code: Option<i64>,
}

pub fn start(
    app: &AppHandle,
    source: &str,
    snippet: Option<&str>,
    mode: &str,
    breakpoints: Vec<u32>,
) -> Result<DebugStartResult, String> {
    if mode != "program" {
        return Err("Debuggen ist nur im Programmmodus verfügbar.".to_string());
    }

    stop_internal();

    let build = crate::languages::debug_build(source, snippet)?;
    if !build.success {
        return Ok(DebugStartResult {
            started: false,
            diagnostics: build.diagnostics,
            stderr: build.stderr,
            message: Some("Debug-Build fehlgeschlagen.".to_string()),
            breakpoints: Vec::new(),
        });
    }
    let Some(executable) = build.executable else {
        return Err("Cargo hat kein ausführbares Programm gemeldet.".to_string());
    };

    let session = spawn_session(
        app.clone(),
        &executable,
        &build.project,
        PathBuf::from(&build.source_path),
    )?;

    {
        let mut guard = session_slot()
            .lock()
            .map_err(|_| "Debugger-Zustand ist gesperrt.".to_string())?;
        *guard = Some(Arc::clone(&session));
    }

    let started = (|| -> Result<Vec<BreakpointState>, String> {
        request(
            &session,
            "initialize",
            json!({
                "adapterID": "lldb-dap",
                "clientID": "kritzelwerk",
                "clientName": "Kritzelwerk",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                "supportsVariablePaging": false,
                "supportsRunInTerminalRequest": false
            }),
            REQUEST_TIMEOUT,
        )?;

        // Der Launch-Request wartet bei lldb-dap intern auf configurationDone.
        send_only(
            &session,
            "launch",
            json!({
                "program": executable,
                "cwd": build.project,
                "stopOnEntry": false,
                "console": "internalConsole",
                "initCommands": [
                    "settings set target.inline-breakpoint-strategy always"
                ]
            }),
        )?;

        let states = set_breakpoints_inner(&session, &breakpoints)?;

        request(
            &session,
            "configurationDone",
            json!({}),
            REQUEST_TIMEOUT,
        )?;

        Ok(states)
    })();

    match started {
        Ok(breakpoints) => Ok(DebugStartResult {
            started: true,
            diagnostics: build.diagnostics,
            stderr: build.stderr,
            message: None,
            breakpoints,
        }),
        Err(error) => {
            stop_internal();
            Err(error)
        }
    }
}

pub fn snapshot(thread_id: i64) -> Result<DebugSnapshot, String> {
    let session = current_session()?;

    let stack = request(
        &session,
        "stackTrace",
        json!({ "threadId": thread_id, "startFrame": 0, "levels": 1 }),
        REQUEST_TIMEOUT,
    )?;
    let Some(frame) = stack["stackFrames"].as_array().and_then(|frames| frames.first()) else {
        return Ok(DebugSnapshot {
            line: None,
            frame: None,
            variables: Vec::new(),
        });
    };

    let frame_id = frame["id"].as_i64();
    let line = frame["line"].as_u64().map(|line| line as u32);
    let frame_name = frame["name"].as_str().map(str::to_string);

    let Some(frame_id) = frame_id else {
        return Ok(DebugSnapshot {
            line,
            frame: frame_name,
            variables: Vec::new(),
        });
    };

    let scopes = request(
        &session,
        "scopes",
        json!({ "frameId": frame_id }),
        REQUEST_TIMEOUT,
    )?;
    let scope = scopes["scopes"]
        .as_array()
        .and_then(|scopes| {
            scopes
                .iter()
                .find(|scope| scope["name"].as_str() == Some("Locals"))
                .or_else(|| {
                    scopes
                        .iter()
                        .find(|scope| scope["variablesReference"].as_i64().unwrap_or(0) > 0)
                })
        })
        .cloned();

    let mut variables = Vec::new();
    if let Some(scope) = scope {
        let reference = scope["variablesReference"].as_i64().unwrap_or(0);
        if reference > 0 {
            let response = request(
                &session,
                "variables",
                json!({ "variablesReference": reference }),
                REQUEST_TIMEOUT,
            )?;
            if let Some(items) = response["variables"].as_array() {
                for item in items {
                    let Some(name) = item["name"].as_str() else {
                        continue;
                    };
                    variables.push(DebugVariable {
                        name: name.to_string(),
                        kind: item["type"].as_str().map(str::to_string),
                        value: item["value"].as_str().unwrap_or("").to_string(),
                    });
                }
            }
        }
    }

    Ok(DebugSnapshot {
        line,
        frame: frame_name,
        variables,
    })
}

pub fn resume(command: &str) -> Result<(), String> {
    let session = current_session()?;
    let thread_id = session
        .thread_id
        .lock()
        .map_err(|_| "Debugger-Zustand ist gesperrt.".to_string())?
        .unwrap_or(1);
    request(
        &session,
        command,
        json!({ "threadId": thread_id }),
        REQUEST_TIMEOUT,
    )?;
    Ok(())
}

pub fn set_breakpoints(lines: Vec<u32>) -> Result<Vec<BreakpointState>, String> {
    let session = current_session()?;
    set_breakpoints_inner(&session, &lines)
}

pub fn stop() -> Result<(), String> {
    stop_internal();
    Ok(())
}

pub fn shutdown() {
    stop_internal();
}

fn current_session() -> Result<Arc<DebugSession>, String> {
    session_slot()
        .lock()
        .map_err(|_| "Debugger-Zustand ist gesperrt.".to_string())?
        .as_ref()
        .cloned()
        .ok_or_else(|| "Keine aktive Debug-Sitzung.".to_string())
}

fn stop_internal() {
    let session = session_slot()
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    let Some(session) = session else {
        return;
    };

    let _ = request(
        &session,
        "disconnect",
        json!({ "terminateDebuggee": true }),
        Duration::from_secs(3),
    );
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_session(
    app: AppHandle,
    executable: &str,
    project: &str,
    source_path: PathBuf,
) -> Result<Arc<DebugSession>, String> {
    let mut child = Command::new("lldb-dap")
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "lldb-dap konnte nicht gestartet werden: {error} (Nix-Dev-Shell prüfen)"
            )
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "lldb-dap-stdin nicht verfügbar.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "lldb-dap-stdout nicht verfügbar.".to_string())?;
    let stderr = child.stderr.take();

    let session = Arc::new(DebugSession {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        seq: AtomicI64::new(0),
        thread_id: Mutex::new(None),
        source_path,
    });

    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut sink = std::io::sink();
            let _ = std::io::copy(&mut reader, &mut sink);
        });
    }

    spawn_reader(app, stdout, Arc::clone(&session));
    let _ = executable;
    Ok(session)
}

fn spawn_reader(app: AppHandle, stdout: ChildStdout, session: Arc<DebugSession>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(value)) => {
                    handle_message(&app, &session, value);
                }
                Ok(None) | Err(_) => break,
            }
        }
        let _ = app.emit(
            "debug-event",
            DebugEvent {
                event: "terminated".to_string(),
                thread_id: None,
                reason: Some("lldb-dap wurde beendet.".to_string()),
                output: None,
                category: None,
                exit_code: None,
            },
        );
    });
}

fn handle_message(app: &AppHandle, session: &Arc<DebugSession>, value: Value) {
    match value["type"].as_str() {
        Some("response") => {
            let Some(request_seq) = value["request_seq"].as_i64() else {
                return;
            };
            let sender = session
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&request_seq));
            if let Some(sender) = sender {
                if value["success"].as_bool().unwrap_or(false) {
                    let _ = sender.send(Ok(value["body"].clone()));
                } else {
                    let message = value["message"]
                        .as_str()
                        .or_else(|| value["body"]["error"].as_str())
                        .unwrap_or("Unbekannter DAP-Fehler");
                    let _ = sender.send(Err(format!("LLDB: {message}")));
                }
            }
        }
        Some("event") => {
            let event = value["event"].as_str().unwrap_or("").to_string();
            let body = &value["body"];
            let mut debug_event = DebugEvent {
                event: event.clone(),
                thread_id: None,
                reason: None,
                output: None,
                category: None,
                exit_code: None,
            };
            match event.as_str() {
                "stopped" => {
                    let thread_id = body["threadId"].as_i64();
                    if let Some(thread_id) = thread_id {
                        if let Ok(mut current) = session.thread_id.lock() {
                            *current = Some(thread_id);
                        }
                    }
                    debug_event.thread_id = thread_id;
                    debug_event.reason = body["reason"].as_str().map(str::to_string);
                }
                "continued" => {
                    debug_event.thread_id = body["threadId"].as_i64();
                }
                "output" => {
                    debug_event.output = body["output"].as_str().map(str::to_string);
                    debug_event.category = body["category"].as_str().map(str::to_string);
                }
                "exited" => {
                    debug_event.exit_code = body["exitCode"].as_i64();
                }
                _ => {}
            }
            let _ = app.emit("debug-event", debug_event);
        }
        Some("request") => {
            let Some(id) = value["id"].as_i64() else {
                return;
            };
            let response = json!({
                "seq": session.seq.fetch_add(1, Ordering::SeqCst) + 1,
                "type": "response",
                "request_seq": id,
                "success": false,
                "message": "Diese DAP-Anfrage wird von Kritzelwerk nicht unterstützt."
            });
            let _ = write_message(&session.stdin, &response);
        }
        _ => {}
    }
}

fn set_breakpoints_inner(
    session: &Arc<DebugSession>,
    lines: &[u32],
) -> Result<Vec<BreakpointState>, String> {
    let breakpoints = lines
        .iter()
        .map(|line| json!({ "line": line }))
        .collect::<Vec<_>>();
    let response = request(
        session,
        "setBreakpoints",
        json!({
            "source": { "path": session.source_path.to_string_lossy() },
            "breakpoints": breakpoints,
            "sourceModified": false
        }),
        REQUEST_TIMEOUT,
    )?;

    let mut states = Vec::new();
    if let Some(items) = response["breakpoints"].as_array() {
        for (index, item) in items.iter().enumerate() {
            let line = item["line"]
                .as_u64()
                .map(|line| line as u32)
                .or_else(|| lines.get(index).copied())
                .unwrap_or(0);
            states.push(BreakpointState {
                line,
                verified: item["verified"].as_bool().unwrap_or(false),
            });
        }
    }
    Ok(states)
}

fn request(
    session: &Arc<DebugSession>,
    command: &str,
    arguments: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let (id, receiver) = send_request(session, command, arguments)?;
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            if let Ok(mut pending) = session.pending.lock() {
                pending.remove(&id);
            }
            Err(format!("lldb-dap antwortet nicht auf „{command}“."))
        }
    }
}

fn send_only(
    session: &Arc<DebugSession>,
    command: &str,
    arguments: Value,
) -> Result<(), String> {
    send_request(session, command, arguments).map(|_| ())
}

fn send_request(
    session: &Arc<DebugSession>,
    command: &str,
    arguments: Value,
) -> Result<(i64, mpsc::Receiver<Result<Value, String>>), String> {
    let id = session.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (sender, receiver) = mpsc::channel();
    session
        .pending
        .lock()
        .map_err(|_| "Debugger-Zustand ist gesperrt.".to_string())?
        .insert(id, sender);

    let message = json!({
        "seq": id,
        "type": "request",
        "command": command,
        "arguments": arguments
    });
    if let Err(error) = write_message(&session.stdin, &message) {
        if let Ok(mut pending) = session.pending.lock() {
            pending.remove(&id);
        }
        return Err(format!("Anfrage an lldb-dap fehlgeschlagen: {error}"));
    }
    Ok((id, receiver))
}

fn write_message(stdin: &Mutex<ChildStdin>, message: &Value) -> std::io::Result<()> {
    let payload = message.to_string();
    let mut stdin = stdin
        .lock()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "stdin gesperrt"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n{}", payload.len(), payload)?;
    stdin.flush()
}

fn read_frame(reader: &mut BufReader<ChildStdout>) -> std::io::Result<Option<Value>> {
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
    Ok(serde_json::from_slice(&buffer).ok())
}
