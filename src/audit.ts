/**
 * Audit logging, 50 MB log rotation, CLI history reader, and macOS error
 * notifications for `screenshot-archiver`.
 */
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BatchProgressEvent,
  type CandidateFile,
  DEFAULT_SCREENSHOT_PREFIX,
  execSubprocess,
  expandHomePath,
  SUBPROCESS_ENV,
  type SummaryResource,
} from "./archiver.ts";

export const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_ROTATED_FILES = 3;

export interface AuditFileRecord {
  filename: string;
  kind: "screenshot" | "screen-recording";
  fileDate: string;
  sizeBytes: number;
  status: CandidateFile["status"];
  sourcePath: string;
  destPath: string | null;
  sourceDeleted: boolean;
  error: string | null;
}

export interface AuditBatchRecord {
  recordType: "batch";
  runId: string;
  timestamp: string;
  mode: string;
  fileDate: string;
  batchIndex: number;
  totalBatches: number;
  sourceDir: string;
  destRoot: string;
  copiedVerifiedCount: number;
  deduplicatedCount: number;
  archivedCount: number;
  errorCount: number;
  files: AuditFileRecord[];
}

export interface AuditRunRecord {
  recordType: "run";
  runId: string;
  timestamp: string;
  today: string;
  mode: string;
  deleteSource: boolean;
  sourceDir: string;
  destRoot: string;
  dateFormat: string;
  screenshotPrefix?: string;
  destRootExists: boolean;
  batchSize: number;
  concurrency: number;
  dayCount?: number;
  batchCount: number;
  scannedCount: number;
  matchedCount: number;
  eligibleCount: number;
  copiedVerifiedCount: number;
  deduplicatedCount: number;
  archivedCount: number;
  skippedTodayCount: number;
  skippedUnparseableCount: number;
  skippedMissingXattrCount: number;
  datalessCount: number;
  errorCount: number;
  interrupted?: boolean;
  fatalError?: string | null;
  files: AuditFileRecord[];
}

export type AuditJsonlRecord = AuditBatchRecord | AuditRunRecord;

export interface AuditOptions {
  logDir?: string;
  maxLogBytes?: number;
  maxRotatedFiles?: number;
  notifyOnError?: boolean;
}

/**
 * Resolve the default `logs/` directory next to the repository root, or
 * `~/Library/Logs/screenshot-archiver` when installed under a system prefix.
 */
export function resolveDefaultLogDir(): string {
  const envDir = process.env.SCREENSHOT_ARCHIVER_LOG_DIR;
  if (envDir && envDir.trim()) {
    return expandHomePath(envDir.trim());
  }

  try {
    const metaUrl = import.meta.url;
    if (metaUrl.startsWith("file://") && !metaUrl.includes("/$bunfs/")) {
      const currentFile = fileURLToPath(metaUrl);
      const repoRoot = dirname(dirname(currentFile));
      return join(repoRoot, "logs");
    }
  } catch {
    // Fallback to process.execPath below
  }

  const repoRoot = dirname(dirname(process.execPath));
  if (
    repoRoot === "/" ||
    repoRoot.startsWith("/usr") ||
    repoRoot.startsWith("/opt") ||
    repoRoot.startsWith("/bin")
  ) {
    return expandHomePath("~/Library/Logs/screenshot-archiver");
  }
  return join(repoRoot, "logs");
}

function toAuditFileRecord(file: CandidateFile): AuditFileRecord {
  return {
    filename: file.filename,
    kind: file.kind,
    fileDate: file.fileDate,
    sizeBytes: file.sizeBytes,
    status: file.status,
    sourcePath: file.sourcePath,
    destPath: file.destPath,
    sourceDeleted: file.sourceDeleted,
    error: file.error,
  };
}

function formatStatusLabel(status: CandidateFile["status"]): string {
  switch (status) {
    case "archived":
      return "ARCHIVED";
    case "archived-deduplicated":
    case "already-present-verified":
      return "DEDUPLICATED";
    case "copied-verified":
      return "COPIED_VERIFIED";
    case "would-archive":
      return "WOULD_ARCHIVE";
    case "ready-to-archive":
      return "READY";
    case "skipped-today":
      return "SKIPPED_TODAY";
    case "error":
      return "ERROR";
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate `filePath` to `filePath.1` (shifting `.1` -> `.2` -> `.3` up to
 * `maxRotatedFiles`) when its size is `>= maxBytes`.
 */
export async function rotateLogIfNeeded(
  filePath: string,
  maxBytes: number = MAX_LOG_BYTES,
  maxRotatedFiles: number = MAX_ROTATED_FILES,
): Promise<boolean> {
  let currentSize = 0;
  try {
    const info = await stat(filePath);
    currentSize = info.size;
  } catch {
    return false;
  }

  if (currentSize < maxBytes) {
    return false;
  }

  const oldest = `${filePath}.${maxRotatedFiles}`;
  await rm(oldest, { force: true });

  for (let i = maxRotatedFiles - 1; i >= 1; i -= 1) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    try {
      await rename(src, dst);
    } catch {
      // Ignore if rotated slot does not exist yet
    }
  }

  try {
    await rename(filePath, `${filePath}.1`);
    return true;
  } catch {
    return false;
  }
}

async function prepareLogFiles(
  options?: AuditOptions,
): Promise<{ archiveLogPath: string; auditJsonlPath: string }> {
  const logDir = expandHomePath(options?.logDir ?? resolveDefaultLogDir());
  const maxBytes = options?.maxLogBytes ?? MAX_LOG_BYTES;
  const maxFiles = options?.maxRotatedFiles ?? MAX_ROTATED_FILES;
  await mkdir(logDir, { recursive: true });

  const archiveLogPath = join(logDir, "archive.log");
  const auditJsonlPath = join(logDir, "audit.jsonl");

  await rotateLogIfNeeded(archiveLogPath, maxBytes, maxFiles);
  await rotateLogIfNeeded(auditJsonlPath, maxBytes, maxFiles);
  return { archiveLogPath, auditJsonlPath };
}

/**
 * Append a batch progress event immediately to `archive.log` and `audit.jsonl`.
 */
export async function appendBatchAudit(
  event: BatchProgressEvent,
  options?: AuditOptions,
): Promise<void> {
  const { archiveLogPath, auditJsonlPath } = await prepareLogFiles(options);
  const shortRunId = event.runId.slice(0, 8);
  const humanLines: string[] = [];

  for (const file of event.files) {
    const label = formatStatusLabel(file.status);
    if (file.status === "error") {
      humanLines.push(
        `[${event.timestamp}] [run:${shortRunId}] [day:${event.fileDate} batch ${event.batchIndex}/${event.totalBatches}] ${label} ${file.sourcePath} -> ${file.destPath ?? "none"}: ${file.error ?? "unknown error"}`,
      );
    } else {
      humanLines.push(
        `[${event.timestamp}] [run:${shortRunId}] [day:${event.fileDate} batch ${event.batchIndex}/${event.totalBatches}] ${label} ${file.sourcePath} -> ${file.destPath ?? "none"} (${file.sizeBytes} bytes)`,
      );
    }
  }

  if (humanLines.length > 0) {
    await appendFile(archiveLogPath, `${humanLines.join("\n")}\n`, "utf8");
  }

  const batchRecord: AuditBatchRecord = {
    recordType: "batch",
    runId: event.runId,
    timestamp: event.timestamp,
    mode: event.mode,
    fileDate: event.fileDate,
    batchIndex: event.batchIndex,
    totalBatches: event.totalBatches,
    sourceDir: event.sourceDir,
    destRoot: event.destRoot,
    copiedVerifiedCount: event.batchCopiedVerifiedCount,
    deduplicatedCount: event.batchDeduplicatedCount,
    archivedCount: event.batchArchivedCount,
    errorCount: event.batchErrorCount,
    files: event.files.map(toAuditFileRecord),
  };

  await appendFile(
    auditJsonlPath,
    `${JSON.stringify(batchRecord)}\n`,
    "utf8",
  );
}

/**
 * Append a completed run summary to `archive.log` and `audit.jsonl`.
 */
export async function appendRunAudit(
  summary: SummaryResource,
  options?: AuditOptions,
): Promise<void> {
  const { archiveLogPath, auditJsonlPath } = await prepareLogFiles(options);
  const shortRunId = summary.runId.slice(0, 8);
  const summaryLine =
    `[${summary.timestamp}] [run:${shortRunId}] Summary: mode=${summary.mode} scanned=${summary.scannedCount} matched=${summary.matchedCount} eligible=${summary.eligibleCount} days=${summary.dayCount} batches=${summary.batchCount} archived=${summary.archivedCount} copied=${summary.copiedVerifiedCount} deduplicated=${summary.deduplicatedCount} skipped_today=${summary.skippedTodayCount} errors=${summary.errorCount}\n`;

  await appendFile(archiveLogPath, summaryLine, "utf8");

  const runRecord: AuditRunRecord = {
    recordType: "run",
    runId: summary.runId,
    timestamp: summary.timestamp,
    today: summary.today,
    mode: summary.mode,
    deleteSource: summary.deleteSource,
    sourceDir: summary.sourceDir,
    destRoot: summary.destRoot,
    dateFormat: summary.dateFormat,
    screenshotPrefix: summary.screenshotPrefix,
    destRootExists: summary.destRootExists,
    batchSize: summary.batchSize,
    concurrency: summary.concurrency,
    dayCount: summary.dayCount,
    batchCount: summary.batchCount,
    scannedCount: summary.scannedCount,
    matchedCount: summary.matchedCount,
    eligibleCount: summary.eligibleCount,
    copiedVerifiedCount: summary.copiedVerifiedCount,
    deduplicatedCount: summary.deduplicatedCount,
    archivedCount: summary.archivedCount,
    skippedTodayCount: summary.skippedTodayCount,
    skippedUnparseableCount: summary.skippedUnparseableCount,
    skippedMissingXattrCount: summary.skippedMissingXattrCount,
    datalessCount: summary.datalessCount,
    errorCount: summary.errorCount,
    fatalError: null,
    files: summary.files
      .filter((f) => f.status !== "skipped-today")
      .map(toAuditFileRecord),
  };

  await appendFile(auditJsonlPath, `${JSON.stringify(runRecord)}\n`, "utf8");

  if (summary.errorCount > 0 && (options?.notifyOnError ?? true)) {
    await sendErrorNotification(
      `Screenshot Archiver encountered ${summary.errorCount} error(s) in ${summary.sourceDir}. Run 'screenshot-archiver history --errors' for details.`,
    );
  }
}

/**
 * Append a fatal error record to `archive.log` and `audit.jsonl`.
 */
export async function appendFatalAuditError(
  params: {
    runId: string;
    mode: string;
    sourceDir: string;
    destRoot: string;
    dateFormat: string;
    screenshotPrefix?: string;
    errorMessage: string;
  },
  options?: AuditOptions,
): Promise<void> {
  const { archiveLogPath, auditJsonlPath } = await prepareLogFiles(options);
  const timestamp = new Date().toISOString();
  const shortRunId = params.runId.slice(0, 8);
  const logLine =
    `[${timestamp}] [run:${shortRunId}] FATAL: ${params.errorMessage}\n` +
    `[${timestamp}] [run:${shortRunId}] Summary: mode=${params.mode} scanned=0 matched=0 eligible=0 days=0 batches=0 archived=0 copied=0 deduplicated=0 skipped_today=0 errors=1\n`;

  await appendFile(archiveLogPath, logLine, "utf8");

  const runRecord: AuditRunRecord = {
    recordType: "run",
    runId: params.runId,
    timestamp,
    today: timestamp.slice(0, 10),
    mode: params.mode,
    deleteSource: false,
    sourceDir: params.sourceDir,
    destRoot: params.destRoot,
    dateFormat: params.dateFormat,
    screenshotPrefix: params.screenshotPrefix ?? DEFAULT_SCREENSHOT_PREFIX,
    destRootExists: false,
    batchSize: 0,
    concurrency: 0,
    dayCount: 0,
    batchCount: 0,
    scannedCount: 0,
    matchedCount: 0,
    eligibleCount: 0,
    copiedVerifiedCount: 0,
    deduplicatedCount: 0,
    archivedCount: 0,
    skippedTodayCount: 0,
    skippedUnparseableCount: 0,
    skippedMissingXattrCount: 0,
    datalessCount: 0,
    errorCount: 1,
    fatalError: params.errorMessage,
    files: [],
  };

  await appendFile(auditJsonlPath, `${JSON.stringify(runRecord)}\n`, "utf8");

  if (options?.notifyOnError ?? true) {
    await sendErrorNotification(params.errorMessage);
  }
}

/**
 * Trigger a best-effort macOS Notification Center alert via `osascript` passing
 * `message` safely as an `argv` parameter.
 */
export async function sendErrorNotification(message: string): Promise<void> {
  try {
    await execSubprocess(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'display notification (item 1 of argv) with title "Screenshot Archiver Error"',
        "-e",
        "end run",
        "--",
        message,
      ],
      SUBPROCESS_ENV,
    );
  } catch {
    // Best-effort only: ignore errors in headless or non-macOS test environments
  }
}

export interface HistoryQueryOptions {
  logDir?: string;
  limit?: number;
  errorsOnly?: boolean;
}

/**
 * Read audit history runs from `audit.jsonl` (and rotated `.1`..`.3` files if
 * needed), reconstructing any interrupted partial runs from their flushed
 * batch records. Returns runs ordered newest-first.
 */
export async function readAuditHistory(
  options?: HistoryQueryOptions,
): Promise<AuditRunRecord[]> {
  const logDir = expandHomePath(options?.logDir ?? resolveDefaultLogDir());
  const limit = Math.max(1, Math.trunc(options?.limit ?? 20));
  const errorsOnly = options?.errorsOnly ?? false;

  const candidateFiles = [
    join(logDir, "audit.jsonl.3"),
    join(logDir, "audit.jsonl.2"),
    join(logDir, "audit.jsonl.1"),
    join(logDir, "audit.jsonl"),
  ];

  const runMap = new Map<
    string,
    {
      run?: AuditRunRecord;
      batches: AuditBatchRecord[];
    }
  >();
  const runOrder: string[] = [];

  for (const filePath of candidateFiles) {
    if (!(await fileExists(filePath))) continue;
    const content = await readFile(filePath, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as AuditJsonlRecord;
        if (!parsed.runId) continue;
        let entry = runMap.get(parsed.runId);
        if (!entry) {
          entry = { batches: [] };
          runMap.set(parsed.runId, entry);
          runOrder.push(parsed.runId);
        }
        if (parsed.recordType === "run") {
          entry.run = parsed;
        } else if (parsed.recordType === "batch") {
          entry.batches.push(parsed);
        }
      } catch {
        // Ignore malformed JSONL lines
      }
    }
  }

  const runs: AuditRunRecord[] = [];
  for (const runId of runOrder) {
    const entry = runMap.get(runId)!;
    if (entry.run) {
      runs.push(entry.run);
      continue;
    }
    if (entry.batches.length > 0) {
      const first = entry.batches[0];
      const last = entry.batches[entry.batches.length - 1];
      const combinedFiles: AuditFileRecord[] = [];
      const uniqueDays = new Set<string>();
      let copiedVerifiedCount = 0;
      let deduplicatedCount = 0;
      let archivedCount = 0;
      let errorCount = 0;
      for (const b of entry.batches) {
        if (b.fileDate) uniqueDays.add(b.fileDate);
        copiedVerifiedCount += b.copiedVerifiedCount;
        deduplicatedCount += b.deduplicatedCount;
        archivedCount += b.archivedCount;
        errorCount += b.errorCount;
        combinedFiles.push(...b.files);
      }
      runs.push({
        recordType: "run",
        runId,
        timestamp: last.timestamp,
        today: last.timestamp.slice(0, 10),
        mode: first.mode,
        deleteSource: first.mode === "archive",
        sourceDir: first.sourceDir,
        destRoot: first.destRoot,
        dateFormat: "YYYY/MM/DD",
        destRootExists: true,
        batchSize: 0,
        concurrency: 0,
        dayCount: uniqueDays.size,
        batchCount: entry.batches.length,
        scannedCount: combinedFiles.length,
        matchedCount: combinedFiles.length,
        eligibleCount: combinedFiles.length,
        copiedVerifiedCount,
        deduplicatedCount,
        archivedCount,
        skippedTodayCount: 0,
        skippedUnparseableCount: 0,
        skippedMissingXattrCount: 0,
        datalessCount: 0,
        errorCount,
        interrupted: true,
        fatalError: null,
        files: combinedFiles,
      });
    }
  }

  const filtered = errorsOnly
    ? runs.filter((r) => r.errorCount > 0 || Boolean(r.fatalError))
    : runs;

  return filtered.reverse().slice(0, limit);
}

export function formatAuditHistory(
  runs: AuditRunRecord[],
  options?: { errorsOnly?: boolean },
): string {
  if (runs.length === 0) {
    return options?.errorsOnly
      ? "No archive runs with errors found in audit history."
      : "No archive runs found in audit history.";
  }

  const lines: string[] = [];
  for (const run of runs) {
    const shortId = run.runId.slice(0, 8);
    const interruptedTag = run.interrupted ? " [INTERRUPTED]" : "";
    lines.push(
      `=== [${run.timestamp}] run:${shortId} mode=${run.mode}${interruptedTag} ===`,
    );
    lines.push(
      `  scanned=${run.scannedCount} eligible=${run.eligibleCount} days=${run.dayCount ?? 0} batches=${run.batchCount} archived=${run.archivedCount} copied=${run.copiedVerifiedCount} deduplicated=${run.deduplicatedCount} skipped_today=${run.skippedTodayCount} errors=${run.errorCount}`,
    );
    if (run.fatalError) {
      lines.push(`  FATAL: ${run.fatalError}`);
    }
    const filesToShow = options?.errorsOnly
      ? run.files.filter((f) => f.status === "error" || f.error !== null)
      : run.files;
    for (const file of filesToShow) {
      const label = formatStatusLabel(file.status);
      if (file.status === "error") {
        lines.push(
          `  - [${label}] ${file.filename}: ${file.error ?? "unknown error"}`,
        );
      } else {
        lines.push(
          `  - [${label}] ${file.filename} -> ${file.destPath ?? "none"} (${file.sizeBytes} bytes)`,
        );
      }
    }
  }

  return lines.join("\n");
}
