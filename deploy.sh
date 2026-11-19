#!/usr/bin/env bash
set -euo pipefail

# Baut Kritzelwerk als einzelnes Binary (ohne Bundles) und legt einen Starter ab.
#
#   ./deploy.sh                 # nach ./kritzelwerk + ./kritzelwerk.bin
#   ./deploy.sh ~/bin           # nach ~/bin/kritzelwerk + ~/bin/kritzelwerk.bin

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if ! command -v nix >/dev/null 2>&1; then
  echo "Fehler: nix ist nicht im PATH." >&2
  exit 1
fi

echo "→ Baue Kritzelwerk (Release, ohne Bundle) …"
nix develop -c npm run tauri build -- --no-bundle

binary="src-tauri/target/release/kritzelwerk"
if [[ ! -x "$binary" ]]; then
  echo "Fehler: Binary nicht gefunden: $binary" >&2
  exit 1
fi

target_dir="${1:-$project_dir}"
mkdir -p "$target_dir"
target_dir="$(cd -- "$target_dir" && pwd)"

# WebKit unter NixOS braucht die GTK-/GSettings-Pfade der Dev-Shell, sonst
# rendert die Oberfläche ohne Styles (fehlende GTK-Einstellungen/DPI).
xdg_data_dirs="$(nix develop -c printenv XDG_DATA_DIRS 2>/dev/null || true)"
gsettings_path="$(nix develop -c printenv GSETTINGS_SCHEMAS_PATH 2>/dev/null || true)"
pixbuf_file="$(nix develop -c printenv GDK_PIXBUF_MODULE_FILE 2>/dev/null || true)"

install -m 755 "$binary" "$target_dir/kritzelwerk.bin"

launcher="$target_dir/kritzelwerk"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo 'here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"'
  echo "export XDG_DATA_DIRS=\"$xdg_data_dirs\${XDG_DATA_DIRS:+:\$XDG_DATA_DIRS}\""
  if [[ -n "$gsettings_path" ]]; then
    echo "export GSETTINGS_SCHEMAS_PATH=\"$gsettings_path\""
  fi
  if [[ -n "$pixbuf_file" ]]; then
    echo "export GDK_PIXBUF_MODULE_FILE=\"$pixbuf_file\""
  fi
  echo 'export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"'
  echo 'export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"'
  echo 'exec "$here/kritzelwerk.bin" "$@"'
} > "$launcher"
chmod +x "$launcher"

echo
echo "✓ Binary:   $target_dir/kritzelwerk.bin"
echo "✓ Starter:  $target_dir/kritzelwerk"
echo "  Starten:  $target_dir/kritzelwerk"
echo "  Größe:    $(du -h "$target_dir/kritzelwerk.bin" | cut -f1)"
