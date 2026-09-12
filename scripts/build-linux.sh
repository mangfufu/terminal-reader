#!/usr/bin/env bash
set -euo pipefail

# Run inside Linux/WSL. Build on its native filesystem so node_modules and Rust
# target files are never shared with a Windows build of the same checkout.
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="${TERMINAL_READER_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/terminal-reader-linux}"
release_dir="$source_dir/artifacts/release/linux"
mkdir -p -- "$work_dir" "$release_dir"
work_dir="$(cd -- "$work_dir" && pwd)"
if [[ "$work_dir" == "$source_dir" || "$work_dir" == "$source_dir/"* ]]; then
  printf 'Choose a Linux build directory outside the source checkout.\n' >&2
  exit 1
fi
for required in node npm cargo rsync pkg-config; do
  command -v "$required" >/dev/null || { printf 'Missing Linux build tool: %s\n' "$required" >&2; exit 1; }
done
pkg-config --exists gtk+-3.0 webkit2gtk-4.1
rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='artifacts' --exclude='src-tauri/target' "$source_dir/" "$work_dir/"
cd -- "$work_dir"
export CARGO_TARGET_DIR="$work_dir/src-tauri/target"
npm ci
npm test
npm run desktop:linux
cp -- "$CARGO_TARGET_DIR/release/terminal-reader" "$release_dir/terminal-reader"
while IFS= read -r -d '' package; do cp -- "$package" "$release_dir/"; done < <(find "$CARGO_TARGET_DIR/release/bundle" -type f \( -name '*.deb' -o -name '*.AppImage' \) -print0)
printf 'Linux artifacts saved to %s\n' "$release_dir"
