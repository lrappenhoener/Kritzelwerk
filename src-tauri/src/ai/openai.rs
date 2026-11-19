use serde_json::json;

use super::{
    error_snippet, request_error, status_error, AiAnswer, AiProfile, SYSTEM_PROMPT,
};

pub async fn ask(
    client: &reqwest::Client,
    profile: &AiProfile,
    model: &str,
    user_content: &str,
    key: Option<&str>,
) -> Result<AiAnswer, String> {
    let url = format!("{}/chat/completions", profile.base_url.trim_end_matches('/'));

    let mut request = client.post(&url).json(&json!({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        "stream": false
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

    let text = value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err(format!("{} lieferte keine Textantwort.", profile.name));
    }

    Ok(AiAnswer { text })
}
