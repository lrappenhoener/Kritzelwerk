mod cloud_data;
mod openai;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub(super) const SYSTEM_PROMPT: &str =
    "Du bist ein präziser Softwareentwickler. Antworte auf Deutsch und konzentriere dich auf die Frage.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiFocus {
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub personal: bool,
    pub protocol: String,
    pub key_env: Option<String>,
    pub key_required: bool,
}

#[derive(Debug, Serialize)]
pub struct AiProfiles {
    pub profiles: Vec<AiProfile>,
    pub config_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiAnswer {
    pub text: String,
}

#[derive(Debug, Deserialize)]
struct ConfigFile {
    profiles: Vec<ConfigProfile>,
}

#[derive(Debug, Deserialize)]
struct ConfigProfile {
    id: String,
    name: String,
    #[serde(default)]
    protocol: Option<String>,
    base_url: String,
    model: String,
    #[serde(default)]
    api_key_env: Option<String>,
}

fn public_profiles() -> Vec<AiProfile> {
    vec![
        AiProfile {
            id: "ollama".to_string(),
            name: "Ollama".to_string(),
            base_url: "http://127.0.0.1:11434/v1".to_string(),
            model: String::new(),
            personal: false,
            protocol: "openai".to_string(),
            key_env: None,
            key_required: false,
        },
        AiProfile {
            id: "strata".to_string(),
            name: "Strata".to_string(),
            base_url: "http://127.0.0.1:8080/v1".to_string(),
            model: String::new(),
            personal: false,
            protocol: "openai".to_string(),
            key_env: Some("STRATA_API_KEY".to_string()),
            key_required: false,
        },
        AiProfile {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            personal: false,
            protocol: "openai".to_string(),
            key_env: Some("OPENAI_API_KEY".to_string()),
            key_required: true,
        },
    ]
}

pub fn profiles() -> AiProfiles {
    let mut profiles = public_profiles();
    let mut config_error = None;

    match load_personal() {
        Ok(personal) => profiles.extend(personal),
        Err(error) => config_error = Some(error),
    }

    AiProfiles {
        profiles,
        config_error,
    }
}

fn config_path() -> Option<PathBuf> {
    if let Some(config_home) = env::var_os("XDG_CONFIG_HOME") {
        if !config_home.is_empty() {
            return Some(Path::new(&config_home).join("kritzelwerk/profiles.json"));
        }
    }
    env::var_os("HOME").map(|home| Path::new(&home).join(".config/kritzelwerk/profiles.json"))
}

fn load_personal() -> Result<Vec<AiProfile>, String> {
    let Some(path) = config_path() else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Konfiguration {} nicht lesbar: {error}", path.display()))?;
    let config: ConfigFile = serde_json::from_str(&content)
        .map_err(|error| format!("Konfiguration {} ungültig: {error}", path.display()))?;

    let mut profiles = Vec::new();
    for entry in config.profiles {
        let id = entry.id.trim();
        let name = entry.name.trim();
        let base_url = entry.base_url.trim();
        let model = entry.model.trim();
        let protocol = entry
            .protocol
            .as_deref()
            .unwrap_or("openai")
            .trim()
            .to_string();

        if id.is_empty() || name.is_empty() || base_url.is_empty() || model.is_empty() {
            return Err(format!(
                "Konfiguration {}: id, name, base_url und model sind Pflichtfelder.",
                path.display()
            ));
        }
        if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
            return Err(format!(
                "Konfiguration {}: base_url muss mit http:// oder https:// beginnen.",
                path.display()
            ));
        }
        if protocol != "openai" && protocol != "cloud-data" {
            return Err(format!(
                "Konfiguration {}: unbekanntes Protokoll {protocol:?}.",
                path.display()
            ));
        }

        profiles.push(AiProfile {
            id: format!("personal:{id}"),
            name: name.to_string(),
            base_url: base_url.to_string(),
            model: model.to_string(),
            personal: true,
            protocol,
            key_env: entry.api_key_env.map(|value| value.trim().to_string()),
            key_required: true,
        });
    }

    Ok(profiles)
}

fn code_fence(language: &str) -> &str {
    match language {
        "rust" => "rust",
        "java" => "java",
        "javascript" => "javascript",
        _ => "text",
    }
}

fn build_user_content(
    question: &str,
    language: &str,
    code: &str,
    focus: Option<&AiFocus>,
) -> String {
    let fence = code_fence(language);
    let code = code.trim_end();
    let mut parts = vec![
        format!("Frage:\n{question}"),
        format!("Vollständiger Code:\n```{fence}\n{code}\n```"),
    ];

    if let Some(focus) = focus {
        let text = focus.text.trim_end();
        if !text.is_empty() {
            parts.push(format!(
                "Markierte Zeilen (Zeile {} bis {}):\n```{fence}\n{text}\n```",
                focus.start_line, focus.end_line
            ));
        }
    }

    parts.join("\n\n")
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let result = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("HTTP-Client nicht verfügbar: {error}"))
    });
    result
        .as_ref()
        .map_err(|error| error.clone())
}

pub async fn ask(
    profile_id: &str,
    model: Option<String>,
    question: &str,
    language: &str,
    code: String,
    focus: Option<AiFocus>,
) -> Result<AiAnswer, String> {
    let profile = profiles()
        .profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| format!("Profil nicht gefunden: {profile_id}"))?;

    let question = question.trim();
    if question.is_empty() {
        return Err("Bitte eine Frage eingeben.".to_string());
    }

    let model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| profile.model.clone());
    if model.is_empty() {
        return Err(format!(
            "Keine Modell-ID für das Profil {} konfiguriert.",
            profile.name
        ));
    }

    let key = match profile.key_env.as_deref() {
        Some(name) => match env::var(name) {
            Ok(value) if !value.trim().is_empty() => Some(value),
            _ if profile.key_required => {
                return Err(format!(
                    "Zugangsdaten fehlen: Umgebungsvariable {name} ist nicht gesetzt."
                ));
            }
            _ => None,
        },
        None => None,
    };

    let user_content = build_user_content(question, language, &code, focus.as_ref());
    let client = client()?;

    match profile.protocol.as_str() {
        "cloud-data" => {
            let prompt = format!("{SYSTEM_PROMPT}\n\n{user_content}");
            cloud_data::ask(client, &profile, &model, &prompt, key.as_deref()).await
        }
        _ => openai::ask(client, &profile, &model, &user_content, key.as_deref()).await,
    }
}

pub(super) fn error_snippet(body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value["error"]["message"]
                .as_str()
                .or_else(|| value["detail"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());
    let message = message.trim();
    if message.is_empty() {
        "ohne Details".to_string()
    } else if message.chars().count() > 400 {
        format!("{}…", message.chars().take(400).collect::<String>())
    } else {
        message.to_string()
    }
}

pub(super) fn request_error(profile: &str, url: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("Zeitüberschreitung bei der Anfrage an {profile} ({url}).")
    } else if error.is_connect() || source_mentions_connect(error) {
        format!("Server nicht erreichbar: {url}")
    } else {
        format!("Anfrage an {url} fehlgeschlagen: {error}")
    }
}

fn source_mentions_connect(error: &reqwest::Error) -> bool {
    use std::error::Error;

    let needles = [
        "connection refused",
        "no route to host",
        "connect",
        "dns",
        "network is unreachable",
    ];
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(current) = source {
        let text = current.to_string().to_lowercase();
        if needles.iter().any(|needle| text.contains(needle)) {
            return true;
        }
        source = current.source();
    }
    false
}

fn mentions_context_limit(body: &str) -> bool {
    let body = body.to_lowercase();
    [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "token limit",
    ]
    .iter()
    .any(|needle| body.contains(needle))
}

pub(super) fn status_error(profile: &str, url: &str, status: u16, body: &str, key_sent: bool) -> String {    match status {
        401 | 403 => {
            if key_sent {
                format!("Zugangsdaten wurden von {profile} abgelehnt (HTTP {status}).")
            } else {
                format!("{profile} verlangt Zugangsdaten (HTTP {status}).")
            }
        }
        404 => format!(
            "Modell oder Endpunkt nicht gefunden (HTTP 404): {}",
            error_snippet(body)
        ),
        413 => format!(
            "Der Codekontext war für den Anbieter zu groß (HTTP 413): {}",
            error_snippet(body)
        ),
        400 if mentions_context_limit(body) => format!(
            "Der Codekontext passt nicht in das Kontextfenster des Modells (HTTP 400): {}",
            error_snippet(body)
        ),
        _ => format!(
            "{profile} antwortete mit HTTP {status} ({url}): {}",
            error_snippet(body)
        ),
    }
}
