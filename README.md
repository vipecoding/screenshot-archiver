# screenshot-archiver

Standalone, zero-dependency macOS CLI tool and nightly `launchd` service (`03:15 AM`) that safely archives Desktop screenshots (`Screenshot YYYY-MM-DD at ...`) and screen recordings (`Screen Recording YYYY-MM-DD at ...`) into Obsidian-style date folders (`YYYY/MM/DD`) in iCloud Drive or any local directory.

Every file is verified to be a genuine macOS screen capture via extended attributes (`com.apple.metadata:kMDItemIsScreenCapture` or `com.apple.metadata:kMDItemIsScreenRecording`), copied in day-grouped batches via Homebrew `rsync -aXN` (preserving macOS extended attributes and APFS creation timestamps), verified with `rsync --dry-run -aN --checksum --itemize-changes` and `xattr`, logged to a persistent audit trail (`logs/archive.log` and `logs/audit.jsonl`), and only then removed from the source directory.

## Key Features

- **Genuine Screen Capture Verification:** Batch-inspects macOS Spotlight extended attributes (`xattr`) so arbitrary files that happen to start with `Screenshot ` are never touched, and APFS/iCloud dataless files are not downloaded during attribute inspection.
- **Two-Step Verified Transfer (`rsync -aXN` + `--checksum` + `xattr`):**
  1. Copies each eligible file (`fileDate < today` when `keepToday: true`) into `<destRoot>/<dateFormat>/<filename>` using Homebrew `rsync -aXN` (staging atomically via a temporary dot-file and preserving extended attributes and creation timestamps).
  2. Verifies the destination copy with `rsync --dry-run -aN --checksum --itemize-changes`, confirms the destination file has the screen-capture extended attribute and matching creation timestamp, and only then deletes the source file.
- **Auto-Detection of macOS Screenshot Settings (`com.apple.screencapture`):** Automatically reads your configured screenshot directory (`location`) and custom filename prefix (`name`) from macOS `com.apple.screencapture` preferences, falling back to `~/Desktop` and `"Screenshot"`.
- **Day-by-Day Execution Planner (`createArchivePlan`):** Groups eligible files by date (`YYYY-MM-DD`) in chronological order. Each day (`<= 50` files) runs as a single batch with bounded concurrency (`--concurrency 4`), and only sub-batches within a day when a single day exceeds `--batch-size 50`.
- **Content-Checksum Deduplication & In-Place Metadata Sync:** If a file with the same name already exists in the destination date folder, compares byte size and `rsync --checksum`. Identical files are deduplicated in place (syncing any missing extended attributes and creation timestamps on the existing inode via `rsync -aXN --checksum`) without creating ` (1)` duplicates; files with different contents are safely written to `filename (1).ext`.
- **Nightly Audit Trail & History Viewer:**
  - `logs/archive.log`: Human-readable timestamped log of every archived, deduplicated, or failed file and run summary (auto-rotates at 50 MB, keeping 3 rotated files).
  - `logs/audit.jsonl`: Structured JSONL audit trail of every batch and run (auto-rotates at 50 MB, keeping 3 rotated files), queryable via `screenshot-archiver history`.
  - **macOS Notification on Error:** Triggers a Notification Center alert via `osascript` if any error occurs during an archive run.
- **Buddhist Calendar Year Normalization:** Automatically normalizes macOS Buddhist Era calendar years (`year > referenceYear + 500` → `year - 543`, e.g. `2569-03-04` → `2026-03-04`).

## Prerequisites

- **macOS** (`darwin-arm64` or `darwin-x64`) with `/usr/bin/xattr` and modern **Homebrew `rsync` 3.x+** (`brew install rsync`, installed at `/opt/homebrew/bin/rsync` or `/usr/local/bin/rsync`).
- [Bun](https://bun.sh) (for running tests and compiling the standalone `bin/screenshot-archiver` binary).

## Build & CLI Usage

Compile the standalone native executable:

```bash
bun run build
```

Run commands directly with `./bin/screenshot-archiver` (or via `bun run src/cli.ts`):

```bash
# 1. Read-only scan of ~/Desktop
./bin/screenshot-archiver scan --verbose

# 2. Preview archiving without creating directories or moving files
./bin/screenshot-archiver dry-run --verbose

# 3. Copy and verify to a temporary folder without deleting source files
./bin/screenshot-archiver archive --no-delete-source --dest-root /tmp/screenshot-test --verbose

# 4. Run the full verified archive
./bin/screenshot-archiver archive

# 5. View recent runs and moved files from logs/audit.jsonl
./bin/screenshot-archiver history
./bin/screenshot-archiver history --errors --limit 10
```

### CLI Options

| Option | Default | Description |
| --- | --- | --- |
| `--source-dir <path>` | `com.apple.screencapture` `location` or `~/Desktop` | Source directory containing macOS screenshots and screen recordings. |
| `--dest-root <path>` | `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/Daily` | Root destination directory where date subfolders live. |
| `--date-format <fmt>` | `YYYY/MM/DD` | Relative subfolder pattern using `YYYY`, `YY`, `MM`, `DD` tokens. |
| `--screenshot-prefix <str>` | `com.apple.screencapture` `name` or `"Screenshot"` | Screenshot filename prefix to match. |
| `--keep-today` / `--no-keep-today` | `--keep-today` | Keep screenshots dated today (or later) in `sourceDir`. |
| `--dry-run` | `false` | Preview archive actions without creating folders or moving files. |
| `--delete-source` / `--no-delete-source` | `--delete-source` | Delete source files after verification succeeds (`--no-delete-source` copies and verifies only). |
| `--batch-size <N>` | `50` | Number of eligible files processed per batch. |
| `--concurrency <N>` | `4` | Parallel `rsync` copy/verify operations within each batch. |
| `--log-dir <path>` | `<repo>/logs` | Directory for `archive.log` and `audit.jsonl`. |
| `--verbose`, `-v` | `false` | Print per-file status lines in human-readable output. |
| `--json` | `false` | Output machine-readable JSON. |

## Nightly `launchd` Service (`03:15 AM`) & Full Disk Access

On macOS, `launchd` background jobs require Full Disk Access (FDA) to read `~/Desktop` and write to iCloud Drive (`~/Library/Mobile Documents/...`). Rather than granting FDA to `/bin/bash`, the LaunchAgent runs a dedicated AppleScript application bundle (`/Applications/ScreenshotArchiverRunner.app`) that invokes `bin/screenshot-archiver archive`.

### Setup / Update

1. Compile the binary, build `/Applications/ScreenshotArchiverRunner.app`, and install the LaunchAgent (`~/Library/LaunchAgents/com.matthew.screenshot-archiver.plist`):

```bash
bun run install-agent
```

2. Grant Full Disk Access to `/Applications/ScreenshotArchiverRunner.app`:
   - Open **System Settings → Privacy & Security → Full Disk Access**.
   - Ensure `/Applications/ScreenshotArchiverRunner.app` is listed and toggled **ON** (if you rebuilt the `.app` bundle, toggle it off and back on or re-add it so macOS TCC updates its code signature).

3. Trigger an immediate test run and inspect diagnostics:

```bash
launchctl kickstart -k gui/$(id -u)/com.matthew.screenshot-archiver
bun run diagnose
```

## Development & Testing

Run the automated test suite via Bun:

```bash
bun test
```

## License

MIT — see [LICENSE](LICENSE) for details.
