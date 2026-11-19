use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{
    Diagnostic, DiagnosticRange, DiagnosticSeverity, SnippetResult, SnippetStatus,
};

const RUN_TIMEOUT: Duration = Duration::from_secs(5);

pub fn run(source: &str, mode: &str) -> Result<SnippetResult, String> {
    if mode != "program" {
        return Err("JavaScript ist nur im Programmmodus verfügbar.".to_string());
    }

    let project = work_dir()?;
    fs::write(project.join("snippet.mjs"), source)
        .map_err(|error| format!("JavaScript-Quelle nicht schreibbar: {error}"))?;

    let check = Command::new("node")
        .args(["--check", "snippet.mjs"])
        .current_dir(&project)
        .env("NO_COLOR", "1")
        .env("NODE_DISABLE_COLORS", "1")
        .output();

    let check = match check {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(node_missing_result());
        }
        Err(error) => {
            return Err(format!("Node.js konnte nicht gestartet werden: {error}"));
        }
    };

    if !check.status.success() {
        let stderr = String::from_utf8_lossy(&check.stderr).trim_end().to_string();
        let diagnostics = diagnostic_from(stderr.as_str(), source)
            .into_iter()
            .collect();
        return Ok(SnippetResult {
            status: SnippetStatus::BuildError,
            stdout: String::new(),
            stderr,
            diagnostics,
            exit_code: None,
            values: Vec::new(),
        });
    }

    run_snippet(&project, source)
}

fn run_snippet(project: &Path, source: &str) -> Result<SnippetResult, String> {
    let spawned = Command::new("node")
        .arg("snippet.mjs")
        .current_dir(project)
        .env("NO_COLOR", "1")
        .env("NODE_DISABLE_COLORS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return Err(format!("Node.js-Programm konnte nicht gestartet werden: {error}"));
        }
    };

    let stdout_reader = child.stdout.take().map(read_pipe);
    let stderr_reader = child.stderr.take().map(read_pipe);

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(error) => return Err(format!("Node.js-Status nicht lesbar: {error}")),
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
            values: Vec::new(),
        });
    }

    let exit_code = status.and_then(|status| status.code());
    let succeeded = exit_code == Some(0);
    let diagnostics = if succeeded {
        Vec::new()
    } else {
        diagnostic_from(&stderr, source).into_iter().collect()
    };

    Ok(SnippetResult {
        status: if succeeded {
            SnippetStatus::Success
        } else {
            SnippetStatus::RunError
        },
        stdout,
        stderr,
        diagnostics,
        exit_code,
        values: Vec::new(),
    })
}

fn diagnostic_from(stderr: &str, source: &str) -> Option<Diagnostic> {
    let (line, column) = parse_position(stderr)?;
    let range = range_for(source, line, column);
    let message = first_error_line(stderr).unwrap_or_else(|| "JavaScript-Fehler".to_string());
    let code = message
        .split(':')
        .next()
        .filter(|candidate| candidate.ends_with("Error"))
        .map(str::to_string);
    Some(Diagnostic {
        message,
        severity: DiagnosticSeverity::Error,
        code,
        range,
        rendered: String::new(),
    })
}

fn parse_position(stderr: &str) -> Option<(u32, Option<u32>)> {
    let mut without_column = None;

    for line in stderr.lines() {
        let Some(index) = line.find("snippet.mjs:") else {
            continue;
        };
        let rest = &line[index + "snippet.mjs:".len()..];
        let mut parts = rest.split(':');
        let Some(line_number) = parts.next().and_then(|value| {
            value
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<u32>().ok())
        }) else {
            continue;
        };
        if line_number == 0 {
            continue;
        }
        let column = parts
            .next()
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|column| *column > 0);
        if column.is_some() {
            return Some((line_number, column));
        }
        if without_column.is_none() {
            without_column = Some((line_number, None));
        }
    }

    without_column
}

fn first_error_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.starts_with("at ") &&
                (line.starts_with("SyntaxError:")
                    || line.starts_with("TypeError:")
                    || line.starts_with("ReferenceError:")
                    || line.starts_with("RangeError:")
                    || line.starts_with("Error:"))
        })
        .map(str::to_string)
}

fn range_for(source: &str, line: u32, column: Option<u32>) -> Option<DiagnosticRange> {
    let (line_start, line_end) = line_bounds(source, line)?;
    let from = match column {
        Some(column) => line_start + (column.saturating_sub(1) as usize),
        None => line_start,
    };
    if from > line_end {
        return Some(DiagnosticRange {
            from: line_start,
            to: line_end,
        });
    }
    let to = line_end;
    if from == to && line_end > line_start {
        return Some(DiagnosticRange {
            from: line_start,
            to: line_end,
        });
    }
    Some(DiagnosticRange { from, to })
}

fn line_bounds(source: &str, line_number: u32) -> Option<(usize, usize)> {
    let target = line_number as usize;
    let mut start = 0;
    let mut current = 1;

    for segment in source.split_inclusive('\n') {
        let content = segment.trim_end_matches('\n').trim_end_matches('\r');
        let length = content.encode_utf16().count();
        if current == target {
            return Some((start, start + length));
        }
        start += segment.encode_utf16().count();
        current += 1;
    }

    if current == target {
        return Some((start, start));
    }
    None
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

fn node_missing_result() -> SnippetResult {
    SnippetResult {
        status: SnippetStatus::BuildError,
        stdout: String::new(),
        stderr: "Node.js ist nicht verfügbar. Bitte die Nix-Dev-Shell verwenden."
            .to_string(),
        diagnostics: Vec::new(),
        exit_code: None,
        values: Vec::new(),
    }
}

fn work_dir() -> Result<PathBuf, String> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| "Kein Cache-Verzeichnis gefunden (HOME/XDG_CACHE_HOME fehlt).".to_string())?;
    let project = cache.join("kritzelwerk").join("javascript-snippet");
    fs::create_dir_all(&project)
        .map_err(|error| format!("JavaScript-Arbeitsverzeichnis nicht anlegbar: {error}"))?;
    Ok(project)
}
