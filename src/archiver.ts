/**
 * Standalone macOS Desktop screenshot and screen recording archiver.
 *
 * Uses only standard Node.js built-in modules (`node:fs/promises`, `node:path`,
 * `node:child_process`, `node:crypto`) so it runs natively in both Bun and
 * Node.js 24+ and compiles cleanly with `bun build --compile`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { join, parse } from "node:path";

export const DEFAULT_SOURCE_DIR = "~/Desktop";
export const DEFAULT_DEST_ROOT =
  "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/Daily";
export const DEFAULT_DATE_FORMAT = "YYYY/MM/DD";
export const DEFAULT_KEEP_TODAY = true;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_SCREENSHOT_PREFIX = "Screenshot";

export interface GlobalArgs {
  sourceDir: string;
  destRoot: string;
  dateFormat?: string;
  keepToday?: boolean;
  screenshotPrefix?: string;
}

export type CandidateStatus =
  | "ready-to-archive"
  | "skipped-today"
  | "would-archive"
  | "copied-verified"
  | "already-present-verified"
  | "archived"
  | "archived-deduplicated"
  | "error";

export interface CandidateFile {
  filename: string;
  kind: "screenshot" | "screen-recording";
  fileDate: string;
  sizeBytes: number;
  dataless: boolean;
  hasScreenCaptureXattr: boolean;
  status: CandidateStatus;
  sourcePath: string;
  destDir: string | null;
  destDirExists: boolean | null;
  destPath: string | null;
  sourceDeleted: boolean;
  error: string | null;
}

export interface BatchProgressEvent {
  runId: string;
  mode: "scan" | "dry-run" | "copy-verify" | "archive";
  fileDate: string;
  batchIndex: number;
  totalBatches: number;
  timestamp: string;
  sourceDir: string;
  destRoot: string;
  files: CandidateFile[];
  batchCopiedVerifiedCount: number;
  batchDeduplicatedCount: number;
  batchArchivedCount: number;
  batchErrorCount: number;
}

export interface SummaryResource {
  runId: string;
  mode: "scan" | "dry-run" | "copy-verify" | "archive";
  deleteSource: boolean;
  timestamp: string;
  today: string;
  sourceDir: string;
  destRoot: string;
  dateFormat: string;
  screenshotPrefix: string;
  destRootExists: boolean;
  batchSize: number;
  concurrency: number;
  dayCount: number;
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
  files: CandidateFile[];
}

export interface InspectAndProcessOptions {
  deleteSource?: boolean;
  sourceDirOverride?: string;
  destRootOverride?: string;
  screenshotPrefixOverride?: string;
  batchSize?: number;
  concurrency?: number;
  runId?: string;
  beforeVerify?: (destPath: string) => Promise<void> | void;
  onBatchComplete?: (event: BatchProgressEvent) => Promise<void> | void;
}

export interface MacOSScreenshotSettings {
  sourceDir: string;
  screenshotPrefix: string;
  customLocation: string | null;
  customPrefix: string | null;
}

export interface DayPlan<T = EligibleCandidate> {
  fileDate: string;
  destDir: string;
  destDirExistsBefore: boolean;
  files: T[];
  batches: T[][];
}

export interface ArchivePlan<T = EligibleCandidate> {
  totalFiles: number;
  dayCount: number;
  batchCount: number;
  batchSize: number;
  strategy: "empty" | "single-day" | "multi-day";
  days: DayPlan<T>[];
}

export const SCREENSHOT_XATTR = "com.apple.metadata:kMDItemIsScreenCapture";
export const SCREEN_RECORDING_XATTR =
  "com.apple.metadata:kMDItemIsScreenRecording";
const XATTR_BATCH_SIZE = 200;

const SCREEN_RECORDING_FULL_REGEX =
  /^Screen Recording\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.mov$/i;
const SCREEN_RECORDING_CANDIDATE_REGEX = /^Screen Recording\s+.+\.mov$/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildScreenshotRegexes(screenshotPrefix: string): {
  full: RegExp;
  candidate: RegExp;
} {
  const escaped = escapeRegExp(
    screenshotPrefix.trim() || DEFAULT_SCREENSHOT_PREFIX,
  );
  return {
    full: new RegExp(
      `^${escaped}\\s+(\\d{4}-\\d{2}-\\d{2})\\s+at\\s+.+\\.(png|jpe?g|pdf|tiff?|gif|heic)$`,
      "i",
    ),
    candidate: new RegExp(
      `^${escaped}\\s+.+\\.(png|jpe?g|pdf|tiff?|gif|heic)$`,
      "i",
    ),
  };
}

function normalizeApfsPathKey(p: string): string {
  return p.normalize("NFD").toLowerCase();
}

function buildSubprocessPath(): string {
  const homebrewPrefix =
    "/opt/homebrew/opt/rsync/bin:/opt/homebrew/bin:/usr/local/bin";
  const existingPath = process.env.PATH ?? "";
  const suffix = existingPath || "/usr/bin:/bin";
  return `${homebrewPrefix}:${suffix}`;
}

export const SUBPROCESS_ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
  PATH: buildSubprocessPath(),
};

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function execSubprocess(
  command: string,
  args: string[],
  env: Record<string, string> = SUBPROCESS_ENV,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const errWithCode = error as NodeJS.ErrnoException & {
            code?: string | number;
          };
          if (typeof errWithCode.code === "number") {
            resolve({
              code: errWithCode.code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
            });
            return;
          }
          reject(error);
          return;
        }
        resolve({
          code: 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

export function expandHomePath(
  inputPath: string,
  homeOverride?: string,
): string {
  const trimmed = inputPath.trim();
  if (trimmed !== "~" && !trimmed.startsWith("~/")) {
    return trimmed;
  }
  const home = homeOverride ?? process.env.HOME ?? "";
  if (!home) {
    return trimmed;
  }
  return trimmed === "~" ? home : join(home, trimmed.slice(2));
}

/**
 * Auto-detect macOS screenshot folder (`location`) and custom filename prefix
 * (`name`) from `com.apple.screencapture` user defaults (or a test plist path).
 * Falls back to `~/Desktop` and `"Screenshot"` when unset.
 */
export async function detectMacOSScreenshotSettings(
  domainOrPlistPath = "com.apple.screencapture",
  homeOverride?: string,
): Promise<MacOSScreenshotSettings> {
  let customLocation: string | null = null;
  let customPrefix: string | null = null;

  try {
    const locOut = await execSubprocess(
      "/usr/bin/defaults",
      ["read", domainOrPlistPath, "location"],
      SUBPROCESS_ENV,
    );
    if (locOut.code === 0 && locOut.stdout.trim()) {
      customLocation = locOut.stdout.trim();
    }
  } catch {
    // Ignore if /usr/bin/defaults is unavailable
  }

  try {
    const nameOut = await execSubprocess(
      "/usr/bin/defaults",
      ["read", domainOrPlistPath, "name"],
      SUBPROCESS_ENV,
    );
    if (nameOut.code === 0 && nameOut.stdout.trim()) {
      customPrefix = nameOut.stdout.trim();
    }
  } catch {
    // Ignore if /usr/bin/defaults is unavailable
  }

  return {
    sourceDir: expandHomePath(
      customLocation || DEFAULT_SOURCE_DIR,
      homeOverride,
    ),
    screenshotPrefix: customPrefix || DEFAULT_SCREENSHOT_PREFIX,
    customLocation,
    customPrefix,
  };
}

export function getLocalToday(now: Date = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function isValidDateString(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function formatDateSubpath(
  fileDate: string,
  dateFormat: string,
): string {
  const trimmed = dateFormat.trim().replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/");
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid dateFormat '${dateFormat}': must be a relative subfolder pattern without empty or '..' segments`,
    );
  }
  if (!/(YYYY|YY|MM|DD)/.test(trimmed)) {
    throw new Error(
      `Invalid dateFormat '${dateFormat}': must contain at least one date token (YYYY, YY, MM, or DD)`,
    );
  }
  const yyyy = fileDate.slice(0, 4);
  const yy = fileDate.slice(2, 4);
  const mm = fileDate.slice(5, 7);
  const dd = fileDate.slice(8, 10);

  return trimmed.replace(/YYYY|YY|MM|DD/g, (token) => {
    switch (token) {
      case "YYYY":
        return yyyy;
      case "YY":
        return yy;
      case "MM":
        return mm;
      case "DD":
        return dd;
      default:
        return token;
    }
  });
}

export function normalizeScreenshotDate(
  rawDate: string,
  referenceYear: number = new Date().getFullYear(),
): string {
  const match = /^(\d{4})-(\d{2}-\d{2})$/.exec(rawDate);
  if (!match) return rawDate;
  let year = Number(match[1]);
  if (year >= referenceYear + 500 && year <= referenceYear + 545) {
    year -= 543;
  }
  return `${String(year).padStart(4, "0")}-${match[2]}`;
}

export function parseScreenshotFilename(
  filename: string,
  referenceYear: number = new Date().getFullYear(),
  screenshotPrefix: string = DEFAULT_SCREENSHOT_PREFIX,
): {
  matchedPrefix: boolean;
  kind?: "screenshot" | "screen-recording";
  fileDate?: string;
} {
  const recMatch = SCREEN_RECORDING_FULL_REGEX.exec(filename);
  if (recMatch) {
    const normalizedDate = normalizeScreenshotDate(recMatch[1], referenceYear);
    if (!isValidDateString(normalizedDate)) {
      return { matchedPrefix: true };
    }
    return {
      matchedPrefix: true,
      kind: "screen-recording",
      fileDate: normalizedDate,
    };
  }

  const { full: shotFullRegex, candidate: shotCandidateRegex } =
    buildScreenshotRegexes(screenshotPrefix);
  const shotMatch = shotFullRegex.exec(filename);
  if (shotMatch) {
    const normalizedDate = normalizeScreenshotDate(shotMatch[1], referenceYear);
    if (!isValidDateString(normalizedDate)) {
      return { matchedPrefix: true };
    }
    return {
      matchedPrefix: true,
      kind: "screenshot",
      fileDate: normalizedDate,
    };
  }

  if (
    SCREEN_RECORDING_CANDIDATE_REGEX.test(filename) ||
    shotCandidateRegex.test(filename)
  ) {
    return { matchedPrefix: true };
  }

  return { matchedPrefix: false };
}

export async function getExtendedAttributesMap(
  filePaths: string[],
  batchSize: number = XATTR_BATCH_SIZE,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (filePaths.length === 0) return result;

  for (const filePath of filePaths) {
    if (!result.has(filePath)) {
      result.set(filePath, new Set<string>());
    }
  }

  const effectiveBatchSize = Math.max(1, Math.trunc(batchSize));
  for (let i = 0; i < filePaths.length; i += effectiveBatchSize) {
    const batch = filePaths.slice(i, i + effectiveBatchSize);
    const output = await execSubprocess(
      "xattr",
      ["--", ...batch],
      SUBPROCESS_ENV,
    );
    if (output.code !== 0) {
      if (batch.length > 1) {
        for (const singlePath of batch) {
          try {
            const singleMap = await getExtendedAttributesMap([singlePath], 1);
            const attrs = singleMap.get(singlePath);
            if (attrs) result.set(singlePath, attrs);
          } catch {
            // Ignore vanished file in multi-file batch
          }
        }
        continue;
      }
      const stderr = output.stderr.trim();
      throw new Error(
        `xattr exited with code ${output.code}: ${stderr || "unknown error"}`,
      );
    }

    if (batch.length === 1) {
      const singleSet = result.get(batch[0])!;
      for (const rawLine of output.stdout.split("\n")) {
        const attrName = rawLine.trim();
        if (attrName) singleSet.add(attrName);
      }
      continue;
    }

    // Sort candidate paths longest-first so a path prefix never shadows a longer path
    const sortedBatch = [...batch].sort((a, b) => b.length - a.length);
    for (const rawLine of output.stdout.split("\n")) {
      if (!rawLine.trim()) continue;
      for (const candidatePath of sortedBatch) {
        const prefix = `${candidatePath}: `;
        if (rawLine.startsWith(prefix)) {
          const attrName = rawLine.slice(prefix.length).trim();
          if (attrName) result.get(candidatePath)?.add(attrName);
          break;
        }
      }
    }
  }

  return result;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const info = await stat(p);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function birthtimesMatch(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return true;
  return Math.abs(a.getTime() - b.getTime()) <= 1000;
}

async function runRsyncCopy(
  sourcePath: string,
  destPath: string,
  useChecksum = false,
): Promise<{ ok: boolean; stderr: string }> {
  const args = useChecksum
    ? ["-aXN", "--checksum", "--", sourcePath, destPath]
    : ["-aXN", "--", sourcePath, destPath];
  const output = await execSubprocess("rsync", args, SUBPROCESS_ENV);
  return { ok: output.code === 0, stderr: output.stderr.trim() };
}

async function runRsyncChecksumVerify(
  sourcePath: string,
  destPath: string,
  includeMetadata = false,
): Promise<{ ok: boolean; details: string }> {
  const args = includeMetadata
    ? [
        "--dry-run",
        "-aN",
        "--checksum",
        "--itemize-changes",
        "--",
        sourcePath,
        destPath,
      ]
    : [
        "--dry-run",
        "--checksum",
        "--itemize-changes",
        "--",
        sourcePath,
        destPath,
      ];
  const output = await execSubprocess("rsync", args, SUBPROCESS_ENV);
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
  if (output.code !== 0) {
    return {
      ok: false,
      details: stderr || `rsync exited with code ${output.code}`,
    };
  }
  if (stdout.length > 0) {
    return {
      ok: false,
      details: `rsync checksum check reported differences: ${stdout}`,
    };
  }
  return { ok: true, details: "rsync checksum verified" };
}

/**
 * Shared verification helper checking `rsync --dry-run -aN --checksum`, byte
 * size, expected screen-capture `xattr`, and APFS creation timestamp (`birthtime`).
 */
async function verifyCopiedFile(
  sourcePath: string,
  sourceStat: Stats,
  destPath: string,
  expectedXattr: string,
): Promise<void> {
  const verifyResult = await runRsyncChecksumVerify(sourcePath, destPath, true);
  if (!verifyResult.ok) {
    throw new Error(verifyResult.details);
  }
  const [destStat, destXattrs] = await Promise.all([
    stat(destPath),
    getExtendedAttributesMap([destPath]),
  ]);
  if (destStat.size !== sourceStat.size) {
    throw new Error(
      `Size mismatch (src=${sourceStat.size}, dst=${destStat.size})`,
    );
  }
  if (!destXattrs.get(destPath)?.has(expectedXattr)) {
    throw new Error(
      `Destination file is missing expected extended attribute ${expectedXattr}: ${destPath}`,
    );
  }
  if (!birthtimesMatch(sourceStat.birthtime, destStat.birthtime)) {
    throw new Error(
      `Destination file creation timestamp mismatch: ${destPath}`,
    );
  }
}

export async function checkModernRsync(
  env: Record<string, string> = SUBPROCESS_ENV,
): Promise<{ pass: boolean; errors?: string[] }> {
  let output: SubprocessResult;
  try {
    output = await execSubprocess("rsync", ["--version"], env);
  } catch (err) {
    return {
      pass: false,
      errors: [
        `Failed to execute rsync (install via 'brew install rsync'): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }

  const stdout = output.stdout;
  const firstLine = stdout.split("\n")[0]?.trim() ?? "";
  const hasXattrs = /\bxattrs\b/.test(stdout);
  const hasCrtimes = /\bcrtimes\b/.test(stdout);

  if (
    output.code !== 0 ||
    firstLine.startsWith("openrsync") ||
    !hasXattrs ||
    !hasCrtimes
  ) {
    return {
      pass: false,
      errors: [
        `Expected modern rsync 3.x+ with xattrs (-X) and crtimes (-N) support (e.g. Homebrew 'brew install rsync'), but got: '${
          firstLine || "none"
        }'`,
      ],
    };
  }
  return { pass: true };
}

export function validateDateFormat(dateFormat: string): {
  pass: boolean;
  errors?: string[];
} {
  try {
    formatDateSubpath("2026-11-05", dateFormat);
    return { pass: true };
  } catch (err) {
    return {
      pass: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

export async function validateDirectories(
  sourceDirInput: string,
  destRootInput: string,
): Promise<{ pass: boolean; errors?: string[] }> {
  const errors: string[] = [];
  const sourceDir = expandHomePath(sourceDirInput);
  const destRoot = expandHomePath(destRootInput);
  if (!(await isDirectory(sourceDir))) {
    errors.push(`Source directory does not exist: ${sourceDir}`);
  }
  if (!(await isDirectory(destRoot))) {
    errors.push(`Destination root directory does not exist: ${destRoot}`);
  }
  return errors.length > 0 ? { pass: false, errors } : { pass: true };
}

/**
 * Resolve destination path with content-checksum deduplication and concurrency-safe
 * `(1)` slot reservation.
 */
async function resolveDestinationWithDeduplication(
  sourcePath: string,
  sourceStat: Stats,
  destDir: string,
  filename: string,
  expectedXattr: string,
  reservedDestPaths: Set<string>,
  syncMetadata = true,
): Promise<{ alreadyPresent: boolean; destPath: string }> {
  const { name: base, ext } = parse(filename);
  const sourceSizeBytes = sourceStat.size;
  const sourceDataless = sourceSizeBytes > 0 && sourceStat.blocks === 0;
  let candidate = join(destDir, filename);
  let n = 1;

  while (true) {
    const candidateKey = normalizeApfsPathKey(candidate);
    let destStat: Stats | null = null;
    try {
      destStat = await stat(candidate);
    } catch {
      destStat = null;
    }

    if (!destStat) {
      if (!reservedDestPaths.has(candidateKey)) {
        reservedDestPaths.add(candidateKey);
        return { alreadyPresent: false, destPath: candidate };
      }
      candidate = join(destDir, `${base} (${n})${ext}`);
      n += 1;
      continue;
    }

    if (destStat.isFile() && destStat.size === sourceSizeBytes) {
      const destDataless = destStat.size > 0 && destStat.blocks === 0;
      // Avoid materializing evicted iCloud files during read-only scan/dry-run
      if (!syncMetadata && (sourceDataless || destDataless)) {
        candidate = join(destDir, `${base} (${n})${ext}`);
        n += 1;
        continue;
      }

      const rsyncCheck = await runRsyncChecksumVerify(
        sourcePath,
        candidate,
        false,
      );
      if (rsyncCheck.ok) {
        if (syncMetadata) {
          const existingXattrs = await getExtendedAttributesMap([candidate]);
          const hasXattr = Boolean(
            existingXattrs.get(candidate)?.has(expectedXattr),
          );
          const hasMatchingBirthtime = birthtimesMatch(
            sourceStat.birthtime,
            destStat.birthtime,
          );

          if (!hasXattr || !hasMatchingBirthtime) {
            const syncResult = await runRsyncCopy(sourcePath, candidate, true);
            if (!syncResult.ok) {
              throw new Error(
                `rsync metadata sync failed on existing file: ${syncResult.stderr}`,
              );
            }
            await verifyCopiedFile(
              sourcePath,
              sourceStat,
              candidate,
              expectedXattr,
            );
          }
        }

        reservedDestPaths.add(candidateKey);
        return { alreadyPresent: true, destPath: candidate };
      }
    }

    candidate = join(destDir, `${base} (${n})${ext}`);
    n += 1;
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effectiveConcurrency = Math.max(
    1,
    Math.min(items.length, Math.trunc(concurrency) || 1),
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: effectiveConcurrency }, () => runWorker()),
  );
  return results;
}

export interface EligibleCandidate {
  filename: string;
  sourcePath: string;
  kind: "screenshot" | "screen-recording";
  fileDate: string;
  expectedXattr: string;
  statInfo: Stats;
  sizeBytes: number;
  dataless: boolean;
  hasScreenCaptureXattr: boolean;
  destDir: string;
  destDirExistsBefore: boolean;
}

function buildCandidateRecord(
  item: Pick<
    EligibleCandidate,
    | "filename"
    | "kind"
    | "fileDate"
    | "sizeBytes"
    | "dataless"
    | "hasScreenCaptureXattr"
    | "sourcePath"
  >,
  overrides: {
    status: CandidateStatus;
    destDir: string | null;
    destDirExists: boolean | null;
    destPath: string | null;
    sourceDeleted?: boolean;
    error?: string | null;
  },
): CandidateFile {
  return {
    filename: item.filename,
    kind: item.kind,
    fileDate: item.fileDate,
    sizeBytes: item.sizeBytes,
    dataless: item.dataless,
    hasScreenCaptureXattr: item.hasScreenCaptureXattr,
    status: overrides.status,
    sourcePath: item.sourcePath,
    destDir: overrides.destDir,
    destDirExists: overrides.destDirExists,
    destPath: overrides.destPath,
    sourceDeleted: overrides.sourceDeleted ?? false,
    error: overrides.error ?? null,
  };
}

/**
 * Group eligible candidates by `fileDate` (`YYYY-MM-DD`) in chronological order
 * and build a day-by-day execution plan.
 *
 * - Each day with `<= batchSize` (default 50) files forms a single batch.
 * - Only when a single day has `> batchSize` files is that day split into
 *   sub-batches of `batchSize`.
 */
export function createArchivePlan<
  T extends {
    fileDate: string;
    destDir: string;
    destDirExistsBefore: boolean;
  },
>(
  candidates: readonly T[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): ArchivePlan<T> {
  const effectiveBatchSize = Math.max(1, Math.trunc(batchSize));
  const byDate = new Map<string, T[]>();

  for (const candidate of candidates) {
    let group = byDate.get(candidate.fileDate);
    if (!group) {
      group = [];
      byDate.set(candidate.fileDate, group);
    }
    group.push(candidate);
  }

  const sortedDates = Array.from(byDate.keys()).sort((a, b) =>
    a.localeCompare(b),
  );

  const days: DayPlan<T>[] = [];
  let totalBatches = 0;

  for (const fileDate of sortedDates) {
    const dayFiles = byDate.get(fileDate)!;
    const batches: T[][] = [];
    for (let i = 0; i < dayFiles.length; i += effectiveBatchSize) {
      batches.push(dayFiles.slice(i, i + effectiveBatchSize));
    }
    totalBatches += batches.length;
    days.push({
      fileDate,
      destDir: dayFiles[0].destDir,
      destDirExistsBefore: dayFiles[0].destDirExistsBefore,
      files: dayFiles,
      batches,
    });
  }

  const strategy: ArchivePlan<T>["strategy"] =
    days.length === 0
      ? "empty"
      : days.length === 1
        ? "single-day"
        : "multi-day";

  return {
    totalFiles: candidates.length,
    dayCount: days.length,
    batchCount: totalBatches,
    batchSize: effectiveBatchSize,
    strategy,
    days,
  };
}

/**
 * Archive and verify a single file end-to-end (handles deduplication, `(1)`
 * collision naming, copy, checksum/xattr/birthtime verification, rollback on
 * failure, and source deletion).
 */
async function archiveSingleFile(
  item: EligibleCandidate,
  reservedDestPaths: Set<string>,
  deleteSource: boolean,
  beforeVerify?: (destPath: string) => Promise<void> | void,
): Promise<CandidateFile> {
  let attemptedDestPath: string | null = null;
  let createdNewDestFile = false;
  try {
    const resolved = await resolveDestinationWithDeduplication(
      item.sourcePath,
      item.statInfo,
      item.destDir,
      item.filename,
      item.expectedXattr,
      reservedDestPaths,
      true,
    );
    attemptedDestPath = resolved.destPath;

    if (resolved.alreadyPresent) {
      if (deleteSource) {
        await unlink(item.sourcePath);
      }
      return buildCandidateRecord(item, {
        status: deleteSource
          ? "archived-deduplicated"
          : "already-present-verified",
        destDir: item.destDir,
        destDirExists: true,
        destPath: resolved.destPath,
        sourceDeleted: deleteSource,
      });
    }

    const finalDestPath = resolved.destPath;
    createdNewDestFile = true;

    const copyResult = await runRsyncCopy(item.sourcePath, finalDestPath);
    if (!copyResult.ok) {
      throw new Error(`rsync copy failed: ${copyResult.stderr}`);
    }

    if (beforeVerify) {
      await beforeVerify(finalDestPath);
    }

    await verifyCopiedFile(
      item.sourcePath,
      item.statInfo,
      finalDestPath,
      item.expectedXattr,
    );

    createdNewDestFile = false;
    if (deleteSource) {
      await unlink(item.sourcePath);
    }

    return buildCandidateRecord(item, {
      status: deleteSource ? "archived" : "copied-verified",
      destDir: item.destDir,
      destDirExists: true,
      destPath: finalDestPath,
      sourceDeleted: deleteSource,
    });
  } catch (err) {
    if (createdNewDestFile && attemptedDestPath) {
      reservedDestPaths.delete(normalizeApfsPathKey(attemptedDestPath));
      try {
        await rm(attemptedDestPath, { force: true });
      } catch {
        // Ignore if destination file was never created before failure
      }
    }
    return buildCandidateRecord(item, {
      status: "error",
      destDir: item.destDir,
      destDirExists: item.destDirExistsBefore,
      destPath: attemptedDestPath ?? join(item.destDir, item.filename),
      sourceDeleted: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scan or archive screenshots according to `mode` using a 3-stage
 * Discover -> Plan by Day -> Execute pipeline.
 */
export async function inspectAndProcess(
  globalArgs: GlobalArgs,
  mode: "scan" | "dry-run" | "archive",
  todayOverride?: string,
  options?: InspectAndProcessOptions,
): Promise<SummaryResource> {
  const dateFormat = globalArgs.dateFormat ?? DEFAULT_DATE_FORMAT;
  const keepToday = globalArgs.keepToday ?? DEFAULT_KEEP_TODAY;
  const screenshotPrefix =
    options?.screenshotPrefixOverride ||
    globalArgs.screenshotPrefix ||
    DEFAULT_SCREENSHOT_PREFIX;
  const sourceDir = expandHomePath(
    options?.sourceDirOverride || globalArgs.sourceDir,
  );
  const destRoot = expandHomePath(
    options?.destRootOverride || globalArgs.destRoot,
  );
  const deleteSource = options?.deleteSource ?? true;
  const batchSize = Math.max(
    1,
    Math.trunc(options?.batchSize ?? DEFAULT_BATCH_SIZE),
  );
  const concurrency = Math.max(
    1,
    Math.trunc(options?.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const runId = options?.runId ?? randomUUID();

  formatDateSubpath("2026-11-05", dateFormat);

  if (todayOverride !== undefined && !isValidDateString(todayOverride)) {
    throw new Error(
      `Invalid today date '${todayOverride}': expected YYYY-MM-DD`,
    );
  }

  if (!(await isDirectory(sourceDir))) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }
  const destRootExists = await isDirectory(destRoot);
  if (!destRootExists && mode === "archive") {
    throw new Error(
      `Destination root directory is not available: ${destRoot}. Aborting safely without touching any files.`,
    );
  }

  const effectiveMode: "scan" | "dry-run" | "copy-verify" | "archive" =
    mode === "archive" && !deleteSource ? "copy-verify" : mode;

  const today = todayOverride ?? getLocalToday();
  const referenceYear = Number(today.slice(0, 4));
  let scannedCount = 0;
  let matchedCount = 0;
  let eligibleCount = 0;
  let copiedVerifiedCount = 0;
  let deduplicatedCount = 0;
  let archivedCount = 0;
  let skippedTodayCount = 0;
  let skippedUnparseableCount = 0;
  let skippedMissingXattrCount = 0;
  let datalessCount = 0;
  let errorCount = 0;
  const files: CandidateFile[] = [];

  // ============================================================================
  // Stage 1: Discover
  // ============================================================================
  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parsedCandidates: Array<{
    filename: string;
    sourcePath: string;
    kind: "screenshot" | "screen-recording";
    fileDate: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    scannedCount += 1;
    const filename = entry.name;
    const parsed = parseScreenshotFilename(
      filename,
      referenceYear,
      screenshotPrefix,
    );
    if (!parsed.matchedPrefix) continue;
    if (!parsed.fileDate || !parsed.kind) {
      skippedUnparseableCount += 1;
      continue;
    }
    parsedCandidates.push({
      filename,
      sourcePath: join(sourceDir, filename),
      kind: parsed.kind,
      fileDate: parsed.fileDate,
    });
  }

  const xattrMap = await getExtendedAttributesMap(
    parsedCandidates.map((c) => c.sourcePath),
  );

  const destDirExistenceCache = new Map<string, boolean>();
  async function checkDestDirExistsCached(destDir: string): Promise<boolean> {
    const cached = destDirExistenceCache.get(destDir);
    if (cached !== undefined) return cached;
    const exists = await isDirectory(destDir);
    destDirExistenceCache.set(destDir, exists);
    return exists;
  }

  const eligibleCandidates: EligibleCandidate[] = [];

  for (const { filename, sourcePath, kind, fileDate } of parsedCandidates) {
    const expectedXattr =
      kind === "screen-recording" ? SCREEN_RECORDING_XATTR : SCREENSHOT_XATTR;
    const fileXattrs = xattrMap.get(sourcePath);
    const hasScreenCaptureXattr = Boolean(fileXattrs?.has(expectedXattr));

    if (!hasScreenCaptureXattr) {
      skippedMissingXattrCount += 1;
      continue;
    }

    let statInfo: Stats;
    try {
      statInfo = await stat(sourcePath);
    } catch {
      // File vanished between readdir and stat; skip safely
      continue;
    }

    matchedCount += 1;
    const sizeBytes = statInfo.size;
    const dataless = sizeBytes > 0 && statInfo.blocks === 0;
    if (dataless) {
      datalessCount += 1;
    }

    if (keepToday && fileDate >= today) {
      skippedTodayCount += 1;
      files.push(
        buildCandidateRecord(
          {
            filename,
            kind,
            fileDate,
            sizeBytes,
            dataless,
            hasScreenCaptureXattr,
            sourcePath,
          },
          {
            status: "skipped-today",
            destDir: null,
            destDirExists: null,
            destPath: null,
          },
        ),
      );
      continue;
    }

    eligibleCount += 1;
    const dateSubpath = formatDateSubpath(fileDate, dateFormat);
    const destDir = join(destRoot, dateSubpath);
    const destDirExistsBefore = await checkDestDirExistsCached(destDir);

    eligibleCandidates.push({
      filename,
      sourcePath,
      kind,
      fileDate,
      expectedXattr,
      statInfo,
      sizeBytes,
      dataless,
      hasScreenCaptureXattr,
      destDir,
      destDirExistsBefore,
    });
  }

  // ============================================================================
  // Stage 2: Build Day-by-Day Plan
  // ============================================================================
  const plan = createArchivePlan(eligibleCandidates, batchSize);

  // ============================================================================
  // Stage 3: Execute Plan Day-by-Day
  // ============================================================================
  let globalBatchIndex = 0;

  for (const dayPlan of plan.days) {
    const reservedDestPaths = new Set<string>();

    if (mode === "scan" || mode === "dry-run") {
      for (const batch of dayPlan.batches) {
        globalBatchIndex += 1;
        const batchResults = await mapWithConcurrency(
          batch,
          concurrency,
          async (item) => {
            if (!item.destDirExistsBefore) {
              const candidate = join(item.destDir, item.filename);
              reservedDestPaths.add(normalizeApfsPathKey(candidate));
              return {
                item,
                resolved: { alreadyPresent: false, destPath: candidate },
              };
            }
            const resolved = await resolveDestinationWithDeduplication(
              item.sourcePath,
              item.statInfo,
              item.destDir,
              item.filename,
              item.expectedXattr,
              reservedDestPaths,
              false,
            );
            return { item, resolved };
          },
        );

        let batchDeduplicated = 0;
        const batchCandidateFiles = batchResults.map(({ item, resolved }) => {
          if (resolved.alreadyPresent) {
            deduplicatedCount += 1;
            batchDeduplicated += 1;
          }
          return buildCandidateRecord(item, {
            status: mode === "scan" ? "ready-to-archive" : "would-archive",
            destDir: item.destDir,
            destDirExists: item.destDirExistsBefore,
            destPath: resolved.destPath,
          });
        });

        files.push(...batchCandidateFiles);

        if (options?.onBatchComplete) {
          await options.onBatchComplete({
            runId,
            mode: effectiveMode,
            fileDate: dayPlan.fileDate,
            batchIndex: globalBatchIndex,
            totalBatches: plan.batchCount,
            timestamp: new Date().toISOString(),
            sourceDir,
            destRoot,
            files: batchCandidateFiles,
            batchCopiedVerifiedCount: 0,
            batchDeduplicatedCount: batchDeduplicated,
            batchArchivedCount: 0,
            batchErrorCount: 0,
          });
        }
      }
      continue;
    }

    // Mode === "archive":
    // 1. Ensure this day's destination directory exists once for the entire day
    let dayMkdirError: string | null = null;
    try {
      await mkdir(dayPlan.destDir, { recursive: true });
    } catch (err) {
      dayMkdirError = err instanceof Error ? err.message : String(err);
    }

    // 2. Execute each batch in this day
    for (const batch of dayPlan.batches) {
      globalBatchIndex += 1;

      const batchCandidateFiles = dayMkdirError
        ? batch.map((item) =>
            buildCandidateRecord(item, {
              status: "error",
              destDir: item.destDir,
              destDirExists: item.destDirExistsBefore,
              destPath: join(item.destDir, item.filename),
              error: `mkdir failed for ${item.destDir}: ${dayMkdirError}`,
            }),
          )
        : await mapWithConcurrency(batch, concurrency, (item) =>
            archiveSingleFile(
              item,
              reservedDestPaths,
              deleteSource,
              options?.beforeVerify,
            ),
          );

      let batchCopiedVerified = 0;
      let batchDeduplicated = 0;
      let batchArchived = 0;
      let batchErrors = 0;

      for (const record of batchCandidateFiles) {
        files.push(record);
        if (record.status === "error") {
          errorCount += 1;
          batchErrors += 1;
        } else if (
          record.status === "archived-deduplicated" ||
          record.status === "already-present-verified"
        ) {
          deduplicatedCount += 1;
          batchDeduplicated += 1;
          if (record.sourceDeleted) {
            archivedCount += 1;
            batchArchived += 1;
          }
        } else if (
          record.status === "archived" ||
          record.status === "copied-verified"
        ) {
          copiedVerifiedCount += 1;
          batchCopiedVerified += 1;
          if (record.sourceDeleted) {
            archivedCount += 1;
            batchArchived += 1;
          }
        }
      }

      if (options?.onBatchComplete) {
        await options.onBatchComplete({
          runId,
          mode: effectiveMode,
          fileDate: dayPlan.fileDate,
          batchIndex: globalBatchIndex,
          totalBatches: plan.batchCount,
          timestamp: new Date().toISOString(),
          sourceDir,
          destRoot,
          files: batchCandidateFiles,
          batchCopiedVerifiedCount: batchCopiedVerified,
          batchDeduplicatedCount: batchDeduplicated,
          batchArchivedCount: batchArchived,
          batchErrorCount: batchErrors,
        });
      }
    }
  }

  files.sort((a, b) => a.filename.localeCompare(b.filename));

  return {
    runId,
    mode: effectiveMode,
    deleteSource: mode === "archive" ? deleteSource : false,
    timestamp: new Date().toISOString(),
    today,
    sourceDir,
    destRoot,
    dateFormat,
    screenshotPrefix,
    destRootExists,
    batchSize,
    concurrency,
    dayCount: plan.dayCount,
    batchCount: plan.batchCount,
    scannedCount,
    matchedCount,
    eligibleCount,
    copiedVerifiedCount,
    deduplicatedCount,
    archivedCount,
    skippedTodayCount,
    skippedUnparseableCount,
    skippedMissingXattrCount,
    datalessCount,
    errorCount,
    files,
  };
}
