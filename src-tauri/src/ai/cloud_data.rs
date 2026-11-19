use serde_json::json;

use super::{error_snippet, request_error, status_error, AiAnswer, AiProfile};

/// Schmaler Adapter für cloud-data: POST /api/v1/acquisitions mit `wait`.
///
/// Die Modellroute wird als `provider[:host]` interpretiert, z. B. `ollama`,
/// `ollama:zen` oder `openai:strata`.
pub async fn ask(
    client: &reqwest::Client,
    profile: &AiProfile,
    route: &str,
    prompt: &str,
    key: Option<&str>,
) -> Result<AiAnswer, String> {
    let (provider, host) = match route.split_once(':') {
        Some((provider, host)) => (provider.trim(), Some(host.trim())),
        None => (route.trim(), None),
    };

    if provider.is_empty() {
        return Err("Ungültige Modellroute für das Gateway.".to_string());
    }

    let mut source = json!({ "provider": provider });
    if let Some(host) = host.filter(|host| !host.is_empty()) {
        source["host"] = json!(host);
    }

    let url = format!(
        "{}/api/v1/acquisitions",
        profile.base_url.trim_end_matches('/')
    );

    let mut request = client.post(&url).json(&json!({
        "source": source,
        "inputs": { "prompt": prompt },
        "wait": true
    }));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| request_error(&profile.name, &url, &error))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Antwort von {} nicht lesbar: {error}", profile.name))?;

    if !status.is_success() {
        return Err(status_error(
            &profile.name,
            &url,
            status.as_u16(),
            &body,
            key.is_some(),
        ));
    }

    let value: serde_json::Value = serde_json::from_str(&body).map_err(|_| {
        format!(
            "Unerwartete Antwort von {}: {}",
            profile.name,
            error_snippet(&body)
        )
    })?;

    if value["status"].as_str() == Some("queued") {
        return Err(
            "Das Gateway hat die Anfrage nur eingereiht; bitte erneut versuchen.".to_string(),
        );
    }

    let answer = value["answer"]
        .as_str()
        .or_else(|| value["records"][0]["answer"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if answer.is_empty() {
        return Err(format!("{} lieferte keine Textantwort.", profile.name));
    }

    Ok(AiAnswer { text: answer })
}
