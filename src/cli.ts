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
import { parseArgs } from "node:util";
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
  isValidDateString,
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

function parsePositiveInt(value: string | undefined, flagName: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return num;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  if (argv.length === 0) {
    return {
      command: "help",
      destRoot: DEFAULT_DEST_ROOT,
      dateFormat: DEFAULT_DATE_FORMAT,
      keepToday: DEFAULT_KEEP_TODAY,
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
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      "source-dir": { type: "string" },
      "dest-root": { type: "string" },
      "date-format": { type: "string" },
      "screenshot-prefix": { type: "string" },
      "keep-today": { type: "boolean", default: DEFAULT_KEEP_TODAY },
      "dry-run": { type: "boolean", default: false },
      "delete-source": { type: "boolean", default: true },
      "batch-size": { type: "string" },
      concurrency: { type: "string" },
      "log-dir": { type: "string" },
      today: { type: "string" },
      limit: { type: "string" },
      errors: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      notify: { type: "boolean", default: true },
    },
  });

  if (values.help || positionals[0] === "help") {
    return {
      command: "help",
      destRoot: DEFAULT_DEST_ROOT,
      dateFormat: DEFAULT_DATE_FORMAT,
      keepToday: DEFAULT_KEEP_TODAY,
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
  }

  const subcommand = positionals[0] ?? "scan";
  if (
    subcommand !== "scan" &&
    subcommand !== "archive" &&
    subcommand !== "dry-run" &&
    subcommand !== "history"
  ) {
    throw new Error(
      `Unknown command: '${subcommand}'. Run with --help for usage.`,
    );
  }
  if (positionals.length > 1) {
    throw new Error(
      `Unexpected positional argument: '${positionals[1]}'. Run with --help for usage.`,
    );
  }

  if (values.today !== undefined && !isValidDateString(values.today)) {
    throw new Error(
      `Invalid --today value '${values.today}': expected YYYY-MM-DD calendar date`,
    );
  }

  return {
    command: subcommand,
    sourceDir: values["source-dir"],
    destRoot: values["dest-root"] ?? DEFAULT_DEST_ROOT,
    dateFormat: values["date-format"] ?? DEFAULT_DATE_FORMAT,
    keepToday: values["keep-today"] ?? DEFAULT_KEEP_TODAY,
    screenshotPrefix: values["screenshot-prefix"],
    dryRun: subcommand === "dry-run" || Boolean(values["dry-run"]),
    deleteSource: values["delete-source"] ?? true,
    batchSize:
      values["batch-size"] !== undefined
        ? parsePositiveInt(values["batch-size"], "--batch-size")
        : DEFAULT_BATCH_SIZE,
    concurrency:
      values.concurrency !== undefined
        ? parsePositiveInt(values.concurrency, "--concurrency")
        : DEFAULT_CONCURRENCY,
    logDir: values["log-dir"] ?? resolveDefaultLogDir(),
    todayOverride: values.today,
    limit:
      values.limit !== undefined
        ? parsePositiveInt(values.limit, "--limit")
        : 20,
    errorsOnly: Boolean(values.errors),
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    notifyOnError: values.notify ?? true,
  };
}

function formatSummaryOutput(
  summary: SummaryResource,
  verbose: boolean,
): string {
  const lines: string[] = [
    `Summary: mode=${summary.mode} scanned=${summary.scannedCount} matched=${summary.matchedCount} eligible=${summary.eligibleCount} days=${summary.dayCount} batches=${summary.batchCount} archived=${summary.archivedCount} copied=${summary.copiedVerifiedCount} deduplicated=${summary.deduplicatedCount} skipped_today=${summary.skippedTodayCount} errors=${summary.errorCount}`,
  ];
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
      try {
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
      } catch {
        // Ignore audit write failure when reporting fatal error
      }
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
                try {
                  await appendBatchAudit(batchEvent, auditOptions);
                } catch {
                  // Do not abort active file archiving if log write fails mid-run
                }
              }
            : undefined,
      },
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (mode === "archive") {
      try {
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
      } catch {
        // Ignore audit write failure
      }
    }
    console.error(errorMessage);
    return 1;
  }

  if (mode === "archive") {
    try {
      await appendRunAudit(summary, auditOptions);
    } catch {
      // Do not fail completed archive run if final log write fails
    }
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
