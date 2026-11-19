use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use super::{
    Diagnostic, DiagnosticRange, DiagnosticSeverity, SnippetResult, SnippetStatus,
};

const RUN_TIMEOUT: Duration = Duration::from_secs(5);
const DUMP_FILE_ENV: &str = "KRITZELWERK_DUMP_FILE";

const EXPRESSION_PREFIX: &str = "fn main() {\n    let wert = ";
const EXPRESSION_SUFFIX: &str = ";\n    scratchpad::dump(&wert);\n}\n";
const STATEMENTS_PREFIX: &str = "fn main() {\n";
const STATEMENTS_SUFFIX: &str = "\n}\n";

struct GeneratedSource {
    code: String,
    /// Byte-Länge des Vorspanns vor dem Editorinhalt.
    prefix_len: usize,
}

fn generated_source(source: &str, mode: &str) -> Result<GeneratedSource, String> {
    let (prefix, suffix) = match mode {
        "program" => {
            return Ok(GeneratedSource {
                code: source.to_string(),
                prefix_len: 0,
            });
        }
        "statements" => (STATEMENTS_PREFIX, STATEMENTS_SUFFIX),
        "expression" => (EXPRESSION_PREFIX, EXPRESSION_SUFFIX),
        other => {
            return Err(format!(
                "Unbekannter Ausführungsmodus „{other}“ (erlaubt: Ausdruck, Anweisungen, Programm)."
            ));
        }
    };

    Ok(GeneratedSource {
        code: format!("{prefix}{source}{suffix}"),
        prefix_len: prefix.len(),
    })
}

/// Erzeugt den vollständigen `src/main.rs`-Inhalt für einen Modus.
pub(crate) fn generated_main(source: &str, mode: &str) -> Result<String, String> {
    generated_source(source, mode).map(|generated| generated.code)
}

pub(crate) const SCRATCHPAD_SOURCE: &str = r#"use std::io::Write;

const DUMP_FILE_ENV: &str = "KRITZELWERK_DUMP_FILE";

/// Serialisiert einen Wert als JSON-Zeile in die Ausgabedatei des Laufs.
/// Ohne Ausgabedatei (eigenständiger Cargo-Lauf) erscheint formatiertes JSON
/// auf stdout.
pub fn dump<T: serde::Serialize + ?Sized>(value: &T) {
    let Some(path) = std::env::var_os(DUMP_FILE_ENV) else {
        match serde_json::to_string_pretty(value) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("dump(): Wert konnte nicht serialisiert werden: {error}");
            }
        }
        return;
    };

    let json = match serde_json::to_string(value) {
        Ok(json) => json,
        Err(error) => {
            eprintln!("dump(): Wert konnte nicht serialisiert werden: {error}");
            return;
        }
    };

    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| writeln!(file, "{json}"));

    if let Err(error) = written {
        eprintln!("dump(): Wert konnte nicht geschrieben werden: {error}");
    }
}
"#;

pub fn run(
    source: &str,
    snippet: Option<&str>,
    mode: &str,
) -> Result<SnippetResult, String> {
    let build = build_source("rust-snippet", source, snippet, mode, false)?;
    let Some(executable) = build.executable.filter(|_| build.success) else {
        return Ok(SnippetResult {
            status: SnippetStatus::BuildError,
            stdout: String::new(),
            stderr: build.stderr,
            diagnostics: build.diagnostics,
            exit_code: None,
            values: Vec::new(),
        });
    };

    run_program(&executable, build.diagnostics)
}

struct BuildOutcome {
    project: PathBuf,
    executable: Option<PathBuf>,
    diagnostics: Vec<Diagnostic>,
    stderr: String,
    success: bool,
}

#[derive(Debug, Serialize)]
pub struct DebugBuild {
    pub success: bool,
    pub executable: Option<String>,
    pub project: String,
    pub source_path: String,
    pub diagnostics: Vec<Diagnostic>,
    pub stderr: String,
}

/// Baut das Programm im Debug-Profil und liefert das von Cargo gemeldete
/// Binärprogramm für den Debugger.
pub(crate) fn debug_build(source: &str, snippet: Option<&str>) -> Result<DebugBuild, String> {
    let build = build_source("rust-debug", source, snippet, "program", true)?;
    Ok(DebugBuild {
        success: build.success && build.executable.is_some(),
        executable: build
            .executable
            .map(|path| path.to_string_lossy().into_owned()),
        source_path: build
            .project
            .join("src/main.rs")
            .to_string_lossy()
            .into_owned(),
        project: build.project.to_string_lossy().into_owned(),
        diagnostics: build.diagnostics,
        stderr: build.stderr,
    })
}

fn build_source(
    project_name: &str,
    source: &str,
    snippet: Option<&str>,
    mode: &str,
    debug: bool,
) -> Result<BuildOutcome, String> {
    let generated = generated_source(source, mode)?;
    let project = ensure_project(project_name)?;
    fs::write(project.join("src/main.rs"), &generated.code)
        .map_err(|error| format!("Snippet konnte nicht geschrieben werden: {error}"))?;

    let locked = crate::dependencies::prepare_project(&project, snippet)?;

    let mut command = Command::new("cargo");
    command
        .args(["build", "--message-format=json", "--color=never"])
        .current_dir(&project)
        .env("CARGO_TERM_COLOR", "never");
    if debug {
        command
            .args(["--profile", "dev"])
            .env("CARGO_PROFILE_DEV_DEBUG", "2")
            .env("CARGO_PROFILE_DEV_OPT_LEVEL", "0");
    }
    if locked {
        command.arg("--locked");
    }

    let build = command
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
                if let Some(diagnostic) =
                    parse_diagnostic(&message["message"], source, generated.prefix_len)
                {
                    diagnostics.push(diagnostic);
                }
            }
            _ => {}
        }
    }

    Ok(BuildOutcome {
        project,
        executable,
        diagnostics,
        stderr: build_stderr.trim_end().to_string(),
        success: build.status.success(),
    })
}

/// Wandelt eine `compiler-message`-Meldung in eine strukturierte Diagnose um.
fn parse_diagnostic(
    message: &Value,
    source: &str,
    prefix_len: usize,
) -> Option<Diagnostic> {
    let severity = match message["level"].as_str()? {
        "error" => DiagnosticSeverity::Error,
        "warning" => DiagnosticSeverity::Warning,
        _ => return None,
    };

    let rendered = message["rendered"].as_str().unwrap_or("").trim_end().to_string();
    let text = message["message"].as_str().unwrap_or("").to_string();
    let code = message["code"]["code"].as_str().map(str::to_string);
    let range = primary_range(message, source, prefix_len);

    Some(Diagnostic {
        message: text,
        severity,
        code,
        range,
        rendered,
    })
}

/// Sucht die primäre Span in der kompilierten `src/main.rs`, entfernt den
/// Byte-Vorspann des generierten Codes und rechnet den Rest anhand des
/// Originaltexts in UTF-16-Offsets um.
fn primary_range(
    message: &Value,
    source: &str,
    prefix_len: usize,
) -> Option<DiagnosticRange> {
    let spans = message["spans"].as_array()?;

    for span in spans {
        if span["is_primary"].as_bool() != Some(true) {
            continue;
        }
        let file = span["file_name"].as_str().unwrap_or("");
        if !is_main_file(file) {
            continue;
        }
        let Some(start) = span["byte_start"].as_u64() else {
            continue;
        };
        let Some(end) = span["byte_end"].as_u64() else {
            continue;
        };
        if let Some(range) = map_range(source, prefix_len, start as usize, end as usize) {
            return Some(range);
        }
    }

    None
}

fn map_range(
    source: &str,
    prefix_len: usize,
    start: usize,
    end: usize,
) -> Option<DiagnosticRange> {
    if start < prefix_len || end < prefix_len {
        return None;
    }
    let from_byte = start - prefix_len;
    let to_byte = end - prefix_len;
    if from_byte > source.len() || to_byte > source.len() {
        return None;
    }
    let from = utf16_offset(source, from_byte)?;
    let to = utf16_offset(source, to_byte)?;
    if from > to {
        return None;
    }
    Some(DiagnosticRange { from, to })
}

fn is_main_file(file: &str) -> bool {
    file == "src/main.rs" || file.ends_with("/src/main.rs")
}

fn utf16_offset(source: &str, byte: usize) -> Option<usize> {
    if byte > source.len() || !source.is_char_boundary(byte) {
        return None;
    }
    Some(source[..byte].chars().map(char::len_utf16).sum())
}

fn run_program(
    executable: &Path,
    diagnostics: Vec<Diagnostic>,
) -> Result<SnippetResult, String> {
    let dump_file = dump_file_path();
    fs::write(&dump_file, b"")
        .map_err(|error| format!("Temporäre Ausgabedatei nicht anlegbar: {error}"))?;

    let spawned = Command::new(executable)
        .env(DUMP_FILE_ENV, &dump_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&dump_file);
            return Err(format!("Snippet konnte nicht gestartet werden: {error}"));
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
            Err(error) => {
                let _ = fs::remove_file(&dump_file);
                return Err(format!("Snippet-Status nicht lesbar: {error}"));
            }
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
    let values = read_values(&dump_file);
    let _ = fs::remove_file(&dump_file);

    if timed_out {
        return Ok(SnippetResult {
            status: SnippetStatus::Timeout,
            stdout,
            stderr,
            diagnostics,
            exit_code: None,
            values,
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
        diagnostics,
        exit_code,
        values,
    })
}

fn read_values(path: &Path) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn dump_file_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "kritzelwerk-values-{}-{nanos}.jsonl",
        std::process::id()
    ))
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

/// Eigenes Cargo-Projekt für rust-analyzer (getrennt vom Snippet-Runner).
pub(crate) fn analysis_project(snippet: Option<&str>) -> Result<PathBuf, String> {
    let project = ensure_project("rust-analysis")?;
    crate::dependencies::prepare_project(&project, snippet)?;
    Ok(project)
}

fn ensure_project(name: &str) -> Result<PathBuf, String> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| "Kein Cache-Verzeichnis gefunden (HOME/XDG_CACHE_HOME fehlt).".to_string())?;

    let project = cache.join("kritzelwerk").join(name);
    fs::create_dir_all(project.join("src"))
        .map_err(|error| format!("Snippet-Projekt nicht anlegbar: {error}"))?;

    write_if_changed(&project.join("src/lib.rs"), SCRATCHPAD_SOURCE)?;

    let main = project.join("src/main.rs");
    if !main.exists() {
        fs::write(&main, "fn main() {}\n")
            .map_err(|error| format!("Snippet-Platzhalter nicht schreibbar: {error}"))?;
    }

    Ok(project)
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path)
        .map(|existing| existing == content)
        .unwrap_or(false)
    {
        return Ok(());
    }
    fs::write(path, content)
        .map_err(|error| format!("{} nicht schreibbar: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_mode_keeps_source_unchanged() {
        let generated = generated_source("fn main() {}\n", "program").unwrap();
        assert_eq!(generated.code, "fn main() {}\n");
        assert_eq!(generated.prefix_len, 0);
    }

    #[test]
    fn expression_mode_wraps_and_dumps() {
        let generated = generated_source("vec![\"Eisen\", \"Kupfer\"]", "expression").unwrap();
        assert_eq!(generated.prefix_len, EXPRESSION_PREFIX.len());
        assert!(generated.code.contains(
            "let wert = vec![\"Eisen\", \"Kupfer\"];"
        ));
        assert!(generated.code.contains("scratchpad::dump(&wert);"));
    }

    #[test]
    fn statements_mode_wraps_in_main() {
        let generated = generated_source("let menge = 3;\nprintln!(\"{menge}\");", "statements")
            .unwrap();
        assert_eq!(generated.prefix_len, STATEMENTS_PREFIX.len());
        assert!(generated.code.starts_with("fn main() {\nlet menge"));
        assert!(generated.code.ends_with("\n}\n"));
    }

    #[test]
    fn generated_prefix_maps_utf16_positions_after_emoji() {
        let source = r#"let _erz = "🦀"; let _menge: u32 = "42";"#;
        let prefix = STATEMENTS_PREFIX.len();
        let start = source.find("\"42\"").unwrap();
        let end = start + "\"42\"".len();

        let range = map_range(source, prefix, prefix + start, prefix + end).unwrap();
        let expected_from = source[..start].chars().map(char::len_utf16).sum::<usize>();
        let expected_to = source[..end].chars().map(char::len_utf16).sum::<usize>();

        assert_eq!(range.from, expected_from);
        assert_eq!(range.to, expected_to);
    }

    #[test]
    fn spans_outside_the_editor_text_stay_unmapped() {
        assert!(map_range("x", 5, 0, 5).is_none());
        assert!(map_range("x", 0, 0, 2).is_none());
        assert!(map_range("x", 0, 1, 2).is_none());
    }
}
