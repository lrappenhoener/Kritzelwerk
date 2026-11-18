use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{SnippetResult, SnippetStatus};

const RUN_TIMEOUT: Duration = Duration::from_secs(5);

const CARGO_TOML: &str = r#"[package]
name = "kritzelwerk-snippet"
version = "0.0.0"
edition = "2021"
publish = false

[[bin]]
name = "snippet"
path = "src/main.rs"

[workspace]
"#;

pub fn run(source: &str) -> Result<SnippetResult, String> {
    let project = project_dir()?;
    fs::write(project.join("src/main.rs"), source)
        .map_err(|error| format!("Snippet konnte nicht geschrieben werden: {error}"))?;

    let build = Command::new("cargo")
        .args(["build", "--message-format=json", "--color=never"])
        .current_dir(&project)
        .env("CARGO_TERM_COLOR", "never")
        .output()
        .map_err(|error| format!("Cargo konnte nicht gestartet werden: {error}"))?;

    let build_stdout = String::from_utf8_lossy(&build.stdout);
    let build_stderr = String::from_utf8_lossy(&build.stderr);

    let mut executable: Option<PathBuf> = None;
    let mut diagnostics = Vec::new();

    for line in build_stdout.lines() {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match message["reason"].as_str() {
            Some("compiler-artifact") => {
                if let Some(path) = message["executable"].as_str() {
                    executable = Some(PathBuf::from(path));
                }
            }
            Some("compiler-message") => {
                let diagnostic = &message["message"];
                if diagnostic["level"].as_str() == Some("error") {
                    if let Some(rendered) = diagnostic["rendered"].as_str() {
                        let rendered = rendered.trim_end();
                        if !rendered.is_empty() {
                            diagnostics.push(rendered.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let Some(executable) = executable.filter(|_| build.status.success()) else {
        if diagnostics.is_empty() {
            let fallback = build_stderr.trim();
            diagnostics.push(if fallback.is_empty() {
                "Der Build ist fehlgeschlagen.".to_string()
            } else {
                fallback.to_string()
            });
        }
        return Ok(SnippetResult {
            status: SnippetStatus::BuildError,
            stdout: String::new(),
            stderr: build_stderr.trim_end().to_string(),
            diagnostics,
            exit_code: None,
        });
    };

    run_program(&executable)
}

fn run_program(executable: &Path) -> Result<SnippetResult, String> {
    let mut child = Command::new(executable)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Snippet konnte nicht gestartet werden: {error}"))?;

    let stdout_reader = child.stdout.take().map(read_pipe);
    let stderr_reader = child.stderr.take().map(read_pipe);

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(error) => return Err(format!("Snippet-Status nicht lesbar: {error}")),
        }
        if started.elapsed() >= RUN_TIMEOUT {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(25));
    };

    let stdout = stdout_reader.map(join_pipe).unwrap_or_default();
    let stderr = stderr_reader.map(join_pipe).unwrap_or_default();

    if timed_out {
        return Ok(SnippetResult {
            status: SnippetStatus::Timeout,
            stdout,
            stderr,
            diagnostics: Vec::new(),
            exit_code: None,
        });
    }

    let exit_code = status.and_then(|status| status.code());
    let succeeded = exit_code == Some(0);

    Ok(SnippetResult {
        status: if succeeded {
            SnippetStatus::Success
        } else {
            SnippetStatus::RunError
        },
        stdout,
        stderr,
        diagnostics: Vec::new(),
        exit_code,
    })
}

fn read_pipe<R: Read + Send + 'static>(mut pipe: R) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        String::from_utf8_lossy(&buffer).into_owned()
    })
}

fn join_pipe(handle: thread::JoinHandle<String>) -> String {
    handle.join().unwrap_or_default()
}

fn project_dir() -> Result<PathBuf, String> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| "Kein Cache-Verzeichnis gefunden (HOME/XDG_CACHE_HOME fehlt).".to_string())?;

    let project = cache.join("kritzelwerk").join("rust-snippet");
    fs::create_dir_all(project.join("src"))
        .map_err(|error| format!("Snippet-Projekt nicht anlegbar: {error}"))?;

    let manifest = project.join("Cargo.toml");
    if !manifest.exists() {
        fs::write(&manifest, CARGO_TOML)
            .map_err(|error| format!("Snippet-Manifest nicht schreibbar: {error}"))?;
    }

    Ok(project)
}
