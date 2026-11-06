#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY_PATH="$REPO_ROOT/bin/screenshot-archiver"

SYSTEM_APP_PATH="/Applications/ScreenshotArchiverRunner.app"
USER_APP_PATH="$HOME/Applications/ScreenshotArchiverRunner.app"

usage() {
  cat <<'EOF'
Usage: build_runner_app.sh [--user] [--output PATH]

Builds ScreenshotArchiverRunner.app from AppleScript source using osacompile.

Options:
  --user         Install under ~/Applications instead of /Applications
  --output PATH  Full output app path (must end with .app)
  --help         Show this help
EOF
}

APP_PATH="$SYSTEM_APP_PATH"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      APP_PATH="$USER_APP_PATH"
      ;;
    --output)
      shift
      if [[ $# -eq 0 ]]; then
        printf "Missing value for --output\n" >&2
        exit 2
      fi
      APP_PATH="$1"
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf "Unknown argument: %s\n" "$1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

if [[ "$APP_PATH" != *.app ]]; then
  printf "Output path must end with .app: %s\n" "$APP_PATH" >&2
  exit 2
fi

APP_PARENT="$(dirname "$APP_PATH")"
if ! mkdir -p "$APP_PARENT"; then
  printf "Cannot create app parent directory: %s\n" "$APP_PARENT" >&2
  if [[ "$APP_PATH" == "$SYSTEM_APP_PATH" ]]; then
    printf "Tip: rerun with --user to build under ~/Applications\n" >&2
  fi
  exit 1
fi

if [[ -e "$APP_PATH" ]] && ! rm -rf "$APP_PATH"; then
  printf "Cannot remove existing app: %s\n" "$APP_PATH" >&2
  exit 1
fi

TMP_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/ScreenshotArchiverRunner.XXXXXX.applescript")"
trap 'rm -f "$TMP_SCRIPT"' EXIT

cat > "$TMP_SCRIPT" <<EOF
on run
  try
    do shell script "$BINARY_PATH archive"
  on error errMsg number errNum
    -- Errors are logged to logs/archive.log + logs/audit.jsonl and notified via Notification Center.
  end try
end run
EOF

osacompile -o "$APP_PATH" "$TMP_SCRIPT"

EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/applet"
printf "Built runner app: %s\n" "$APP_PATH"
printf "Runner executable: %s\n" "$EXECUTABLE_PATH"
