use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::snippets::{data_root, normalize_language, normalize_name};

/// Aufbewahrte Läufe pro Snippet.
pub const MAX_RUNS: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRange {
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDiagnostic {
    pub message: String,
    pub severity: String,
    pub code: Option<String>,
    pub range: Option<RunRange>,
    pub rendered: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    /// Startzeit als Millisekunden seit Unix-Epoche.
    pub started_at: i64,
    pub duration_ms: u64,
    pub status: String,
    pub language: String,
    pub mode: String,
    pub source: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub diagnostics: Vec<RunDiagnostic>,
    pub values: Vec<serde_json::Value>,
}

fn history_root() -> Result<PathBuf, String> {
    Ok(data_root()?.join("history"))
}

fn record_path_in(root: &Path, name: &str, language: &str) -> Result<PathBuf, String> {
    let name = normalize_name(name)?;
    let language = normalize_language(language)?;
    Ok(root.join(language).join(format!("{name}.json")))
}

fn read_records(path: &Path) -> Result<Vec<RunRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Verlauf {} nicht lesbar: {error}", path.display()))?;
    let mut records: Vec<RunRecord> = serde_json::from_str(&raw)
        .map_err(|error| format!("Verlauf {} ist beschädigt: {error}", path.display()))?;
    records.truncate(MAX_RUNS);
    Ok(records)
}

fn write_records(path: &Path, records: &[RunRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Verlaufsordner nicht anlegbar: {error}"))?;
    }
    let json = serde_json::to_vec_pretty(records)
        .map_err(|error| format!("Verlauf nicht serialisierbar: {error}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|error| format!("Verlauf nicht schreibbar: {error}"))?;
    fs::rename(&temp, path).map_err(|error| format!("Verlauf nicht aktualisierbar: {error}"))
}

pub fn list_in(root: &Path, name: &str, language: &str) -> Result<Vec<RunRecord>, String> {
    let path = record_path_in(root, name, language)?;
    read_records(&path)
}

pub fn save_in(
    root: &Path,
    name: &str,
    language: &str,
    run: RunRecord,
) -> Result<(), String> {
    let path = record_path_in(root, name, language)?;
    let mut records = read_records(&path)?;
    records.retain(|existing| existing.id != run.id);
    records.insert(0, run);
    records.truncate(MAX_RUNS);
    write_records(&path, &records)
}

/// Läufe des benannten Snippets, neueste zuerst.
pub fn list(name: &str, language: &str) -> Result<Vec<RunRecord>, String> {
    list_in(&history_root()?, name, language)
}

/// Speichert einen abgeschlossenen Lauf und behält die zehn neuesten.
pub fn save(name: &str, language: &str, run: RunRecord) -> Result<(), String> {
    save_in(&history_root()?, name, language, run)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("kritzelwerk-history-{label}-{nanos}"))
    }

    fn run(id: usize) -> RunRecord {
        RunRecord {
            id: format!("run-{id}"),
            started_at: 1_700_000_000_000 + id as i64,
            duration_ms: id as u64,
            status: "success".to_string(),
            language: "rust".to_string(),
            mode: "program".to_string(),
            source: format!("fn main() {{ println!({id}); }}"),
            stdout: format!("{id}\n"),
            stderr: String::new(),
            exit_code: Some(0),
            diagnostics: Vec::new(),
            values: vec![serde_json::json!({ "lauf": id })],
        }
    }

    #[test]
    fn keeps_only_the_newest_ten_runs() {
        let root = temp_root("trim");
        for index in 0..13 {
            save_in(&root, "verlauf", "rust", run(index)).expect("save");
        }

        let records = list_in(&root, "verlauf", "rust").expect("list");
        assert_eq!(records.len(), MAX_RUNS);
        assert_eq!(records[0].id, "run-12");
        assert_eq!(records[9].id, "run-3");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn separates_languages_for_the_same_name() {
        let root = temp_root("languages");
        save_in(&root, "gleich", "rust", run(1)).expect("rust");
        let mut java_run = run(2);
        java_run.language = "java".to_string();
        save_in(&root, "gleich", "java", java_run).expect("java");

        assert_eq!(list_in(&root, "gleich", "rust").expect("list").len(), 1);
        assert_eq!(list_in(&root, "gleich", "java").expect("list").len(), 1);

        let rust = list_in(&root, "gleich", "rust").expect("rust list");
        let java = list_in(&root, "gleich", "java").expect("java list");
        assert_eq!(rust[0].language, "rust");
        assert_eq!(java[0].language, "java");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reports_corrupted_files() {
        let root = temp_root("broken");
        let path = record_path_in(&root, "kaputt", "rust").expect("path");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, "kein json").expect("write");

        assert!(list_in(&root, "kaputt", "rust").is_err());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_invalid_names() {
        let root = temp_root("names");
        assert!(list_in(&root, "../falsch", "rust").is_err());
        fs::remove_dir_all(root).ok();
    }
}
