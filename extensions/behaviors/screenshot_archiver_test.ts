import {
  behavior,
  type CandidateFile,
  checkModernRsync,
  expandHomePath,
  formatDateSubpath,
  getExtendedAttributesMap,
  getLocalToday,
  inspectAndProcess,
  isValidDateString,
  normalizeScreenshotDate,
  parseScreenshotFilename,
  SUBPROCESS_ENV,
  type SummaryResource,
} from "./screenshot_archiver.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message ? message + ": " : ""}Expected ${
        JSON.stringify(expected)
      }, got ${JSON.stringify(actual)}`,
    );
  }
}

async function setXattr(
  filePath: string,
  attrName: string,
  value = "1",
): Promise<void> {
  const cmd = new Deno.Command("xattr", {
    args: ["-w", attrName, value, "--", filePath],
    env: SUBPROCESS_ENV,
  });
  const out = await cmd.output();
  assert(out.code === 0, `Failed to set xattr ${attrName} on ${filePath}`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

Deno.test("formatDateSubpath and expandHomePath validate patterns and expand tilde", () => {
  assertEquals(formatDateSubpath("2026-11-03", "YYYY/MM/DD"), "2026/11/03");
  assertEquals(formatDateSubpath("2026-11-03", "YYYY-MM-DD"), "2026-11-03");
  assertEquals(
    formatDateSubpath("2026-11-03", "YYYY/MM/YYYY-MM-DD"),
    "2026/11/2026-11-03",
  );
  assertEquals(formatDateSubpath("2026-11-03", "YY/MM/DD"), "26/11/03");

  for (
    const invalidFormat of [
      "../YYYY/MM/DD",
      "YYYY//MM/DD",
      "YYYY\\MM\\DD",
      "yyyy/mm/dd",
      "screenshots",
      "",
      "/",
    ]
  ) {
    let threw = false;
    try {
      formatDateSubpath("2026-11-03", invalidFormat);
    } catch {
      threw = true;
    }
    assert(threw, `Expected invalid dateFormat '${invalidFormat}' to throw`);
  }

  assertEquals(
    expandHomePath("~/Desktop", "/Users/alice"),
    "/Users/alice/Desktop",
  );
  assertEquals(expandHomePath("~", "/Users/alice"), "/Users/alice");
  assertEquals(
    expandHomePath("/Users/alice/Desktop", "/Users/alice"),
    "/Users/alice/Desktop",
  );
});

Deno.test("parseScreenshotFilename matches screenshots, recordings, and bounds Buddhist years", () => {
  const s1 = parseScreenshotFilename(
    "Screenshot 2026-11-03 at 10.15.20 AM.png",
  );
  assertEquals(s1.matchedPrefix, true);
  assertEquals(s1.kind, "screenshot");
  assertEquals(s1.fileDate, "2026-11-03");

  const s2 = parseScreenshotFilename("Screen Shot 2026-02-28 at 14.05.00.png");
  assertEquals(s2.matchedPrefix, false);

  const sr = parseScreenshotFilename(
    "Screen Recording 2026-11-01 at 09.30.00.mov",
  );
  assertEquals(sr.matchedPrefix, true);
  assertEquals(sr.kind, "screen-recording");
  assertEquals(sr.fileDate, "2026-11-01");

  const buddhist = parseScreenshotFilename(
    "Screenshot 2569-03-04 at 10.01.31 PM.png",
    2026,
  );
  assertEquals(buddhist.matchedPrefix, true);
  assertEquals(buddhist.kind, "screenshot");
  assertEquals(buddhist.fileDate, "2026-03-04");

  // Out-of-bounds year (> referenceYear + 545) must not be subtracted by 543
  assertEquals(normalizeScreenshotDate("9999-01-01", 2026), "9999-01-01");

  const prefixed = parseScreenshotFilename(
    "before Screenshot 2026-02-04 at 2.29.43 pm.png",
    2026,
  );
  assertEquals(prefixed.matchedPrefix, false);

  for (
    const ext of ["png", "jpg", "jpeg", "pdf", "tiff", "tif", "gif", "heic"]
  ) {
    const valid = parseScreenshotFilename(
      `Screenshot 2026-11-03 at 10.15.20 AM.${ext}`,
      2026,
    );
    assertEquals(valid.matchedPrefix, true, `Expected .${ext} to match`);
    assertEquals(valid.kind, "screenshot");
    assertEquals(valid.fileDate, "2026-11-03");
  }

  const wrongScreenshotExt = parseScreenshotFilename(
    "Screenshot 2026-11-03 at 10.15.20 AM.zip",
    2026,
  );
  assertEquals(wrongScreenshotExt.matchedPrefix, false);

  const nonScreenshotNotes = parseScreenshotFilename(
    "Screenshot notes.txt",
    2026,
  );
  assertEquals(nonScreenshotNotes.matchedPrefix, false);

  const wrongRecordingExt = parseScreenshotFilename(
    "Screen Recording 2026-11-03 at 10.15.20 AM.mp4",
    2026,
  );
  assertEquals(wrongRecordingExt.matchedPrefix, false);

  const badDate = parseScreenshotFilename(
    "Screenshot 2026-02-30 at 10.00.00.png",
  );
  assertEquals(badDate.matchedPrefix, true);
  assertEquals(badDate.fileDate, undefined);

  const nonMatch = parseScreenshotFilename("vacation-photo.jpg");
  assertEquals(nonMatch.matchedPrefix, false);
  assertEquals(isValidDateString("2026-11-04"), true);
  assertEquals(isValidDateString("2026-02-29"), false);
});

Deno.test("getExtendedAttributesMap handles single-file colons, batching, and missing files", async () => {
  const tempRoot = await Deno.makeTempDir({ prefix: "screenshot-xattr-test-" });
  try {
    const f1 = `${tempRoot}/one.png`;
    const f2 = `${tempRoot}/two.png`;
    const f3 = `${tempRoot}/three.png`;
    await Deno.writeTextFile(f1, "1");
    await Deno.writeTextFile(f2, "2");
    await Deno.writeTextFile(f3, "3");

    const colonAttr = "com.example.custom: label: with spaces";
    await setXattr(f1, colonAttr, "val");
    await setXattr(f1, "com.apple.metadata:kMDItemIsScreenCapture", "1");
    await setXattr(f2, "com.apple.metadata:kMDItemIsScreenCapture", "1");
    await setXattr(f3, "com.apple.metadata:kMDItemIsScreenRecording", "1");

    // Single file with ": " inside the attribute name
    const singleMap = await getExtendedAttributesMap([f1]);
    assertEquals(singleMap.get(f1)?.has(colonAttr), true);
    assertEquals(
      singleMap.get(f1)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      true,
    );

    // Chunked multi-file batching (batchSize = 2 across 3 files)
    const batchedMap = await getExtendedAttributesMap([f1, f2, f3], 2);
    assertEquals(
      batchedMap.get(f1)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      true,
    );
    assertEquals(
      batchedMap.get(f2)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      true,
    );
    assertEquals(
      batchedMap.get(f3)?.has("com.apple.metadata:kMDItemIsScreenRecording"),
      true,
    );

    // Non-existent file surfaces non-zero exit code error
    let threw = false;
    try {
      await getExtendedAttributesMap([`${tempRoot}/missing.png`]);
    } catch {
      threw = true;
    }
    assert(threw, "Expected getExtendedAttributesMap to throw on missing file");
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("behavior.checks validate dateFormat, directories, and modern rsync capabilities", async () => {
  const tempRoot = await Deno.makeTempDir({
    prefix: "screenshot-checks-test-",
  });
  try {
    const validFmt = await behavior.checks["valid-date-format"].execute({
      globalArgs: {
        sourceDir: tempRoot,
        destRoot: tempRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
    });
    assertEquals(validFmt.pass, true);

    const invalidFmt = await behavior.checks["valid-date-format"].execute({
      globalArgs: {
        sourceDir: tempRoot,
        destRoot: tempRoot,
        dateFormat: "yyyy/mm/dd",
        keepToday: true,
      },
    });
    assertEquals(invalidFmt.pass, false);

    const dirsExist = await behavior.checks["directories-exist"].execute({
      globalArgs: {
        sourceDir: tempRoot,
        destRoot: tempRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
    });
    assertEquals(dirsExist.pass, true);

    const dirsMissing = await behavior.checks["directories-exist"].execute({
      globalArgs: {
        sourceDir: `${tempRoot}/missing-src`,
        destRoot: `${tempRoot}/missing-dst`,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
    });
    assertEquals(dirsMissing.pass, false);
    assertEquals(dirsMissing.errors?.length, 2);

    const dirsOverridePass = await behavior.checks["directories-exist"].execute(
      {
        globalArgs: {
          sourceDir: `${tempRoot}/missing-src`,
          destRoot: `${tempRoot}/missing-dst`,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        methodArgs: {
          sourceDir: tempRoot,
          destRoot: tempRoot,
        },
      },
    );
    assertEquals(dirsOverridePass.pass, true);

    const modernRsyncPass = await behavior.checks["modern-rsync"].execute();
    assertEquals(modernRsyncPass.pass, true);

    const openRsyncFail = await checkModernRsync({ PATH: "/usr/bin:/bin" });
    assertEquals(openRsyncFail.pass, false);

    const missingRsyncFail = await checkModernRsync({ PATH: "/nonexistent" });
    assertEquals(missingRsyncFail.pass, false);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("scan and archive end-to-end with rsync checksum, xattr, and birthtime verification", async () => {
  const tempRoot = await Deno.makeTempDir({
    prefix: "screenshot-archiver-test-",
  });
  try {
    const sourceDir = `${tempRoot}/Desktop`;
    const destRoot = `${tempRoot}/Daily`;
    await Deno.mkdir(sourceDir, { recursive: true });

    const today = getLocalToday();
    const yesterdayShot = "Screenshot 2020-11-03 at 10.00.00 AM.png";
    const yesterdayRec = "Screen Recording 2020-11-02 at 18.30.00.mov";
    const fakeShotWithoutXattr = "Screenshot 2020-11-01 at 12.00.00 PM.png";
    const unparseableShot = "Screenshot bad-date.png";
    const todayShot = `Screenshot ${today} at 08.00.00 AM.png`;
    const otherFile = "notes.md";

    await Deno.writeTextFile(
      `${sourceDir}/${yesterdayShot}`,
      "png-bytes-12345",
    );
    await Deno.writeTextFile(`${sourceDir}/${yesterdayRec}`, "mov-bytes-67890");
    await Deno.writeTextFile(
      `${sourceDir}/${fakeShotWithoutXattr}`,
      "not-a-real-screenshot",
    );
    await Deno.writeTextFile(`${sourceDir}/${unparseableShot}`, "unparseable");
    await Deno.writeTextFile(`${sourceDir}/${todayShot}`, "today-png-bytes");
    await Deno.writeTextFile(`${sourceDir}/${otherFile}`, "keep-me");

    await setXattr(
      `${sourceDir}/${yesterdayShot}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );
    await setXattr(
      `${sourceDir}/${todayShot}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );
    await setXattr(
      `${sourceDir}/${yesterdayRec}`,
      "com.apple.metadata:kMDItemIsScreenRecording",
    );

    const sourceShotStat = await Deno.stat(`${sourceDir}/${yesterdayShot}`);

    // 1. Read-only scan via behavior.methods.scan.execute when destRoot does NOT exist yet
    const scanWritten: SummaryResource[] = [];
    await behavior.methods.scan.execute(
      {},
      {
        globalArgs: {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        writeResource: (_specName, instanceName, data) => {
          scanWritten.push(data as unknown as SummaryResource);
          return Promise.resolve({ name: instanceName });
        },
      },
    );

    assertEquals(scanWritten.length, 1);
    const scanResult = scanWritten[0];
    assertEquals(scanResult.mode, "scan");
    assertEquals(scanResult.destRootExists, false);
    assertEquals(scanResult.scannedCount, 6);
    assertEquals(scanResult.matchedCount, 3);
    assertEquals(scanResult.skippedUnparseableCount, 1);
    assertEquals(scanResult.skippedMissingXattrCount, 1);
    assertEquals(scanResult.eligibleCount, 2);
    assertEquals(scanResult.skippedTodayCount, 1);
    assertEquals(scanResult.archivedCount, 0);

    // 2. Dry-run via behavior.methods.archive.execute (dryRun: true)
    await Deno.mkdir(destRoot, { recursive: true });
    const dryRunWritten: SummaryResource[] = [];
    await behavior.methods.archive.execute(
      { dryRun: true, deleteSource: true },
      {
        globalArgs: {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        writeResource: (_specName, instanceName, data) => {
          dryRunWritten.push(data as unknown as SummaryResource);
          return Promise.resolve({ name: instanceName });
        },
      },
    );
    assertEquals(dryRunWritten.length, 1);
    assertEquals(dryRunWritten[0].mode, "dry-run");
    assertEquals(dryRunWritten[0].destRootExists, true);
    assertEquals(
      dryRunWritten[0].files.filter((f: CandidateFile) =>
        f.status === "would-archive"
      ).length,
      2,
    );
    assertEquals(
      await fileExists(`${destRoot}/2020/11/03/${yesterdayShot}`),
      false,
      "Dry-run must not copy files",
    );

    // 3. Archive via behavior.methods.archive.execute
    const written: Array<
      { specName: string; instanceName: string; data: unknown }
    > = [];
    await behavior.methods.archive.execute(
      { dryRun: false, deleteSource: true },
      {
        globalArgs: {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        writeResource: (specName, instanceName, data) => {
          written.push({ specName, instanceName, data });
          return Promise.resolve({ name: instanceName });
        },
      },
    );

    assertEquals(written.length, 1);
    const archivedDest = `${destRoot}/2020/11/03/${yesterdayShot}`;
    const archivedRecDest = `${destRoot}/2020/11/02/${yesterdayRec}`;
    assertEquals(
      await Deno.readTextFile(archivedDest),
      "png-bytes-12345",
      "Destination content must match source",
    );

    const destXattrs = await getExtendedAttributesMap([archivedDest]);
    assertEquals(
      destXattrs.get(archivedDest)?.has(
        "com.apple.metadata:kMDItemIsScreenCapture",
      ),
      true,
      "Archived screenshot must preserve kMDItemIsScreenCapture xattr via Homebrew rsync -aXN",
    );

    const destShotStat = await Deno.stat(archivedDest);
    assert(
      sourceShotStat.birthtime !== null && destShotStat.birthtime !== null,
      "Expected non-null birthtime on APFS",
    );
    assert(
      Math.abs(
        sourceShotStat.birthtime.getTime() - destShotStat.birthtime.getTime(),
      ) <= 1000,
      "Archived screenshot must preserve creation timestamp (birthtime) via Homebrew rsync -N",
    );

    const recContent = await Deno.readTextFile(archivedRecDest);
    assertEquals(recContent, "mov-bytes-67890");

    assertEquals(
      await fileExists(`${sourceDir}/${yesterdayShot}`),
      false,
      "Archived screenshot should be removed from Desktop",
    );

    const todayContent = await Deno.readTextFile(`${sourceDir}/${todayShot}`);
    assertEquals(
      todayContent,
      "today-png-bytes",
      "Today's screenshot must stay on Desktop",
    );

    const fakeContent = await Deno.readTextFile(
      `${sourceDir}/${fakeShotWithoutXattr}`,
    );
    assertEquals(
      fakeContent,
      "not-a-real-screenshot",
      "File without kMDItemIsScreenCapture xattr must stay on Desktop",
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("collision suffix is added only when existing file has different content, and identical content is deduplicated", async () => {
  const tempRoot = await Deno.makeTempDir({ prefix: "screenshot-dedup-test-" });
  try {
    const sourceDir = `${tempRoot}/Desktop`;
    const destRoot = `${tempRoot}/Daily`;
    const existingDir = `${destRoot}/2020/11/03`;
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(existingDir, { recursive: true });

    const diffFilename = "Screenshot 2020-11-03 at 10.00.00 AM.png";
    const sameFilename = "Screenshot 2020-11-03 at 11.00.00 AM.png";

    // Pre-populate destination with both files
    await Deno.writeTextFile(
      `${existingDir}/${diffFilename}`,
      "original-file-v1",
    );
    await Deno.writeTextFile(
      `${existingDir}/${sameFilename}`,
      "identical-bytes-xyz",
    );
    const sameInodeBefore = (await Deno.stat(`${existingDir}/${sameFilename}`))
      .ino;

    // Source has a different version of diffFilename, and an identical copy of sameFilename
    await Deno.writeTextFile(
      `${sourceDir}/${diffFilename}`,
      "second-file-different-bytes",
    );
    await Deno.writeTextFile(
      `${sourceDir}/${sameFilename}`,
      "identical-bytes-xyz",
    );
    await setXattr(
      `${sourceDir}/${diffFilename}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );
    await setXattr(
      `${sourceDir}/${sameFilename}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );

    // Pre-check: scan previews collision suffix (1) and deduplication without modifying disk
    const scanPreview = await inspectAndProcess(
      {
        sourceDir,
        destRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
      "scan",
      "2020-11-04",
    );
    assertEquals(scanPreview.deduplicatedCount, 1);
    const previewDiff = scanPreview.files.find(
      (f: CandidateFile) => f.filename === diffFilename,
    );
    const previewSame = scanPreview.files.find(
      (f: CandidateFile) => f.filename === sameFilename,
    );
    assertEquals(
      previewDiff?.destPath,
      `${existingDir}/Screenshot 2020-11-03 at 10.00.00 AM (1).png`,
    );
    assertEquals(previewSame?.destPath, `${existingDir}/${sameFilename}`);

    const result = await inspectAndProcess(
      {
        sourceDir,
        destRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
      "archive",
      "2020-11-04",
    );

    assertEquals(result.copiedVerifiedCount, 1);
    assertEquals(result.deduplicatedCount, 1);
    assertEquals(result.archivedCount, 2);

    // diffFilename got a (1) suffix because content differed
    const collidedPath =
      `${existingDir}/Screenshot 2020-11-03 at 10.00.00 AM (1).png`;
    assertEquals(
      await Deno.readTextFile(`${existingDir}/${diffFilename}`),
      "original-file-v1",
    );
    assertEquals(
      await Deno.readTextFile(collidedPath),
      "second-file-different-bytes",
    );

    // sameFilename did NOT create a (1) duplicate because content matched,
    // AND its missing extended attributes were synced in place on the existing inode via rsync -aXN --checksum!
    assertEquals(
      await fileExists(
        `${existingDir}/Screenshot 2020-11-03 at 11.00.00 AM (1).png`,
      ),
      false,
      "Identical file should be deduplicated, not duplicated as (1)",
    );
    const sameInodeAfter = (await Deno.stat(`${existingDir}/${sameFilename}`))
      .ino;
    assertEquals(
      sameInodeAfter,
      sameInodeBefore,
      "Deduplicated metadata sync via rsync -aXN --checksum must update existing inode in place",
    );
    const dedupXattrs = await getExtendedAttributesMap([
      `${existingDir}/${sameFilename}`,
    ]);
    assertEquals(
      dedupXattrs.get(`${existingDir}/${sameFilename}`)?.has(
        "com.apple.metadata:kMDItemIsScreenCapture",
      ),
      true,
      "Deduplicated existing file must have its missing xattrs restored in place via rsync -aXN",
    );
    // Both source files were deleted from sourceDir
    assertEquals(await fileExists(`${sourceDir}/${diffFilename}`), false);
    assertEquals(await fileExists(`${sourceDir}/${sameFilename}`), false);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("verification failure cleans up corrupted destination file, keeps source, and reports error details", async () => {
  const tempRoot = await Deno.makeTempDir({
    prefix: "screenshot-verify-fail-test-",
  });
  try {
    const sourceDir = `${tempRoot}/Desktop`;
    const destRoot = `${tempRoot}/Daily`;
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(destRoot, { recursive: true });

    const filename = "Screenshot 2020-11-03 at 10.00.00 AM.png";
    await Deno.writeTextFile(
      `${sourceDir}/${filename}`,
      "good-screenshot-bytes",
    );
    await setXattr(
      `${sourceDir}/${filename}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );

    // 1. Simulate post-copy corruption via beforeVerify hook
    const failedRun = await inspectAndProcess(
      {
        sourceDir,
        destRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
      "archive",
      "2020-11-04",
      {
        beforeVerify: async (destPath) => {
          await Deno.writeTextFile(destPath, "corrupted-destination-bytes");
        },
      },
    );

    assertEquals(failedRun.errorCount, 1);
    assertEquals(failedRun.archivedCount, 0);
    assertEquals(failedRun.files[0].status, "error");
    assertEquals(
      failedRun.files[0].destPath,
      `${destRoot}/2020/11/03/${filename}`,
    );
    assertEquals(
      await fileExists(`${sourceDir}/${filename}`),
      true,
      "Source file must be preserved when verification fails",
    );
    assertEquals(
      await fileExists(`${destRoot}/2020/11/03/${filename}`),
      false,
      "Corrupted destination file must be cleaned up on verification failure",
    );

    // 2. Subsequent retry archives cleanly to primary path (not (1))
    const retryRun = await inspectAndProcess(
      {
        sourceDir,
        destRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
      "archive",
      "2020-11-04",
    );
    assertEquals(retryRun.errorCount, 0);
    assertEquals(retryRun.archivedCount, 1);
    assertEquals(
      await Deno.readTextFile(`${destRoot}/2020/11/03/${filename}`),
      "good-screenshot-bytes",
    );
    assertEquals(
      await fileExists(
        `${destRoot}/2020/11/03/Screenshot 2020-11-03 at 10.00.00 AM (1).png`,
      ),
      false,
      "Retry must use primary filename slot after cleanup",
    );

    // 3. Test behavior.methods.archive.execute persists partial summary and logs/throws detailed error
    const okFile = "Screenshot 2020-11-02 at 09.00.00 AM.png";
    const errFile = "Screenshot 2020-11-03 at 11.00.00 AM.png";
    await Deno.writeTextFile(`${sourceDir}/${okFile}`, "ok-bytes");
    await Deno.writeTextFile(`${sourceDir}/${errFile}`, "err-bytes");
    await setXattr(
      `${sourceDir}/${okFile}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );
    await setXattr(
      `${sourceDir}/${errFile}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );

    // Make 2020/11/03 read-only so copying errFile fails while 2020/11/02 succeeds
    await Deno.chmod(`${destRoot}/2020/11/03`, 0o555);
    const persistedSummaries: SummaryResource[] = [];
    const loggedErrors: Array<
      { msg: string; props?: Record<string, unknown> }
    > = [];
    let thrownError: Error | null = null;
    try {
      await behavior.methods.archive.execute(
        { dryRun: false, deleteSource: true },
        {
          globalArgs: {
            sourceDir,
            destRoot,
            dateFormat: "YYYY/MM/DD",
            keepToday: true,
          },
          logger: {
            info: () => {},
            error: (msg, props) => {
              loggedErrors.push({ msg, props });
            },
          },
          writeResource: (_specName, instanceName, data) => {
            persistedSummaries.push(data as unknown as SummaryResource);
            return Promise.resolve({ name: instanceName });
          },
        },
      );
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
    } finally {
      await Deno.chmod(`${destRoot}/2020/11/03`, 0o755);
    }

    assert(
      thrownError !== null,
      "Expected archive.execute to throw when errorCount > 0",
    );
    assert(
      thrownError.message.includes(errFile),
      `Expected thrown error to include failed filename '${errFile}', got: ${thrownError.message}`,
    );
    assertEquals(
      persistedSummaries.length,
      1,
      "Partial-run summary resource must be written before throwing",
    );
    assertEquals(persistedSummaries[0].archivedCount, 1);
    assertEquals(persistedSummaries[0].errorCount, 1);
    assertEquals(loggedErrors.length, 1);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("sourceDir override scans and deletes from overridden directory, leaving default Desktop untouched", async () => {
  const tempRoot = await Deno.makeTempDir({
    prefix: "screenshot-sourcedir-override-",
  });
  try {
    const defaultDesktop = `${tempRoot}/Desktop`;
    const subfolderSource = `${tempRoot}/Desktop/Screenshots`;
    const destRoot = `${tempRoot}/Daily`;
    await Deno.mkdir(defaultDesktop, { recursive: true });
    await Deno.mkdir(subfolderSource, { recursive: true });
    await Deno.mkdir(destRoot, { recursive: true });

    const desktopFile = "Screenshot 2020-11-03 at 09.00.00 AM.png";
    const subfolderFile = "Screenshot 2020-02-18 at 09.18.04 PM.png";

    await Deno.writeTextFile(
      `${defaultDesktop}/${desktopFile}`,
      "on-main-desktop",
    );
    await Deno.writeTextFile(
      `${subfolderSource}/${subfolderFile}`,
      "in-screenshots-subfolder",
    );
    await setXattr(
      `${defaultDesktop}/${desktopFile}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );
    await setXattr(
      `${subfolderSource}/${subfolderFile}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );

    await behavior.methods.archive.execute(
      {
        dryRun: false,
        deleteSource: true,
        sourceDir: subfolderSource,
      },
      {
        globalArgs: {
          sourceDir: defaultDesktop,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        writeResource: (_specName, instanceName, _data) =>
          Promise.resolve({ name: instanceName }),
      },
    );

    // Subfolder file was archived to Daily/2020/02/18 and removed from subfolderSource
    assertEquals(
      await Deno.readTextFile(`${destRoot}/2020/02/18/${subfolderFile}`),
      "in-screenshots-subfolder",
    );
    assertEquals(
      await fileExists(`${subfolderSource}/${subfolderFile}`),
      false,
    );

    // Default Desktop file was NOT touched
    assertEquals(await fileExists(`${defaultDesktop}/${desktopFile}`), true);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("deleteSource=false copies and checksum-verifies without deleting Desktop source", async () => {
  const tempRoot = await Deno.makeTempDir({
    prefix: "screenshot-copy-verify-test-",
  });
  try {
    const sourceDir = `${tempRoot}/Desktop`;
    const realDest = `${tempRoot}/Daily`;
    const tempDest = `${tempRoot}/TempArchive`;
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(realDest, { recursive: true });
    await Deno.mkdir(tempDest, { recursive: true });

    const filename = "Screenshot 2020-11-03 at 10.00.00 AM.png";
    await Deno.writeTextFile(
      `${sourceDir}/${filename}`,
      "verify-keep-source-bytes",
    );
    await setXattr(
      `${sourceDir}/${filename}`,
      "com.apple.metadata:kMDItemIsScreenCapture",
    );

    await behavior.methods.archive.execute(
      { dryRun: false, deleteSource: false, destRoot: tempDest },
      {
        globalArgs: {
          sourceDir,
          destRoot: realDest,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        writeResource: (_specName, instanceName, _data) =>
          Promise.resolve({ name: instanceName }),
      },
    );

    // Source still exists on Desktop
    assertEquals(
      await Deno.readTextFile(`${sourceDir}/${filename}`),
      "verify-keep-source-bytes",
    );
    // Copy exists in tempDest/2020/11/03
    assertEquals(
      await Deno.readTextFile(`${tempDest}/2020/11/03/${filename}`),
      "verify-keep-source-bytes",
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});
