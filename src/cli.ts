#!/usr/bin/env bun
/**
 * CLI entrypoint for `screenshot-archiver`.
 *
 * Subcommands:
 *   - `scan`     Read-only inspection of sourceDir
 *   - `archive`  Verified two-step rsync -aXN + checksum + xattr archive
 *   - `dry-run`  Alias for `archive --dry-run`
 *   - `history`  Inspect recent runs and moved/failed files from logs/audit.jsonl
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  checkModernRsync,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_DATE_FORMAT,
  DEFAULT_DEST_ROOT,
  DEFAULT_KEEP_TODAY,
  DEFAULT_SCREENSHOT_PREFIX,
  DEFAULT_SOURCE_DIR,
  detectMacOSScreenshotSettings,
  expandHomePath,
  inspectAndProcess,
  type SummaryResource,
} from "./archiver.ts";
import {
  appendBatchAudit,
  appendFatalAuditError,
  appendRunAudit,
  formatAuditHistory,
  readAuditHistory,
  resolveDefaultLogDir,
} from "./audit.ts";

export interface ParsedCliArgs {
  command: "scan" | "archive" | "dry-run" | "history" | "help";
  sourceDir?: string;
  destRoot: string;
  dateFormat: string;
  keepToday: boolean;
  screenshotPrefix?: string;
  dryRun: boolean;
  deleteSource: boolean;
  batchSize: number;
  concurrency: number;
  logDir: string;
  todayOverride?: string;
  limit: number;
  errorsOnly: boolean;
  json: boolean;
  verbose: boolean;
  notifyOnError: boolean;
}

export function printUsage(): string {
  return `Usage: screenshot-archiver <command> [options]

Commands:
  scan                         Read-only scan of screenshots and screen recordings
  archive                      Copy, verify (rsync -aXN + --checksum + xattr), and remove source files
  dry-run                      Preview archive actions without creating folders or moving files
  history                      Display recent archive runs from logs/audit.jsonl

Options (scan / archive / dry-run):
  --source-dir <path>          Source directory (default: com.apple.screencapture location or ${DEFAULT_SOURCE_DIR})
  --dest-root <path>           Destination root directory (default: ${DEFAULT_DEST_ROOT})
  --date-format <fmt>          Date subfolder pattern (default: ${DEFAULT_DATE_FORMAT})
  --screenshot-prefix <prefix> Screenshot filename prefix (default: com.apple.screencapture name or "${DEFAULT_SCREENSHOT_PREFIX}")
  --keep-today                 Keep today's screenshots in sourceDir (default: true)
  --no-keep-today              Also archive today's screenshots
  --dry-run                    Preview archive without modifying disk
  --delete-source              Delete source files after verification (default: true)
  --no-delete-source           Copy and verify without deleting source files
  --batch-size <N>             Max files per batch within a day (default: ${DEFAULT_BATCH_SIZE})
  --concurrency <N>            Parallel rsync operations per batch (default: ${DEFAULT_CONCURRENCY})
  --log-dir <path>             Audit log directory (default: <repo>/logs)
  --today <YYYY-MM-DD>         Override today's date (YYYY-MM-DD)
  --no-notify                  Disable macOS Notification Center alerts on error
  --verbose, -v                Show per-file status lines in output
  --json                       Print machine-readable JSON output

Options (history):
  --limit <N>                  Maximum number of runs to show (default: 20)
  --errors                     Show only runs and files with errors
  --log-dir <path>             Audit log directory (default: <repo>/logs)
  --json                       Print machine-readable JSON output
  --help, -h                   Show this help message`;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    command: "scan",
    sourceDir: undefined,
    destRoot: DEFAULT_DEST_ROOT,
    dateFormat: DEFAULT_DATE_FORMAT,
    keepToday: DEFAULT_KEEP_TODAY,
    screenshotPrefix: undefined,
    dryRun: false,
    deleteSource: true,
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    logDir: resolveDefaultLogDir(),
    limit: 20,
    errorsOnly: false,
    json: false,
    verbose: false,
    notifyOnError: true,
  };

  const args = [...argv];
  if (args.length === 0) {
    result.command = "help";
    return result;
  }

  const first = args[0];
  if (first === "--help" || first === "-h" || first === "help") {
    result.command = "help";
    return result;
  }

  if (
    first === "scan" ||
    first === "archive" ||
    first === "dry-run" ||
    first === "history"
  ) {
    result.command = first;
    if (first === "dry-run") {
      result.dryRun = true;
    }
    args.shift();
  } else if (!first.startsWith("-")) {
    throw new Error(`Unknown command: '${first}'. Run with --help for usage.`);
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.command = "help";
        return result;
      case "--source-dir": {
        const val = args[++i];
        if (!val) throw new Error("Missing value for --source-dir");
        result.sourceDir = val;
        break;
      }
      case "--dest-root": {
        const val = args[++i];
        if (!val) throw new Error("Missing value for --dest-root");
        result.destRoot = val;
        break;
      }
      case "--date-format": {
        const val = args[++i];
        if (!val) throw new Error("Missing value for --date-format");
        result.dateFormat = val;
        break;
      }
      case "--screenshot-prefix": {
        const val = args[++i];
        if (!val) throw new Error("Missing value for --screenshot-prefix");
        result.screenshotPrefix = val;
        break;
      }
      case "--keep-today":
        result.keepToday = true;
        break;
      case "--no-keep-today":
        result.keepToday = false;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--run":
        result.command = "archive";
        result.dryRun = false;
        break;
      case "--delete-source":
        result.deleteSource = true;
        break;
      case "--no-delete-source":
        result.deleteSource = false;
        break;
      case "--batch-size": {
        const val = Number(args[++i]);
        if (!Number.isInteger(val) || val < 1) {
          throw new Error("--batch-size must be a positive integer");
        }
        result.batchSize = val;
        break;
      }
      case "--concurrency": {
        const val = Number(args[++i]);
        if (!Number.isInteger(val) || val < 1) {
          throw new Error("--concurrency must be a positive integer");
        }
        result.concurrency = val;
        break;
      }
      case "--log-dir": {
        const val = args[++i];
        if (!val) throw new Error("Missing value for --log-dir");
        result.logDir = val;
        break;
      }
      case "--today": {
        const val = args[++i];
        if (!val) throw new Error("Missing value for --today");
        result.todayOverride = val;
        break;
      }
      case "--limit": {
        const val = Number(args[++i]);
        if (!Number.isInteger(val) || val < 1) {
          throw new Error("--limit must be a positive integer");
        }
        result.limit = val;
        break;
      }
      case "--errors":
        result.errorsOnly = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--verbose":
      case "-v":
        result.verbose = true;
        break;
      case "--no-notify":
        result.notifyOnError = false;
        break;
      default:
        throw new Error(`Unknown option: '${arg}'. Run with --help for usage.`);
    }
  }

  return result;
}

function formatSummaryOutput(
  summary: SummaryResource,
  verbose: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    `Summary: mode=${summary.mode} scanned=${summary.scannedCount} matched=${summary.matchedCount} eligible=${summary.eligibleCount} days=${summary.dayCount} batches=${summary.batchCount} archived=${summary.archivedCount} copied=${summary.copiedVerifiedCount} deduplicated=${summary.deduplicatedCount} skipped_today=${summary.skippedTodayCount} errors=${summary.errorCount}`,
  );
  if (verbose || summary.errorCount > 0) {
    for (const file of summary.files) {
      if (!verbose && file.status !== "error") continue;
      if (file.status === "error") {
        lines.push(
          `  [ERROR] ${file.filename}: ${file.error ?? "unknown error"}`,
        );
      } else {
        lines.push(
          `  [${file.status}] ${file.filename}${file.destPath ? ` -> ${file.destPath}` : ""}`,
        );
      }
    }
  }
  return lines.join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (parsed.command === "help") {
    console.log(printUsage());
    return 0;
  }

  if (parsed.command === "history") {
    const runs = await readAuditHistory({
      logDir: parsed.logDir,
      limit: parsed.limit,
      errorsOnly: parsed.errorsOnly,
    });
    if (parsed.json) {
      console.log(JSON.stringify(runs, null, 2));
    } else {
      console.log(formatAuditHistory(runs, { errorsOnly: parsed.errorsOnly }));
    }
    return 0;
  }

  // Auto-detect sourceDir and screenshotPrefix from com.apple.screencapture
  // when not explicitly provided via CLI flags.
  let effectiveSourceDir = parsed.sourceDir ?? DEFAULT_SOURCE_DIR;
  let effectiveScreenshotPrefix =
    parsed.screenshotPrefix ?? DEFAULT_SCREENSHOT_PREFIX;

  if (!parsed.sourceDir || !parsed.screenshotPrefix) {
    const detected = await detectMacOSScreenshotSettings();
    if (!parsed.sourceDir) {
      effectiveSourceDir = detected.sourceDir;
    }
    if (!parsed.screenshotPrefix) {
      effectiveScreenshotPrefix = detected.screenshotPrefix;
    }
  }

  const mode =
    parsed.command === "scan"
      ? "scan"
      : parsed.dryRun
        ? "dry-run"
        : "archive";

  const runId = randomUUID();
  const auditOptions = {
    logDir: parsed.logDir,
    notifyOnError: parsed.notifyOnError,
  };

  if (mode === "archive") {
    const rsyncCheck = await checkModernRsync();
    if (!rsyncCheck.pass) {
      const errorMessage =
        rsyncCheck.errors?.join("; ") ?? "Modern rsync check failed";
      await appendFatalAuditError(
        {
          runId,
          mode,
          sourceDir: expandHomePath(effectiveSourceDir),
          destRoot: expandHomePath(parsed.destRoot),
          dateFormat: parsed.dateFormat,
          screenshotPrefix: effectiveScreenshotPrefix,
          errorMessage,
        },
        auditOptions,
      );
      console.error(errorMessage);
      return 1;
    }
  }

  let summary: SummaryResource;
  try {
    summary = await inspectAndProcess(
      {
        sourceDir: effectiveSourceDir,
        destRoot: parsed.destRoot,
        dateFormat: parsed.dateFormat,
        keepToday: parsed.keepToday,
        screenshotPrefix: effectiveScreenshotPrefix,
      },
      mode,
      parsed.todayOverride,
      {
        deleteSource: parsed.deleteSource,
        batchSize: parsed.batchSize,
        concurrency: parsed.concurrency,
        runId,
        onBatchComplete:
          mode === "archive"
            ? async (batchEvent) => {
                await appendBatchAudit(batchEvent, auditOptions);
              }
            : undefined,
      },
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (mode === "archive") {
      await appendFatalAuditError(
        {
          runId,
          mode: parsed.deleteSource ? "archive" : "copy-verify",
          sourceDir: expandHomePath(effectiveSourceDir),
          destRoot: expandHomePath(parsed.destRoot),
          dateFormat: parsed.dateFormat,
          screenshotPrefix: effectiveScreenshotPrefix,
          errorMessage,
        },
        auditOptions,
      );
    }
    console.error(errorMessage);
    return 1;
  }

  if (mode === "archive") {
    await appendRunAudit(summary, auditOptions);
  }

  if (parsed.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatSummaryOutput(summary, parsed.verbose));
  }

  return summary.errorCount > 0 ? 1 : 0;
}

const isMainModule =
  import.meta.main ||
  (process.argv[1] &&
    (basename(process.argv[1]) === "cli.ts" ||
      basename(process.argv[1]) === "screenshot-archiver"));

if (isMainModule) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
