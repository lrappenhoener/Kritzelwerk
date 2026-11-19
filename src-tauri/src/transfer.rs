use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::dependencies::{self, DependencySpec};
use crate::languages;
use crate::snippets;

const FORMAT: &str = "kritzelwerk-snippet";
const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct SnippetFile {
    format: String,
    version: u32,
    name: String,
    contents: String,
    mode: String,
    #[serde(default)]
    dependencies: Vec<DependencySpec>,
    #[serde(default)]
    lockfile: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub version: u32,
    pub name: String,
    pub mode: String,
    pub dependencies: Vec<DependencySpec>,
    pub has_lockfile: bool,
    pub name_taken: bool,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectExportResult {
    pub path: String,
    pub locked: bool,
}

/// Schreibt ein Snippet als versionierte `.kritzelwerk.json`-Datei.
pub fn export_snippet_file(
    path: &str,
    name: &str,
    contents: &str,
    mode: &str,
) -> Result<ExportResult, String> {
    let name = snippets::normalize_name(name)?;
    if !snippets::exists(&name, "rust")? {
        return Err(format!("Snippet „{name}“ wurde nicht gefunden."));
    }
    let mode = snippets::normalize_mode(mode)?.to_string();
    let dependencies = dependencies::load_specs(&name)?;
    let lockfile = dependencies::lock_contents(&name)?;

    let file = SnippetFile {
        format: FORMAT.to_string(),
        version: VERSION,
        name: name.clone(),
        contents: contents.to_string(),
        mode,
        dependencies,
        lockfile,
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|error| format!("Snippet nicht serialisierbar: {error}"))?;

    let target = expand_path(path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Zielordner nicht anlegbar: {error}"))?;
    }
    write_new(&target, &format!("{json}\n"))?;
    Ok(ExportResult {
        path: target.display().to_string(),
    })
}

/// Liest und validiert eine Importdatei, ohne sie zu übernehmen.
pub fn inspect_import(path: &str) -> Result<ImportPreview, String> {
    let (file, name, mode, dependencies) = read_snippet_file(path)?;
    Ok(ImportPreview {
        version: file.version,
        name_taken: snippets::exists(&name, "rust")?,
        name,
        mode,
        dependencies,
        has_lockfile: file
            .lockfile
            .as_deref()
            .map(|lock| !lock.trim().is_empty())
            .unwrap_or(false),
    })
}

/// Übernimmt eine validierte Importdatei unter dem gewählten Namen.
pub fn import_snippet(path: &str, name: &str) -> Result<ImportResult, String> {
    let (file, _, mode, dependencies) = read_snippet_file(path)?;
    let target = snippets::normalize_name(name)?;
    if snippets::exists(&target, "rust")? {
        return Err(format!(
            "Ein Snippet „{target}“ existiert bereits. Bitte einen anderen Namen eingeben."
        ));
    }

    let save = snippets::save(&target, &file.contents, false, &mode, "rust")?;
    if !matches!(save.status, snippets::SaveStatus::Saved) {
        return Err(format!(
            "Ein Snippet „{target}“ existiert bereits. Bitte einen anderen Namen eingeben."
        ));
    }

    let lock = file
        .lockfile
        .as_deref()
        .filter(|lock| !lock.trim().is_empty());
    dependencies::store_imported(&target, dependencies, lock)?;
    Ok(ImportResult { name: target })
}

/// Erzeugt ein eigenständiges Cargo-Projekt aus dem aktuellen Snippet.
pub fn export_project(
    path: &str,
    name: &str,
    contents: &str,
    mode: &str,
) -> Result<ProjectExportResult, String> {
    let name = snippets::normalize_name(name)?;
    if !snippets::exists(&name, "rust")? {
        return Err(format!("Snippet „{name}“ wurde nicht gefunden."));
    }
    let mode = snippets::normalize_mode(mode)?;
    let dependencies = dependencies::load_specs(&name)?;
    let manifest = dependencies::manifest(&dependencies);
    let main = languages::generated_main(contents, mode)?;

    let lock = dependencies::lock_contents(&name)?;
    let lock = lock.filter(|lock| dependencies::lock_matches(&dependencies, lock));
    let locked = lock.is_some();

    let target = expand_path(path)?;
    if target.exists() {
        if !target.is_dir() {
            return Err("Das Ziel ist kein Ordner.".to_string());
        }
        if fs::read_dir(&target)
            .map_err(|error| format!("Zielordner nicht lesbar: {error}"))?
            .next()
            .is_some()
        {
            return Err(
                "Der Zielordner ist nicht leer. Es wurden keine Dateien geändert.".to_string(),
            );
        }
    } else {
        fs::create_dir_all(&target)
            .map_err(|error| format!("Zielordner nicht anlegbar: {error}"))?;
    }

    let src = target.join("src");
    fs::create_dir_all(&src).map_err(|error| format!("src-Ordner nicht anlegbar: {error}"))?;

    write_new(&target.join("Cargo.toml"), &manifest)?;
    write_new(&src.join("main.rs"), &main)?;
    write_new(&src.join("lib.rs"), languages::SCRATCHPAD_SOURCE)?;
    if let Some(lock) = &lock {
        write_new(&target.join("Cargo.lock"), lock)?;
    }

    let command = if locked {
        "cargo run --locked"
    } else {
        "cargo run"
    };
    let readme = format!(
        "# {name}\n\nExport aus Kritzelwerk.\n\nModus: {}\n\nStart:\n\n```bash\n{command}\n```\n\n`dump()` gibt formatiertes JSON auf stdout aus.\n",
        mode_label(mode)
    );
    write_new(&target.join("README.md"), &readme)?;

    Ok(ProjectExportResult {
        path: target.display().to_string(),
        locked,
    })
}

fn read_snippet_file(
    path: &str,
) -> Result<(SnippetFile, String, String, Vec<DependencySpec>), String> {
    let source = expand_path(path)?;
    let raw =
        fs::read_to_string(&source).map_err(|error| format!("Datei nicht lesbar: {error}"))?;
    let file: SnippetFile = serde_json::from_str(&raw)
        .map_err(|error| format!("Ungültige Kritzelwerk-Snippetdatei: {error}"))?;

    if file.format != FORMAT {
        return Err(format!(
            "Unbekanntes Dateiformat „{}“ (erwartet: {FORMAT}).",
            file.format
        ));
    }
    if file.version != VERSION {
        return Err(format!(
            "Formatversion {} wird nicht unterstützt (unterstützt: {VERSION}).",
            file.version
        ));
    }

    let name = snippets::normalize_name(&file.name)
        .map_err(|error| format!("Ungültiger Snippet-Name in der Datei: {error}"))?;
    let mode = snippets::normalize_mode(&file.mode)
        .map_err(|error| format!("Ungültiger Ausführungsmodus in der Datei: {error}"))?
        .to_string();
    let dependencies = dependencies::normalize_specs(file.dependencies.clone())?;

    Ok((file, name, mode, dependencies))
}

fn expand_path(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Bitte einen Pfad angeben.".to_string());
    }

    let path = if raw == "~" || raw.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "Kein Home-Verzeichnis gefunden.".to_string())?;
        if raw == "~" {
            home
        } else {
            home.join(&raw[2..])
        }
    } else {
        PathBuf::from(raw)
    };

    if !path.is_absolute() {
        return Err("Bitte einen absoluten Pfad oder ~/… angeben.".to_string());
    }
    Ok(path)
}

fn write_new(path: &Path, contents: &str) -> Result<(), String> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(contents.as_bytes())
            .map_err(|error| format!("{} nicht schreibbar: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "{} existiert bereits. Es wurde nichts überschrieben.",
            path.display()
        )),
        Err(error) => Err(format!("{} nicht schreibbar: {error}", path.display())),
    }
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "expression" => "Ausdruck",
        "statements" => "Anweisungen",
        _ => "Programm",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, version: &str) -> DependencySpec {
        DependencySpec {
            name: name.to_string(),
            version: version.to_string(),
            features: Vec::new(),
        }
    }

    #[test]
    fn expanded_paths_require_absolute_or_home() {
        assert!(expand_path("relative.json").is_err());
        assert!(expand_path("").is_err());
        let home = expand_path("~/test.json").unwrap();
        assert!(home.is_absolute());
    }

    #[test]
    fn lock_matching_checks_direct_dependencies() {
        let lock = r#"
version = 4

[[package]]
name = "kritzelwerk-snippet"
version = "0.0.0"

[[package]]
name = "regex"
version = "1.13.2"
"#;
        assert!(dependencies::lock_matches(&[spec("regex", "1")], lock));
        assert!(!dependencies::lock_matches(
            &[spec("serde_json", "1")],
            lock
        ));
    }
}
