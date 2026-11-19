use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::snippets;

const RESERVED_NAMES: [&str; 3] = ["scratchpad", "serde", "serde_json"];
const MANIFEST_HEAD: &str = r#"[package]
name = "kritzelwerk-snippet"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
name = "scratchpad"
path = "src/lib.rs"

[[bin]]
name = "snippet"
path = "src/main.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
"#;

/// Eine vom Nutzer erfasste Abhängigkeit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencySpec {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub features: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DependencyEntry {
    pub name: String,
    pub version: String,
    pub features: Vec<String>,
    pub resolved: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DependencyConfig {
    pub snippet: String,
    pub dependencies: Vec<DependencyEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredDependencies {
    #[serde(default = "stored_version")]
    version: u32,
    #[serde(default)]
    dependencies: Vec<DependencySpec>,
}

fn stored_version() -> u32 {
    1
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Merkt eine laufende Auflösung zum Abbruch vor.
pub fn cancel(request_id: &str) {
    if let Ok(mut cancelled) = cancelled().lock() {
        cancelled.insert(request_id.to_string());
    }
}

/// Liefert die gespeicherten Abhängigkeiten für ein Snippet.
pub fn load_specs(name: &str) -> Result<Vec<DependencySpec>, String> {
    let name = snippets::normalize_name(name)?;
    let path = metadata_path(&name)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Abhängigkeiten von „{name}“ nicht lesbar: {error}"))?;
    let stored: StoredDependencies = serde_json::from_str(&raw)
        .map_err(|error| format!("Abhängigkeitsdatei von „{name}“ ist beschädigt: {error}"))?;
    normalize_specs(stored.dependencies)
}

pub fn config(name: &str) -> Result<DependencyConfig, String> {
    let name = snippets::normalize_name(name)?;
    let specs = load_specs(&name)?;
    let resolved = resolved_versions(&name)?;
    Ok(DependencyConfig {
        snippet: name,
        dependencies: specs
            .into_iter()
            .map(|spec| DependencyEntry {
                resolved: resolved.get(&spec.name).cloned(),
                name: spec.name,
                version: spec.version,
                features: spec.features,
            })
            .collect(),
    })
}

pub fn lock_path(name: &str) -> Result<PathBuf, String> {
    let name = snippets::normalize_name(name)?;
    Ok(dependencies_dir()?.join(&name).join("Cargo.lock"))
}

/// Löst die Abhängigkeiten in einem temporären Projekt auf und übernimmt
/// Manifest und Lockfile erst nach erfolgreicher Auflösung.
pub fn resolve(
    name: &str,
    dependencies: Vec<DependencySpec>,
    request_id: &str,
) -> Result<DependencyConfig, String> {
    let name = snippets::normalize_name(name)?;
    let specs = normalize_specs(dependencies)?;

    if let Ok(mut cancelled) = cancelled().lock() {
        cancelled.remove(request_id);
    }

    let project = temp_project(&specs)?;
    let outcome = resolve_project(&project)
        .and_then(|_| read_lock(&project))
        .and_then(|lock| commit(&name, &specs, &lock, request_id));

    let _ = fs::remove_dir_all(&project);
    if let Ok(mut cancelled) = cancelled().lock() {
        cancelled.remove(request_id);
    }

    outcome?;
    config(&name)
}

fn resolve_project(project: &Path) -> Result<(), String> {
    let output = Command::new("cargo")
        .args([
            "generate-lockfile",
            "--manifest-path",
            &project.join("Cargo.toml").to_string_lossy(),
        ])
        .current_dir(project)
        .env("CARGO_TERM_COLOR", "never")
        .output()
        .map_err(|error| format!("Cargo konnte nicht gestartet werden: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(cargo_error(&stderr))
}

fn read_lock(project: &Path) -> Result<String, String> {
    fs::read_to_string(project.join("Cargo.lock"))
        .map_err(|error| format!("Cargo-Lockfile nicht lesbar: {error}"))
}

fn commit(
    name: &str,
    specs: &[DependencySpec],
    lock: &str,
    request_id: &str,
) -> Result<(), String> {
    let mut cancelled = cancelled()
        .lock()
        .map_err(|_| "Auflösung ist gesperrt.".to_string())?;
    if cancelled.remove(request_id) {
        return Err("Abhängigkeitsauflösung abgebrochen.".to_string());
    }

    let dir = dependencies_dir()?.join(name);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Abhängigkeitsordner nicht anlegbar: {error}"))?;
    write_stored(&dir, specs, Some(lock))
}

/// Übernimmt importierte Abhängigkeiten samt optionalem Lockfile.
pub(crate) fn store_imported(
    name: &str,
    dependencies: Vec<DependencySpec>,
    lock: Option<&str>,
) -> Result<(), String> {
    let name = snippets::normalize_name(name)?;
    let specs = normalize_specs(dependencies)?;
    if specs.is_empty() && lock.is_none() {
        return Ok(());
    }

    let dir = dependencies_dir()?.join(name);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Abhängigkeitsordner nicht anlegbar: {error}"))?;
    write_stored(&dir, &specs, lock)
}

/// Liefert den gespeicherten Lockfile-Inhalt, falls vorhanden.
pub(crate) fn lock_contents(name: &str) -> Result<Option<String>, String> {
    let path = lock_path(name)?;
    match fs::read_to_string(&path) {
        Ok(lock) => Ok(Some(lock)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cargo.lock nicht lesbar: {error}")),
    }
}

/// Prüft grob, ob ein Lockfile zum Manifest mit diesen Abhängigkeiten passt.
pub(crate) fn lock_matches(dependencies: &[DependencySpec], lock: &str) -> bool {
    let packages = parse_lock(lock);
    packages.contains_key("kritzelwerk-snippet")
        && dependencies
            .iter()
            .all(|dependency| packages.contains_key(&dependency.name))
}

fn write_stored(
    dir: &Path,
    specs: &[DependencySpec],
    lock: Option<&str>,
) -> Result<(), String> {
    let stored = StoredDependencies {
        version: stored_version(),
        dependencies: specs.to_vec(),
    };
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|error| format!("Abhängigkeiten nicht speicherbar: {error}"))?;

    // Alle Dateien zuerst schreiben; erst danach werden sie sichtbar
    // ausgetauscht, damit eine fehlgeschlagene Auflösung die alte
    // Konfiguration nicht beschädigt.
    let json_path = dir.join("dependencies.json");
    let json_temp = dir.join("dependencies.json.tmp");
    fs::write(&json_temp, format!("{json}\n"))
        .map_err(|error| format!("Abhängigkeiten nicht schreibbar: {error}"))?;

    if let Some(lock) = lock {
        let lock_path = dir.join("Cargo.lock");
        let lock_temp = dir.join("Cargo.lock.tmp");
        fs::write(&lock_temp, lock)
            .map_err(|error| format!("Cargo.lock nicht schreibbar: {error}"))?;
        fs::rename(&lock_temp, &lock_path)
            .map_err(|error| format!("Cargo.lock nicht aktualisierbar: {error}"))?;
    } else {
        let lock_path = dir.join("Cargo.lock");
        if lock_path.exists() {
            fs::remove_file(&lock_path)
                .map_err(|error| format!("Cargo.lock nicht entfernbar: {error}"))?;
        }
    }

    fs::rename(&json_temp, &json_path)
        .map_err(|error| format!("Abhängigkeiten nicht aktualisierbar: {error}"))
}

/// Erzeugt das Cargo-Manifest aus den erfassten Abhängigkeiten.
pub fn manifest(dependencies: &[DependencySpec]) -> String {
    let mut manifest = String::from(MANIFEST_HEAD);
    for dependency in dependencies {
        manifest.push_str(&format!("{} = ", dependency.name));
        if dependency.features.is_empty() {
            manifest.push_str(&toml_string(&dependency.version));
        } else {
            let features = dependency
                .features
                .iter()
                .map(|feature| toml_string(feature))
                .collect::<Vec<_>>()
                .join(", ");
            manifest.push_str(&format!(
                "{{ version = {}, features = [{}] }}",
                toml_string(&dependency.version),
                features
            ));
        }
        manifest.push('\n');
    }
    manifest.push_str("\n[workspace]\n");
    manifest
}

/// Schreibt Manifest und Lockfile für ein Snippet in ein Cargo-Projekt.
/// Liefert `true`, wenn ein Lockfile vorhanden ist und `--locked` verwendet
/// werden muss.
pub fn prepare_project(project: &Path, snippet: Option<&str>) -> Result<bool, String> {
    let specs = match snippet {
        Some(name) => load_specs(name)?,
        None => Vec::new(),
    };

    write_if_changed(&project.join("Cargo.toml"), &manifest(&specs))?;

    let target_lock = project.join("Cargo.lock");
    let saved_lock = match snippet {
        Some(name) => {
            let path = lock_path(name)?;
            if path.exists() { Some(path) } else { None }
        }
        None => None,
    };

    match saved_lock {
        Some(source) => {
            fs::copy(&source, &target_lock).map_err(|error| {
                format!(
                    "Cargo.lock von „{}“ nicht übernehmbar: {error}",
                    source.display()
                )
            })?;
            Ok(true)
        }
        None => {
            if target_lock.exists() {
                fs::remove_file(&target_lock)
                    .map_err(|error| format!("Altes Cargo.lock nicht entfernbar: {error}"))?;
            }
            Ok(false)
        }
    }
}

pub(crate) fn normalize_specs(
    dependencies: Vec<DependencySpec>,
) -> Result<Vec<DependencySpec>, String> {
    let mut specs = Vec::with_capacity(dependencies.len());
    let mut seen = HashSet::new();

    for dependency in dependencies {
        let name = dependency.name.trim().to_string();
        let version = dependency.version.trim().to_string();
        if name.is_empty() {
            return Err("Bitte für jede Abhängigkeit einen Crate-Namen angeben.".to_string());
        }
        if !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        {
            return Err(format!(
                "„{name}“ ist kein gültiger Crate-Name (erlaubt: Buchstaben, Ziffern, _ und -)."
            ));
        }
        let lower = name.to_ascii_lowercase();
        if RESERVED_NAMES.contains(&lower.as_str()) {
            return Err(format!(
                "„{name}“ wird bereits von der scratchpad-Bibliothek bereitgestellt."
            ));
        }
        if version.is_empty() {
            return Err(format!("Für „{name}“ fehlt die Versionsanforderung."));
        }
        if !seen.insert(lower) {
            return Err(format!("„{name}“ ist doppelt eingetragen."));
        }

        let mut features = Vec::new();
        for feature in dependency.features {
            let feature = feature.trim();
            if !feature.is_empty() && !features.iter().any(|existing| existing == feature) {
                features.push(feature.to_string());
            }
        }

        specs.push(DependencySpec {
            name,
            version,
            features,
        });
    }

    Ok(specs)
}

fn dependencies_dir() -> Result<PathBuf, String> {
    Ok(snippets::data_root()?.join("dependencies"))
}

fn metadata_path(name: &str) -> Result<PathBuf, String> {
    Ok(dependencies_dir()?.join(name).join("dependencies.json"))
}

fn resolved_versions(name: &str) -> Result<BTreeMap<String, String>, String> {
    let path = lock_path(name)?;
    let Ok(lock) = fs::read_to_string(path) else {
        return Ok(BTreeMap::new());
    };
    Ok(parse_lock(&lock))
}

fn parse_lock(lock: &str) -> BTreeMap<String, String> {
    let mut versions = BTreeMap::new();
    let mut package: Option<String> = None;

    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            package = None;
        } else if let Some(value) = line.strip_prefix("name = ") {
            package = Some(unquote(value));
        } else if let Some(value) = line.strip_prefix("version = ") {
            if let Some(name) = package.take() {
                versions.entry(name).or_insert_with(|| unquote(value));
            }
        }
    }

    versions
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
}

fn toml_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn temp_project(specs: &[DependencySpec]) -> Result<PathBuf, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir()
        .join("kritzelwerk")
        .join(format!("resolve-{}-{nanos}-{sequence}", std::process::id()));

    fs::create_dir_all(dir.join("src"))
        .map_err(|error| format!("Temporäres Cargo-Projekt nicht anlegbar: {error}"))?;
    fs::write(dir.join("Cargo.toml"), manifest(specs))
        .map_err(|error| format!("Temporäres Manifest nicht schreibbar: {error}"))?;
    fs::write(dir.join("src/lib.rs"), crate::languages::SCRATCHPAD_SOURCE)
        .map_err(|error| format!("Temporäre scratchpad-Quelle nicht schreibbar: {error}"))?;
    fs::write(dir.join("src/main.rs"), "fn main() {}\n")
        .map_err(|error| format!("Temporäre Hauptquelle nicht schreibbar: {error}"))?;

    Ok(dir)
}

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if fs::read_to_string(path)
        .map(|existing| existing == contents)
        .unwrap_or(false)
    {
        return Ok(());
    }
    fs::write(path, contents)
        .map_err(|error| format!("{} nicht schreibbar: {error}", path.display()))
}

/// Formuliert typische Cargo-Fehler verständlich und behält die Details bei.
fn cargo_error(stderr: &str) -> String {
    let details = stderr.trim();
    let lower = details.to_ascii_lowercase();

    if let Some(start) = details.find("no matching package named `") {
        let rest = &details[start + "no matching package named `".len()..];
        if let Some(end) = rest.find('`') {
            let crate_name = &rest[..end];
            return format!(
                "Die Crate „{crate_name}“ wurde auf crates.io nicht gefunden.\n\n{details}"
            );
        }
    }

    if lower.contains("failed to select a version for the requirement") {
        return format!(
            "Für die Versionsanforderung wurde auf crates.io keine passende Version gefunden.\n\n{details}"
        );
    }

    if lower.contains("failed to fetch")
        || lower.contains("network failure")
        || lower.contains("couldn't connect")
        || lower.contains("timed out")
    {
        return format!(
            "crates.io ist nicht erreichbar. Prüfe die Netzwerkverbindung und versuche es erneut.\n\n{details}"
        );
    }

    format!("Cargo konnte die Abhängigkeiten nicht auflösen.\n\n{details}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, version: &str, features: &[&str]) -> DependencySpec {
        DependencySpec {
            name: name.to_string(),
            version: version.to_string(),
            features: features.iter().map(|value| value.to_string()).collect(),
        }
    }

    #[test]
    fn manifest_contains_base_and_extra_dependencies() {
        let manifest = manifest(&[spec("regex", "1", &[])]);
        assert!(manifest.contains("edition = \"2021\""));
        assert!(manifest.contains("name = \"scratchpad\""));
        assert!(manifest.contains("serde_json = \"1\""));
        assert!(manifest.contains("regex = \"1\""));
        assert!(manifest.ends_with("[workspace]\n"));
    }

    #[test]
    fn manifest_renders_features() {
        let manifest = manifest(&[spec("serde_with", "3", &["macros", "json"])]);
        assert!(
            manifest
                .contains("serde_with = { version = \"3\", features = [\"macros\", \"json\"] }")
        );
    }

    #[test]
    fn reserve_and_duplicate_names_are_rejected() {
        assert!(normalize_specs(vec![spec("serde", "1", &[])]).is_err());
        assert!(normalize_specs(vec![spec("regex", "1", &[]), spec("Regex", "1", &[])]).is_err());
        assert!(normalize_specs(vec![spec("regex", "", &[])]).is_err());
        assert!(normalize_specs(vec![spec("bad name", "1", &[])]).is_err());
    }

    #[test]
    fn lock_parser_reads_package_versions() {
        let lock = r#"
version = 4

[[package]]
name = "regex"
version = "1.13.2"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.228"
"#;
        let versions = parse_lock(lock);
        assert_eq!(versions.get("regex").map(String::as_str), Some("1.13.2"));
        assert_eq!(versions.get("serde").map(String::as_str), Some("1.0.228"));
    }

    #[test]
    #[ignore = "benötigt crates.io"]
    fn resolves_regex_from_crates_io() {
        let specs = normalize_specs(vec![spec("regex", "1", &[])]).unwrap();
        let project = temp_project(&specs).unwrap();
        let outcome = resolve_project(&project);
        if outcome.is_ok() {
            let versions = parse_lock(&read_lock(&project).unwrap());
            assert!(versions.contains_key("regex"));
        }
        let _ = fs::remove_dir_all(&project);
        outcome.unwrap();
    }
}
