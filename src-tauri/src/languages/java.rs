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

const COMPILER_SOURCE: &str = r#"import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class KritzelwerkCompile {
    public static void main(String[] args) throws Exception {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            System.err.println("KRITZELWERK_NO_JDK");
            System.exit(2);
        }

        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        StandardJavaFileManager fileManager = compiler.getStandardFileManager(
            diagnostics, Locale.ROOT, StandardCharsets.UTF_8);
        Iterable<? extends JavaFileObject> units =
            fileManager.getJavaFileObjectsFromPaths(List.of(Path.of(args[0])));
        List<String> options = List.of(
            "-d", args[1], "-encoding", "UTF-8", "-proc:none");
        boolean ok = compiler.getTask(null, fileManager, diagnostics, options, null, units).call();

        PrintStream out = new PrintStream(
            new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
            String sourceName = diagnostic.getSource() == null
                ? ""
                : diagnostic.getSource().getName();
            out.println("KW_DIAG\t" + diagnostic.getKind().name()
                + "\t" + diagnostic.getStartPosition()
                + "\t" + diagnostic.getEndPosition()
                + "\t" + diagnostic.getLineNumber()
                + "\t" + diagnostic.getColumnNumber()
                + "\t" + esc(diagnostic.getCode())
                + "\t" + esc(diagnostic.getMessage(Locale.ROOT))
                + "\t" + esc(sourceName));
        }
        out.println("KW_RESULT\t" + (ok ? "OK" : "FAIL"));
        fileManager.close();
        System.exit(ok ? 0 : 1);
    }

    private static String esc(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\")
            .replace("\t", "\\t")
            .replace("\r", "\\r")
            .replace("\n", "\\n");
    }
}
"#;

pub fn run(source: &str, mode: &str) -> Result<SnippetResult, String> {
    if mode != "program" {
        return Err("Java ist nur im Programmmodus verfügbar.".to_string());
    }

    let project = work_dir()?;
    let classes = project.join("classes");
    if classes.exists() {
        fs::remove_dir_all(&classes)
            .map_err(|error| format!("Alte Java-Klassen nicht entfernbar: {error}"))?;
    }
    fs::create_dir_all(&classes)
        .map_err(|error| format!("Java-Klassenordner nicht anlegbar: {error}"))?;

    fs::write(project.join("Main.java"), source)
        .map_err(|error| format!("Java-Quelle nicht schreibbar: {error}"))?;
    let compiler_source = project.join("KritzelwerkCompile.java");
    if fs::read_to_string(&compiler_source)
        .map(|existing| existing != COMPILER_SOURCE)
        .unwrap_or(true)
    {
        fs::write(&compiler_source, COMPILER_SOURCE)
            .map_err(|error| format!("Java-Compiler-Helfer nicht schreibbar: {error}"))?;
    }

    let output = Command::new("java")
        .args(["KritzelwerkCompile.java", "Main.java", "classes"])
        .current_dir(&project)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let output = match output {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(java_missing_result());
        }
        Err(error) => {
            return Err(format!("Java konnte nicht gestartet werden: {error}"));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if stderr.contains("KRITZELWERK_NO_JDK") || stdout.contains("KRITZELWERK_NO_JDK") {
        return Ok(java_missing_result());
    }

    let mut diagnostics = Vec::new();
    let mut compile_ok = false;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("KW_RESULT\t") {
            compile_ok = rest == "OK";
            continue;
        }
        let Some(rest) = line.strip_prefix("KW_DIAG\t") else {
            continue;
        };
        let fields: Vec<&str> = rest.split('\t').collect();
        if fields.len() < 8 {
            continue;
        }
        let Some(diagnostic) = parse_diagnostic(&fields, source) else {
            continue;
        };
        diagnostics.push(diagnostic);
    }

    if !compile_ok {
        if diagnostics.is_empty() {
            return Ok(SnippetResult {
                status: SnippetStatus::BuildError,
                stdout: String::new(),
                stderr: if stderr.trim().is_empty() {
                    "Java-Kompilierung fehlgeschlagen.".to_string()
                } else {
                    stderr.trim_end().to_string()
                },
                diagnostics,
                exit_code: None,
                values: Vec::new(),
            });
        }
        return Ok(SnippetResult {
            status: SnippetStatus::BuildError,
            stdout: String::new(),
            stderr: stderr.trim_end().to_string(),
            diagnostics,
            exit_code: None,
            values: Vec::new(),
        });
    }

    if !classes.join("Main.class").exists() {
        return Ok(SnippetResult {
            status: SnippetStatus::BuildError,
            stdout: String::new(),
            stderr: "Es wurde keine Main.class erzeugt. Erwartet wird eine Klasse Main mit main(String[])."
                .to_string(),
            diagnostics,
            exit_code: None,
            values: Vec::new(),
        });
    }

    run_main(&project, &classes, diagnostics)
}

fn parse_diagnostic(fields: &[&str], source: &str) -> Option<Diagnostic> {
    let kind = fields[0];
    let start = fields[1].parse::<i64>().ok()?;
    let end = fields[2].parse::<i64>().ok()?;
    let line = fields[3].parse::<i64>().unwrap_or(-1);
    let column = fields[4].parse::<i64>().unwrap_or(-1);
    let code = unescape(fields[5]);
    let message = unescape(fields[6]);

    let severity = if kind == "ERROR" {
        DiagnosticSeverity::Error
    } else {
        DiagnosticSeverity::Warning
    };
    let range = diagnostic_range(source, start, end);
    let rendered = render_diagnostic(source, line, column, &message, severity);
    Some(Diagnostic {
        message,
        severity,
        code: if code.is_empty() { None } else { Some(code) },
        range,
        rendered,
    })
}

fn diagnostic_range(source: &str, start: i64, end: i64) -> Option<DiagnosticRange> {
    if start < 0 {
        return None;
    }
    let length = source.encode_utf16().count();
    let from = usize::try_from(start).ok()?;
    let to = usize::try_from(end.max(start)).ok()?;
    if from > length || to > length {
        return None;
    }
    Some(DiagnosticRange { from, to })
}

fn render_diagnostic(
    source: &str,
    line: i64,
    column: i64,
    message: &str,
    severity: DiagnosticSeverity,
) -> String {
    let severity_text = match severity {
        DiagnosticSeverity::Error => "error",
        DiagnosticSeverity::Warning => "warning",
    };
    if line <= 0 {
        return format!("Main.java: {severity_text}: {message}");
    }
    let line_text = source
        .lines()
        .nth((line - 1) as usize)
        .unwrap_or("");
    let caret = if column > 0 {
        " ".repeat((column - 1) as usize) + "^"
    } else {
        String::new()
    };
    if caret.is_empty() {
        format!("Main.java:{line}: {severity_text}: {message}\n{line_text}")
    } else {
        format!("Main.java:{line}: {severity_text}: {message}\n{line_text}\n{caret}")
    }
}

fn unescape(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            result.push(character);
            continue;
        }
        match chars.next() {
            Some('n') => result.push('\n'),
            Some('r') => result.push('\r'),
            Some('t') => result.push('\t'),
            Some('\\') => result.push('\\'),
            Some(other) => {
                result.push('\\');
                result.push(other);
            }
            None => result.push('\\'),
        }
    }
    result
}

fn run_main(
    project: &Path,
    classes: &Path,
    diagnostics: Vec<Diagnostic>,
) -> Result<SnippetResult, String> {
    let spawned = Command::new("java")
        .args(["-cp", &classes.to_string_lossy(), "Main"])
        .current_dir(project)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return Err(format!("Java-Programm konnte nicht gestartet werden: {error}"));
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
            Err(error) => return Err(format!("Java-Status nicht lesbar: {error}")),
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
            diagnostics,
            exit_code: None,
            values: Vec::new(),
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
        values: Vec::new(),
    })
}

fn java_missing_result() -> SnippetResult {
    SnippetResult {
        status: SnippetStatus::BuildError,
        stdout: String::new(),
        stderr: "OpenJDK 21 ist nicht verfügbar. Bitte die Nix-Dev-Shell (jdk21) verwenden."
            .to_string(),
        diagnostics: Vec::new(),
        exit_code: None,
        values: Vec::new(),
    }
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

fn work_dir() -> Result<PathBuf, String> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| "Kein Cache-Verzeichnis gefunden (HOME/XDG_CACHE_HOME fehlt).".to_string())?;
    let project = cache.join("kritzelwerk").join("java-snippet");
    fs::create_dir_all(&project)
        .map_err(|error| format!("Java-Arbeitsverzeichnis nicht anlegbar: {error}"))?;
    Ok(project)
}
