use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MODES: [&str; 3] = ["expression", "statements", "program"];
const LANGUAGES: [&str; 3] = ["rust", "java", "javascript"];

#[derive(Debug, Serialize)]
pub struct SnippetInfo {
    pub name: String,
    pub language: String,
}

#[derive(Debug, Serialize)]
pub struct SnippetDocument {
    pub contents: String,
    pub mode: String,
    pub language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveStatus {
    Saved,
    Exists,
}

#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub status: SaveStatus,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredMeta {
    #[serde(default = "default_mode")]
    mode: String,
}

fn default_mode() -> String {
    "program".to_string()
}

pub fn list() -> Result<Vec<SnippetInfo>, String> {
    let dir = snippets_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut snippets = Vec::new();
    for entry in
        fs::read_dir(&dir).map_err(|error| format!("Snippet-Ordner nicht lesbar: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Snippet-Ordner nicht lesbar: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("Snippet nicht lesbar: {error}"))?
            .is_file()
        {
            continue;
        }
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some((stem, language)) = language_from_file_name(file_name) else {
            continue;
        };
        if !stem.is_empty() {
            snippets.push(SnippetInfo {
                name: stem.to_string(),
                language: language.to_string(),
            });
        }
    }

    snippets.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.language.cmp(&right.language))
    });
    Ok(snippets)
}

pub fn read(name: &str, language: &str) -> Result<SnippetDocument, String> {
    let name = normalize_name(name)?;
    let language = normalize_language(language)?;
    let path = snippet_path(&name, language)?;
    let extension = language_extension(language);
    let contents = fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("Snippet „{name}.{extension}“ wurde nicht gefunden.")
        } else {
            format!("Snippet „{name}“ nicht lesbar: {error}")
        }
    })?;

    Ok(SnippetDocument {
        contents,
        mode: if language == "rust" {
            read_mode(&name)?
        } else {
            "program".to_string()
        },
        language: language.to_string(),
    })
}

pub fn save(
    name: &str,
    contents: &str,
    overwrite: bool,
    mode: &str,
    language: &str,
) -> Result<SaveResult, String> {
    let name = normalize_name(name)?;
    let language = normalize_language(language)?;
    let mode = if language == "rust" {
        normalize_mode(mode)?
    } else {
        "program"
    };
    let dir = snippets_dir()?;
    fs::create_dir_all(&dir).map_err(|error| format!("Snippet-Ordner nicht anlegbar: {error}"))?;
    let path = snippet_path(&name, language)?;

    if overwrite {
        fs::write(&path, contents)
            .map_err(|error| format!("Snippet „{name}“ nicht speicherbar: {error}"))?;
        if language == "rust" {
            write_mode(&name, mode)?;
        }
        return Ok(SaveResult {
            status: SaveStatus::Saved,
            name,
        });
    }

    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(contents.as_bytes())
                .map_err(|error| format!("Snippet „{name}“ nicht speicherbar: {error}"))?;
            if language == "rust" {
                write_mode(&name, mode)?;
            }
            Ok(SaveResult {
                status: SaveStatus::Saved,
                name,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(SaveResult {
            status: SaveStatus::Exists,
            name,
        }),
        Err(error) => Err(format!("Snippet „{name}“ nicht speicherbar: {error}")),
    }
}

/// Gemeinsames lokales Datenverzeichnis für Snippets und Abhängigkeiten.
pub(crate) fn data_root() -> Result<PathBuf, String> {
    let base = env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|home| Path::new(&home).join(".local/share"))
        })
        .ok_or_else(|| {
            "Kein Datenverzeichnis gefunden (XDG_DATA_HOME/HOME fehlt).".to_string()
        })?;
    Ok(base.join("kritzelwerk"))
}

fn snippets_dir() -> Result<PathBuf, String> {
    Ok(data_root()?.join("snippets"))
}

fn snippet_path(name: &str, language: &str) -> Result<PathBuf, String> {
    let language = normalize_language(language)?;
    Ok(snippets_dir()?.join(format!("{name}.{}", language_extension(language))))
}

fn language_extension(language: &str) -> &'static str {
    match language {
        "java" => "java",
        "javascript" => "mjs",
        _ => "rs",
    }
}

pub(crate) fn language_from_file_name(file_name: &str) -> Option<(&str, &'static str)> {
    if let Some(stem) = file_name.strip_suffix(".rs") {
        return Some((stem, "rust"));
    }
    if let Some(stem) = file_name.strip_suffix(".java") {
        return Some((stem, "java"));
    }
    if let Some(stem) = file_name.strip_suffix(".mjs") {
        return Some((stem, "javascript"));
    }
    None
}

pub(crate) fn exists(name: &str, language: &str) -> Result<bool, String> {
    let name = normalize_name(name)?;
    Ok(snippet_path(&name, language)?.exists())
}

fn mode_path(name: &str) -> Result<PathBuf, String> {
    Ok(snippets_dir()?.join(format!("{name}.json")))
}

fn read_mode(name: &str) -> Result<String, String> {
    let path = mode_path(name)?;
    if !path.exists() {
        return Ok(default_mode());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Modus von „{name}“ nicht lesbar: {error}"))?;
    let stored: StoredMeta = serde_json::from_str(&raw)
        .map_err(|error| format!("Modusdatei von „{name}“ ist beschädigt: {error}"))?;
    Ok(normalize_mode(&stored.mode)?.to_string())
}

fn write_mode(name: &str, mode: &str) -> Result<(), String> {
    let path = mode_path(name)?;
    let stored = StoredMeta {
        mode: mode.to_string(),
    };
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|error| format!("Modus nicht speicherbar: {error}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, format!("{json}\n"))
        .map_err(|error| format!("Modusdatei nicht schreibbar: {error}"))?;
    fs::rename(&temp, &path)
        .map_err(|error| format!("Modusdatei nicht aktualisierbar: {error}"))
}

pub(crate) fn normalize_language(raw: &str) -> Result<&'static str, String> {
    let language = raw.trim();
    LANGUAGES
        .iter()
        .copied()
        .find(|candidate| *candidate == language)
        .ok_or_else(|| {
            format!("Unbekannte Sprache „{raw}“ (erlaubt: Rust, Java, JavaScript).")
        })
}

pub(crate) fn normalize_mode(raw: &str) -> Result<&'static str, String> {
    let mode = raw.trim();
    MODES
        .iter()
        .copied()
        .find(|candidate| *candidate == mode)
        .ok_or_else(|| {
            format!("Unbekannter Ausführungsmodus „{raw}“ (erlaubt: Ausdruck, Anweisungen, Programm).")
        })
}

pub(crate) fn normalize_name(raw: &str) -> Result<String, String> {
    let mut name = raw.trim();
    if name.to_lowercase().ends_with(".java") {
        name = &name[..name.len() - 5];
    } else if name.to_lowercase().ends_with(".mjs") {
        name = &name[..name.len() - 4];
    } else if name.to_lowercase().ends_with(".rs") {
        name = &name[..name.len() - 3];
    }
    let name = name.trim();

    if name.is_empty() {
        return Err("Der Name darf nicht leer sein.".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("Der Name darf keine Pfadtrenner enthalten.".to_string());
    }
    if name == "." || name == ".." {
        return Err("Der Name ist ungültig.".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("Der Name enthält ungültige Zeichen.".to_string());
    }

    Ok(name.to_string())
}
