# @matty/screenshot-archiver

A [Swamp](https://github.com/swamp-club/swamp) behavior extension (`@matty/screenshot-archiver`) and workflow that safely archives macOS screenshots (`Screenshot YYYY-MM-DD at ...`) and screen recordings (`Screen Recording YYYY-MM-DD at ...`) from a source folder (such as `~/Desktop`) into Obsidian-style date folders (`YYYY/MM/DD`) in iCloud Drive or any local vault directory.

Every file is verified to be a genuine macOS screen capture via extended attributes (`com.apple.metadata:kMDItemIsScreenCapture` or `com.apple.metadata:kMDItemIsScreenRecording`), copied via Homebrew `rsync -aXN` (preserving macOS extended attributes and APFS creation timestamps), verified with `rsync --dry-run --checksum --itemize-changes`, `xattr`, **and** a Web Crypto SHA-256 byte-for-byte digest comparison, and only then removed from the source directory.

## Key Features

- **Genuine Screen Capture Verification:** Batch-inspects macOS Spotlight extended attributes (`xattr`) so arbitrary files that happen to start with `Screenshot ` are never touched, and APFS/iCloud dataless files are not downloaded during attribute inspection.
- **Two-Step Verified Transfer (`rsync -aXN` + SHA-256 + `xattr`):**
  1. Copies each eligible file (`fileDate < today` when `keepToday: true`) into `<destRoot>/<dateFormat>/<filename>` using Homebrew `rsync -aXN` (preserving extended attributes and creation timestamps).
  2. Verifies the destination copy with `rsync --dry-run --checksum --itemize-changes`, confirms the destination file has the screen-capture extended attribute, and compares full-file SHA-256 digests (`sourceSha256 === destSha256`) before deleting the source file.
- **Content-Hash Deduplication & In-Place Metadata Sync:** If a file with the same name already exists in the destination date folder, compares byte size, `rsync --checksum`, and SHA-256. Identical files are deduplicated in place (syncing any missing extended attributes and creation timestamps via `rsync -aXN`) without creating ` (1)` duplicates; files with different contents are safely written to `filename (1).ext`.
- **Configurable Date Subfolders:** Supports Obsidian daily note subfolder patterns using `YYYY`, `YY`, `MM`, and `DD` tokens (default `YYYY/MM/DD`, e.g. `2026/11/04`).
- **Buddhist Calendar Year Normalization:** Automatically normalizes macOS Buddhist Era calendar years (`year > referenceYear + 500` → `year - 543`, e.g. `2569-03-04` → `2026-03-04`).

## Prerequisites

- **macOS** (`darwin-aarch64` or `darwin-x86_64`) with `/usr/bin/xattr` and modern **Homebrew `rsync` 3.x+** (`brew install rsync`, installed at `/opt/homebrew/bin/rsync` or `/usr/local/bin/rsync`, rather than macOS's outdated built-in `openrsync`).
- [Swamp CLI](https://swamp-club.com) installed.

## Installation

Pull the extension from the Swamp Club registry into any Swamp repository:

```bash
swamp extension pull @matty/screenshot-archiver
```

Then create a behavior instance configured with your source and destination directories:

```bash
swamp behavior create @matty/screenshot-archiver screenshot-archiver \
  --global-arg sourceDir="/Users/alice/Desktop" \
  --global-arg destRoot="/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Daily" \
  --global-arg dateFormat="YYYY/MM/DD" \
  --global-arg keepToday=true
```

## Configuration & Parameters

### Global Arguments (`globalArguments`)

Configured on the behavior instance in `models/@matty/screenshot-archiver/<name>.yaml`:

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceDir` | `string` | *(required)* | Source directory containing macOS screenshots and screen recordings (e.g. `/Users/alice/Desktop`). |
| `destRoot` | `string` | *(required)* | Root destination directory where date subfolders live (e.g. `/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Daily`). |
| `dateFormat` | `string` | `"YYYY/MM/DD"` | Relative subfolder pattern using `YYYY`, `YY`, `MM`, `DD` tokens (e.g. `YYYY/MM/DD`, `YYYY-MM-DD`, `YYYY/MM/YYYY-MM-DD`). |
| `keepToday` | `boolean` | `true` | When `true`, screenshots dated today (or later) remain in `sourceDir` and only files from earlier dates (`< today`) are archived. |

### Methods & Method Arguments

#### 1. `scan` (read-only)

Scans `sourceDir` for macOS screenshots and screen recordings, checks extended attributes and dataless status, and records a `summary` resource without modifying any files or folders.

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceDir` | `string` *(optional)* | `globalArgs.sourceDir` | Override the source directory for a one-off scan (e.g. `/Users/alice/Desktop/Screenshots`). |
| `destRoot` | `string` *(optional)* | `globalArgs.destRoot` | Override the destination root directory for a one-off scan. |

#### 2. `archive`

Copies eligible screenshots and screen recordings into `<destRoot>/<dateFormat>/`, verifies each file via `rsync --checksum` and SHA-256 (deduplicating identical files), and removes verified source files from `sourceDir`.

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `dryRun` | `boolean` | `false` | When `true`, previews which files would be archived (`status: "would-archive"`) without creating folders or moving files. |
| `deleteSource` | `boolean` | `true` | When `true`, deletes each source file after `rsync --checksum` and SHA-256 verification succeed. Set to `false` to copy and verify without deleting from `sourceDir`. |
| `sourceDir` | `string` *(optional)* | `globalArgs.sourceDir` | Override the source directory (files are scanned and deleted from this directory when `deleteSource: true`). |
| `destRoot` | `string` *(optional)* | `globalArgs.destRoot` | Override the destination root directory (useful for testing into a temporary directory). |

## Usage

```bash
# 1. Read-only scan of your configured sourceDir
swamp behavior run screenshot-archiver scan --json

# 2. Preview archiving without creating directories or moving files
swamp behavior run screenshot-archiver archive --input dryRun=true --json

# 3. Copy and verify to a temporary folder without deleting source files
swamp behavior run screenshot-archiver archive \
  --input deleteSource=false \
  --input destRoot="/tmp/screenshot-archive-test" \
  --json

# 4. Run the full verified archive (or execute the workflow)
swamp behavior run screenshot-archiver archive --json
swamp workflow run archive-screenshots --json

# 5. Query the latest summary output via CEL
swamp data query 'behavior("screenshot-archiver") && name == "main"' --select content --json
```

## Development & Testing

Run the unit and integration test suite with Swamp's bundled Deno runtime:

```bash
~/.swamp/deno/deno test --allow-read --allow-write --allow-run=rsync,xattr extensions/behaviors/screenshot_archiver_test.ts
```

## License

MIT — see [LICENSE](LICENSE) for details.
