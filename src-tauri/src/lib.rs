mod ai;
mod debugger;
mod dependencies;
mod history;
mod languages;
mod lsp;
mod snippets;
mod transfer;

/// Kompiliert und startet ein Snippet und liefert das gemeinsame Ergebnisformat.
#[tauri::command]
async fn run_snippet(
    language: String,
    source: String,
    snippet: Option<String>,
    mode: String,
) -> Result<languages::SnippetResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        languages::run(&language, &source, snippet.as_deref(), &mode)
    })
    .await
    .map_err(|error| format!("Snippet-Lauf abgebrochen: {error}"))?
}

/// Liefert die öffentlichen KI-Vorlagen und ein optionales persönliches Gateway.
#[tauri::command]
fn ai_profiles() -> ai::AiProfiles {
    ai::profiles()
}

/// Stellt eine einzelne Frage mit vollständigem Codekontext an das ausgewählte Profil.
#[tauri::command]
async fn ask_ai(
    profile_id: String,
    model: Option<String>,
    question: String,
    language: String,
    code: String,
    focus: Option<ai::AiFocus>,
) -> Result<ai::AiAnswer, String> {
    ai::ask(&profile_id, model, &question, &language, code, focus).await
}

/// Liefert die gespeicherten Läufe eines benannten Snippets, neueste zuerst.
#[tauri::command]
fn history_list(name: String, language: String) -> Result<Vec<history::RunRecord>, String> {
    history::list(&name, &language)
}

/// Speichert einen abgeschlossenen Lauf im Verlauf des Snippets.
#[tauri::command]
fn history_save(
    name: String,
    language: String,
    run: history::RunRecord,
) -> Result<(), String> {
    history::save(&name, &language, run)
}

#[tauri::command]
fn list_snippets() -> Result<Vec<snippets::SnippetInfo>, String> {
    snippets::list()
}

#[tauri::command]
fn read_snippet(name: String, language: String) -> Result<snippets::SnippetDocument, String> {
    snippets::read(&name, &language)
}

#[tauri::command]
fn save_snippet(
    name: String,
    contents: String,
    overwrite: bool,
    mode: String,
    language: String,
) -> Result<snippets::SaveResult, String> {
    snippets::save(&name, &contents, overwrite, &mode, &language)
}

#[tauri::command]
fn lsp_start(app: tauri::AppHandle, snippet: Option<String>) -> Result<lsp::LspProject, String> {
    lsp::start(&app, snippet.as_deref())
}

#[tauri::command]
fn lsp_send(message: String) -> Result<(), String> {
    lsp::send(&message)
}

/// Liefert die gespeicherten Cargo-Abhängigkeiten eines Snippets.
#[tauri::command]
fn dependencies_get(name: String) -> Result<dependencies::DependencyConfig, String> {
    dependencies::config(&name)
}

/// Löst geänderte Abhängigkeiten in einem temporären Projekt auf und
/// übernimmt sie erst bei Erfolg.
#[tauri::command]
async fn dependencies_resolve(
    name: String,
    dependencies: Vec<dependencies::DependencySpec>,
    request_id: String,
) -> Result<dependencies::DependencyConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        dependencies::resolve(&name, dependencies, &request_id)
    })
    .await
    .map_err(|error| format!("Abhängigkeitsauflösung abgebrochen: {error}"))?
}

#[tauri::command]
fn dependencies_cancel(request_id: String) {
    dependencies::cancel(&request_id);
}

#[tauri::command]
fn export_snippet_file(
    path: String,
    name: String,
    contents: String,
    mode: String,
) -> Result<transfer::ExportResult, String> {
    transfer::export_snippet_file(&path, &name, &contents, &mode)
}

#[tauri::command]
fn inspect_import(path: String) -> Result<transfer::ImportPreview, String> {
    transfer::inspect_import(&path)
}

#[tauri::command]
fn import_snippet(path: String, name: String) -> Result<transfer::ImportResult, String> {
    transfer::import_snippet(&path, &name)
}

#[tauri::command]
fn export_project(
    path: String,
    name: String,
    contents: String,
    mode: String,
) -> Result<transfer::ProjectExportResult, String> {
    transfer::export_project(&path, &name, &contents, &mode)
}

#[tauri::command]
async fn debug_start(
    app: tauri::AppHandle,
    source: String,
    snippet: Option<String>,
    mode: String,
    breakpoints: Vec<u32>,
) -> Result<debugger::DebugStartResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        debugger::start(&app, &source, snippet.as_deref(), &mode, breakpoints)
    })
    .await
    .map_err(|error| format!("Debug-Start abgebrochen: {error}"))?
}

#[tauri::command]
async fn debug_snapshot(thread_id: i64) -> Result<debugger::DebugSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || debugger::snapshot(thread_id))
        .await
        .map_err(|error| format!("Debug-Abfrage abgebrochen: {error}"))?
}

#[tauri::command]
async fn debug_resume(command: String) -> Result<(), String> {
    if command != "continue" && command != "next" {
        return Err(format!("Unbekannter Debug-Befehl: {command}"));
    }
    tauri::async_runtime::spawn_blocking(move || debugger::resume(&command))
        .await
        .map_err(|error| format!("Debug-Befehl abgebrochen: {error}"))?
}

#[tauri::command]
async fn debug_set_breakpoints(
    lines: Vec<u32>,
) -> Result<Vec<debugger::BreakpointState>, String> {
    tauri::async_runtime::spawn_blocking(move || debugger::set_breakpoints(lines))
        .await
        .map_err(|error| format!("Haltepunkte nicht aktualisiert: {error}"))?
}

#[tauri::command]
async fn debug_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(debugger::stop)
        .await
        .map_err(|error| format!("Debug-Stopp abgebrochen: {error}"))?
}

/// Ergänzt fehlende GTK-/GSettings-Pfade beim Direktstart des Release-Binaries.
///
/// Wird das Binary außerhalb der Nix-Dev-Shell gestartet, findet GTK die
/// Schema-Pfade nicht und die Oberfläche rendert ohne Styles. Die Pfade der
/// Build-Umgebung sind eingebettet und werden hier nur ergänzt.
fn ensure_desktop_environment() {
    if let Some(baked) = option_env!("KRITZELWERK_XDG_DATA_DIRS") {
        let current = std::env::var("XDG_DATA_DIRS").unwrap_or_default();
        if !current.contains("gsettings-schemas") {
            let merged = if current.trim().is_empty() {
                baked.to_string()
            } else {
                format!("{baked}:{current}")
            };
            // Läuft vor dem Start von GTK/Tauri und damit vor weiteren Threads.
            unsafe { std::env::set_var("XDG_DATA_DIRS", merged) };
        }
    }

    if std::env::var_os("GDK_PIXBUF_MODULE_FILE").is_none() {
        if let Some(path) = option_env!("KRITZELWERK_GDK_PIXBUF_MODULE_FILE") {
            if std::path::Path::new(path).exists() {
                unsafe { std::env::set_var("GDK_PIXBUF_MODULE_FILE", path) };
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_desktop_environment();

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_snippet,
            ai_profiles,
            ask_ai,
            history_list,
            history_save,
            list_snippets,
            read_snippet,
            save_snippet,
            lsp_start,
            lsp_send,
            dependencies_get,
            dependencies_resolve,
            dependencies_cancel,
            export_snippet_file,
            inspect_import,
            import_snippet,
            export_project,
            debug_start,
            debug_snapshot,
            debug_resume,
            debug_set_breakpoints,
            debug_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            lsp::shutdown();
            debugger::shutdown();
        }
    });
}
