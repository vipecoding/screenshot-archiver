#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LABEL="com.matthew.screenshot-archiver"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

ARCHIVE_LOG="$REPO_ROOT/logs/archive.log"
AUDIT_JSONL="$REPO_ROOT/logs/audit.jsonl"
BINARY_PATH="$REPO_ROOT/bin/screenshot-archiver"
RUNNER_APP="/Applications/ScreenshotArchiverRunner.app"

print_section() {
  printf "\n== %s ==\n" "$1"
}

print_section "Binary & Runner App"
if [[ -x "$BINARY_PATH" ]]; then
  printf "CLI binary: %s (executable)\n" "$BINARY_PATH"
else
  printf "WARNING: CLI binary not found or not executable at %s (run 'bun run build')\n" "$BINARY_PATH" >&2
fi

if [[ -d "$RUNNER_APP" ]]; then
  printf "Runner app: %s\n" "$RUNNER_APP"
else
  printf "WARNING: Runner app not found at %s (run 'bash bin/build_runner_app.sh')\n" "$RUNNER_APP" >&2
fi

print_section "Homebrew rsync Capabilities"
export PATH="/opt/homebrew/opt/rsync/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v rsync >/dev/null 2>&1; then
  printf "rsync path: %s\n" "$(command -v rsync)"
  rsync_ver="$(rsync --version)"
  printf "%s\n" "$rsync_ver" | head -n 4
else
  printf "WARNING: rsync not found on PATH\n" >&2
fi

print_section "LaunchAgent"
if ! launchctl print "$SERVICE"; then
  printf "Could not print service %s. Is it loaded?\n" "$SERVICE" >&2
fi

print_section "Recent archive.log"
if [[ -f "$ARCHIVE_LOG" ]]; then
  tail -n 40 "$ARCHIVE_LOG"
else
  printf "Missing archive log: %s\n" "$ARCHIVE_LOG"
fi

print_section "Recent Audit History"
if [[ -x "$BINARY_PATH" ]] && [[ -f "$AUDIT_JSONL" ]]; then
  "$BINARY_PATH" history --limit 5
else
  printf "No audit history recorded yet at: %s\n" "$AUDIT_JSONL"
fi

print_section "Latest summary check"
if [[ -f "$ARCHIVE_LOG" ]]; then
  latest_summary="$(grep "Summary:" "$ARCHIVE_LOG" | tail -n 1 || true)"
  if [[ -z "$latest_summary" ]]; then
    printf "No summary lines found in archive.log.\n"
  else
    printf "%s\n" "$latest_summary"
    if [[ "$latest_summary" =~ scanned=0 ]]; then
      printf "NOTE: Latest run reported scanned=0 (Desktop has no regular files or check Full Disk Access for ScreenshotArchiverRunner.app if files exist on Desktop).\n"
    fi
  fi
else
  printf "Cannot evaluate summary; archive.log not found.\n"
fi
