# Kritzelwerk

Rust-Snippets schreiben und ausführen – Tauri-2-App mit CodeMirror-6-Editor (Vanilla TypeScript + Vite).

## Entwicklung

```bash
nix develop -c npm ci
nix develop -c npm run tauri dev
```

## Bedienung

- `Strg+Enter`: Aktuelles Snippet kompilieren und ausführen (Ausgabe unten)
- `F6`: Fokus zwischen Editor und Ausgabe wechseln

## Prüfungen

```bash
nix develop -c npm run build
nix develop -c cargo check --manifest-path src-tauri/Cargo.toml
```
