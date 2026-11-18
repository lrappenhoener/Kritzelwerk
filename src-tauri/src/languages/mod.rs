mod rust;

use serde::Serialize;

/// Zustand eines Snippet-Laufs.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnippetStatus {
    Success,
    BuildError,
    RunError,
    Timeout,
}

/// Gemeinsames Ergebnisformat aller Sprachadapter.
#[derive(Debug, Serialize)]
pub struct SnippetResult {
    pub status: SnippetStatus,
    pub stdout: String,
    pub stderr: String,
    pub diagnostics: Vec<String>,
    pub exit_code: Option<i32>,
}

/// Leitet einen Lauf anhand der Sprach-ID an den passenden Adapter weiter.
pub fn run(language: &str, source: &str) -> Result<SnippetResult, String> {
    match language {
        "rust" => rust::run(source),
        other => Err(format!("Nicht unterstützte Sprache: {other}")),
    }
}
