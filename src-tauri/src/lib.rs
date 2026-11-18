mod languages;

/// Kompiliert und startet ein Snippet und liefert das gemeinsame Ergebnisformat.
#[tauri::command]
async fn run_snippet(
    language: String,
    source: String,
) -> Result<languages::SnippetResult, String> {
    tauri::async_runtime::spawn_blocking(move || languages::run(&language, &source))
        .await
        .map_err(|error| format!("Snippet-Lauf abgebrochen: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_snippet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
