import {
  behavior,
  computeSha256,
  formatDateSubpath,
  getExtendedAttributesMap,
  getLocalToday,
  inspectAndProcess,
  isValidDateString,
  parseScreenshotFilename,
} from "./screenshot_archiver.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message ? message + ": " : ""}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function setXattr(filePath: string, attrName: string, value = "1"): Promise<void> {
  const cmd = new Deno.Command("xattr", {
    args: ["-w", attrName, value, filePath],
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

Deno.test("formatDateSubpath supports Obsidian-style date formats", () => {
  assertEquals(formatDateSubpath("2026-11-03", "YYYY/MM/DD"), "2026/11/03");
  assertEquals(formatDateSubpath("2026-11-03", "YYYY-MM-DD"), "2026-11-03");
  assertEquals(
    formatDateSubpath("2026-11-03", "YYYY/MM/YYYY-MM-DD"),
    "2026/11/2026-11-03",
  );
  assertEquals(formatDateSubpath("2026-11-03", "YY/MM/DD"), "26/11/03");

  let threw = false;
  try {
    formatDateSubpath("2026-11-03", "../YYYY/MM/DD");
  } catch {
    threw = true;
  }
  assert(threw, "Expected path traversal in dateFormat to throw");
});

Deno.test("parseScreenshotFilename matches screenshots and screen recordings", () => {
  const s1 = parseScreenshotFilename("Screenshot 2026-11-03 at 10.15.20 AM.png");
  assertEquals(s1.matchedPrefix, true);
  assertEquals(s1.kind, "screenshot");
  assertEquals(s1.fileDate, "2026-11-03");

  const s2 = parseScreenshotFilename("Screen Shot 2026-02-28 at 14.05.00.png");
  assertEquals(s2.matchedPrefix, false);

  const sr = parseScreenshotFilename("Screen Recording 2026-11-01 at 09.30.00.mov");
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

  const prefixed = parseScreenshotFilename(
    "before Screenshot 2026-02-04 at 2.29.43 pm.png",
    2026,
  );
  assertEquals(prefixed.matchedPrefix, false);

  for (const ext of ["png", "jpg", "pdf", "tiff", "gif", "heic"]) {
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

  const wrongRecordingExt = parseScreenshotFilename(
    "Screen Recording 2026-11-03 at 10.15.20 AM.mp4",
    2026,
  );
  assertEquals(wrongRecordingExt.matchedPrefix, false);

  const badDate = parseScreenshotFilename("Screenshot 2026-02-30 at 10.00.00.png");
  assertEquals(badDate.matchedPrefix, true);
  assertEquals(badDate.fileDate, undefined);

  const nonMatch = parseScreenshotFilename("vacation-photo.jpg");
  assertEquals(nonMatch.matchedPrefix, false);
  assertEquals(isValidDateString("2026-11-04"), true);
  assertEquals(isValidDateString("2026-02-29"), false);
});

Deno.test("scan and archive end-to-end with rsync checksum and xattr verification", async () => {
  const tempRoot = await Deno.makeTempDir({ prefix: "screenshot-archiver-test-" });
  try {
    const sourceDir = `${tempRoot}/Desktop`;
    const destRoot = `${tempRoot}/Daily`;
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(destRoot, { recursive: true });

    const today = getLocalToday();
    const yesterdayShot = "Screenshot 2026-11-03 at 10.00.00 AM.png";
    const yesterdayRec = "Screen Recording 2026-11-02 at 18.30.00.mov";
    const fakeShotWithoutXattr = "Screenshot 2026-11-01 at 12.00.00 PM.png";
    const todayShot = `Screenshot ${today} at 08.00.00 AM.png`;
    const otherFile = "notes.md";

    await Deno.writeTextFile(`${sourceDir}/${yesterdayShot}`, "png-bytes-12345");
    await Deno.writeTextFile(`${sourceDir}/${yesterdayRec}`, "mov-bytes-67890");
    await Deno.writeTextFile(`${sourceDir}/${fakeShotWithoutXattr}`, "not-a-real-screenshot");
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

    const expectedShotSha = await computeSha256(`${sourceDir}/${yesterdayShot}`);

    // 1. Read-only scan
    const scanResult = await inspectAndProcess(
      {
        sourceDir,
        destRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
      "scan",
      today,
    );

    assertEquals(scanResult.scannedCount, 5);
    assertEquals(scanResult.matchedCount, 3);
    assertEquals(scanResult.skippedMissingXattrCount, 1);
    assertEquals(scanResult.eligibleCount, 2);
    assertEquals(scanResult.skippedTodayCount, 1);
    assertEquals(scanResult.archivedCount, 0);

    // 2. Archive via behavior.methods.archive.execute
    const written: Array<{ specName: string; instanceName: string; data: unknown }> = [];
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
    const archivedDest = `${destRoot}/2026/11/03/${yesterdayShot}`;
    const archivedRecDest = `${destRoot}/2026/11/02/${yesterdayRec}`;
    const destSha = await computeSha256(archivedDest);
    assertEquals(destSha, expectedShotSha, "Destination SHA-256 must match source");

    const destXattrs = await getExtendedAttributesMap([archivedDest]);
    assertEquals(
      destXattrs.get(archivedDest)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      true,
      "Archived screenshot must preserve kMDItemIsScreenCapture xattr via Homebrew rsync -aX",
    );

    const recContent = await Deno.readTextFile(archivedRecDest);
    assertEquals(recContent, "mov-bytes-67890");

    assertEquals(
      await fileExists(`${sourceDir}/${yesterdayShot}`),
      false,
      "Archived screenshot should be removed from Desktop",
    );

    const todayContent = await Deno.readTextFile(`${sourceDir}/${todayShot}`);
    assertEquals(todayContent, "today-png-bytes", "Today's screenshot must stay on Desktop");

    const fakeContent = await Deno.readTextFile(`${sourceDir}/${fakeShotWithoutXattr}`);
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
    const existingDir = `${destRoot}/2026/11/03`;
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(existingDir, { recursive: true });

    const diffFilename = "Screenshot 2026-11-03 at 10.00.00 AM.png";
    const sameFilename = "Screenshot 2026-11-03 at 11.00.00 AM.png";

    // Pre-populate destination with both files
    await Deno.writeTextFile(`${existingDir}/${diffFilename}`, "original-file-v1");
    await Deno.writeTextFile(`${existingDir}/${sameFilename}`, "identical-bytes-xyz");

    // Source has a different version of diffFilename, and an identical copy of sameFilename
    await Deno.writeTextFile(`${sourceDir}/${diffFilename}`, "second-file-different-bytes");
    await Deno.writeTextFile(`${sourceDir}/${sameFilename}`, "identical-bytes-xyz");
    await setXattr(`${sourceDir}/${diffFilename}`, "com.apple.metadata:kMDItemIsScreenCapture");
    await setXattr(`${sourceDir}/${sameFilename}`, "com.apple.metadata:kMDItemIsScreenCapture");

    const result = await inspectAndProcess(
      {
        sourceDir,
        destRoot,
        dateFormat: "YYYY/MM/DD",
        keepToday: true,
      },
      "archive",
      "2026-11-04",
    );

    assertEquals(result.copiedVerifiedCount, 1);
    assertEquals(result.deduplicatedCount, 1);
    assertEquals(result.archivedCount, 2);

    // diffFilename got a (1) suffix because content differed
    const collidedPath = `${existingDir}/Screenshot 2026-11-03 at 10.00.00 AM (1).png`;
    assertEquals(await Deno.readTextFile(`${existingDir}/${diffFilename}`), "original-file-v1");
    assertEquals(await Deno.readTextFile(collidedPath), "second-file-different-bytes");

    // sameFilename did NOT create a (1) duplicate because content matched,
    // AND its missing extended attributes were synced in place via rsync -aXN!
    assertEquals(
      await fileExists(`${existingDir}/Screenshot 2026-11-03 at 11.00.00 AM (1).png`),
      false,
      "Identical file should be deduplicated, not duplicated as (1)",
    );
    const dedupXattrs = await getExtendedAttributesMap([`${existingDir}/${sameFilename}`]);
    assertEquals(
      dedupXattrs.get(`${existingDir}/${sameFilename}`)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
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

Deno.test("sourceDir override scans and deletes from overridden directory, leaving default Desktop untouched", async () => {
  const tempRoot = await Deno.makeTempDir({ prefix: "screenshot-sourcedir-override-" });
  try {
    const defaultDesktop = `${tempRoot}/Desktop`;
    const subfolderSource = `${tempRoot}/Desktop/Screenshots`;
    const destRoot = `${tempRoot}/Daily`;
    await Deno.mkdir(defaultDesktop, { recursive: true });
    await Deno.mkdir(subfolderSource, { recursive: true });
    await Deno.mkdir(destRoot, { recursive: true });

    const desktopFile = "Screenshot 2026-11-03 at 09.00.00 AM.png";
    const subfolderFile = "Screenshot 2026-02-18 at 09.18.04 PM.png";

    await Deno.writeTextFile(`${defaultDesktop}/${desktopFile}`, "on-main-desktop");
    await Deno.writeTextFile(`${subfolderSource}/${subfolderFile}`, "in-screenshots-subfolder");
    await setXattr(`${defaultDesktop}/${desktopFile}`, "com.apple.metadata:kMDItemIsScreenCapture");
    await setXattr(`${subfolderSource}/${subfolderFile}`, "com.apple.metadata:kMDItemIsScreenCapture");

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

    // Subfolder file was archived to Daily/2026/02/18 and removed from subfolderSource
    assertEquals(
      await Deno.readTextFile(`${destRoot}/2026/02/18/${subfolderFile}`),
      "in-screenshots-subfolder",
    );
    assertEquals(await fileExists(`${subfolderSource}/${subfolderFile}`), false);

    // Default Desktop file was NOT touched
    assertEquals(await fileExists(`${defaultDesktop}/${desktopFile}`), true);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("deleteSource=false copies and checksum-verifies without deleting Desktop source", async () => {
  const tempRoot = await Deno.makeTempDir({ prefix: "screenshot-copy-verify-test-" });
  try {
    const sourceDir = `${tempRoot}/Desktop`;
    const realDest = `${tempRoot}/Daily`;
    const tempDest = `${tempRoot}/TempArchive`;
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(realDest, { recursive: true });
    await Deno.mkdir(tempDest, { recursive: true });

    const filename = "Screenshot 2026-11-03 at 10.00.00 AM.png";
    await Deno.writeTextFile(`${sourceDir}/${filename}`, "verify-keep-source-bytes");
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
    // Copy exists in tempDest/2026/11/03
    assertEquals(
      await Deno.readTextFile(`${tempDest}/2026/11/03/${filename}`),
      "verify-keep-source-bytes",
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});
