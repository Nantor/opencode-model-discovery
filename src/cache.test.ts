import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isArrayOf, parseCacheDuration, readCache, writeCache } from "./cache.js";

describe("parseCacheDuration", () => {
  it("parses fixed-length ISO 8601 durations", () => {
    expect(parseCacheDuration("PT1H30M")).toBe(5_400_000);
    expect(parseCacheDuration("P1DT2S")).toBe(86_402_000);
    expect(parseCacheDuration("P2W")).toBe(1_209_600_000);
    expect(parseCacheDuration("PT0.02S")).toBe(20);
  });

  it("rejects zero, calendar-relative, and malformed durations", () => {
    expect(parseCacheDuration("PT0S")).toBeUndefined();
    expect(parseCacheDuration("P1M")).toBeUndefined();
    expect(parseCacheDuration("P1Y")).toBeUndefined();
    expect(parseCacheDuration("3600000")).toBeUndefined();
    expect(parseCacheDuration(3_600_000)).toBeUndefined();
  });
});

describe("readCache / writeCache", () => {
  let cacheHome: string | undefined;
  let directory: string;
  const isNumberArray = isArrayOf((value): value is number => typeof value === "number");

  beforeEach(async () => {
    cacheHome = process.env.XDG_CACHE_HOME;
    directory = await mkdtemp(join(tmpdir(), "opencode-model-discovery-cache-"));
    process.env.XDG_CACHE_HOME = directory;
  });

  afterEach(async () => {
    if (cacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = cacheHome;
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips a value", async () => {
    await writeCache("key", [1, 2, 3]);
    await expect(readCache("key", 60_000, isNumberArray)).resolves.toEqual([1, 2, 3]);
  });

  it("treats a value that fails validation as a cache miss", async () => {
    await writeCache("key", "not an array");
    await expect(readCache("key", 60_000, isNumberArray)).resolves.toBeUndefined();

    await writeCache("key", [1, "two"]);
    await expect(readCache("key", 60_000, isNumberArray)).resolves.toBeUndefined();
  });

  it("treats a malformed cache file as a cache miss", async () => {
    await writeCache("key", [1]);
    const cacheDirectory = join(directory, "opencode-model-discovery");
    const [file] = await readdir(cacheDirectory);
    await writeFile(join(cacheDirectory, file), "{not json", "utf8");
    await expect(readCache("key", 60_000, isNumberArray)).resolves.toBeUndefined();
  });

  it("removes the temporary file when the write cannot be completed", async () => {
    // Pre-create the final path as a directory so rename() fails.
    await writeCache("probe", [1]);
    const cacheDirectory = join(directory, "opencode-model-discovery");
    const [probe] = await readdir(cacheDirectory);
    await rm(join(cacheDirectory, probe));
    await mkdir(join(cacheDirectory, probe));

    await writeCache("probe", [2]);

    await expect(readdir(cacheDirectory)).resolves.toEqual([probe]);
  });

  it("treats an expired entry as a cache miss", async () => {
    await writeCache("key", [1]);
    const cacheDirectory = join(directory, "opencode-model-discovery");
    const [file] = await readdir(cacheDirectory);
    const path = join(cacheDirectory, file);
    const entry = JSON.parse(await readFile(path, "utf8")) as { createdAt: number };
    entry.createdAt = Date.now() - 120_000;
    await writeFile(path, JSON.stringify(entry), "utf8");
    await expect(readCache("key", 60_000, isNumberArray)).resolves.toBeUndefined();
  });
});
