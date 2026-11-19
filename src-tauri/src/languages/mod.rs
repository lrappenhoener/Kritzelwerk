mod java;
mod javascript;
mod rust;

use serde::Serialize;

/// Quelle der `scratchpad`-Bibliothek, die in jedem Cargo-Projekt liegt.
pub(crate) const SCRATCHPAD_SOURCE: &str = rust::SCRATCHPAD_SOURCE;

/// Erzeugt den vollständigen `src/main.rs`-Inhalt für einen Modus.
pub(crate) fn generated_main(source: &str, mode: &str) -> Result<String, String> {
    rust::generated_main(source, mode)
}

/// Erzeugt das Analyseprojekt für rust-analyzer aus der Konfiguration des
/// angegebenen Snippets und liefert seinen Pfad.
pub(crate) fn analysis_project(snippet: Option<&str>) -> Result<std::path::PathBuf, String> {
    rust::analysis_project(snippet)
}

/// Baut ein Programm im Debug-Profil für den Debugger.
pub(crate) fn debug_build(
    source: &str,
    snippet: Option<&str>,
) -> Result<rust::DebugBuild, String> {
    rust::debug_build(source, snippet)
}

/// Zustand eines Snippet-Laufs.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnippetStatus {
    Success,
    BuildError,
    RunError,
    Timeout,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

/// Textbereich als UTF-16-Offsets in den ausgeführten Quelltext
/// (CodeMirror-kompatibel, nicht bytebasiert).
#[derive(Debug, Serialize)]
pub struct DiagnosticRange {
    pub from: usize,
    pub to: usize,
}

/// Eine einzelne Compiler-Meldung.
///
/// `rendered` enthält die vollständige, von rustc formatierte Meldung für die
/// Textausgabe. `range` ist `None`, wenn keine primäre Span in der
/// kompilierten `src/main.rs` liegt; solche Meldungen erscheinen nur als Text.
#[derive(Debug, Serialize)]
pub struct Diagnostic {
    pub message: String,
    pub severity: DiagnosticSeverity,
    pub code: Option<String>,
    pub range: Option<DiagnosticRange>,
    pub rendered: String,
}

/// Gemeinsames Ergebnisformat aller Sprachadapter.
#[derive(Debug, Serialize)]
pub struct SnippetResult {
    pub status: SnippetStatus,
    pub stdout: String,
    pub stderr: String,
    pub diagnostics: Vec<Diagnostic>,
    pub exit_code: Option<i32>,
    /// Strukturierte Werte aus `dump()`-Aufrufen, in Aufrufreihenfolge.
    pub values: Vec<serde_json::Value>,
}

/// Leitet einen Lauf anhand von Sprach-ID und Ausführungsmodus weiter.
pub fn run(
    language: &str,
    source: &str,
    snippet: Option<&str>,
    mode: &str,
) -> Result<SnippetResult, String> {
    match language {
        "rust" => rust::run(source, snippet, mode),
        "java" => java::run(source, mode),
        "javascript" => javascript::run(source, mode),
        other => Err(format!("Nicht unterstützte Sprache: {other}")),
    }
}
