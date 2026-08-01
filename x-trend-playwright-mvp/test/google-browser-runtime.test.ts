import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GoogleBrowserRuntime,
  snapshotEmptyDownloadDirectory,
  waitForStableCsvDownload,
  type McpCallResult,
  type McpToolCaller,
} from "../src/google-browser-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true });
  }
});

describe("GoogleBrowserRuntime", () => {
  it("records a canonical operation for every direct MCP result", async () => {
    const result: McpCallResult = {
      content: [{ type: "text", text: "### Result\n{}" }],
    };
    const caller: McpToolCaller = {
      callToolResult: async () => result,
    };
    const runtime = new GoogleBrowserRuntime(caller, "call-google-1");

    const called = await runtime.call("browser_navigate", {
      url: "https://trends.google.com/trends/explore",
    });

    expect(called.text).toContain("### Result");
    expect(runtime.operationLog).toHaveLength(1);
    expect(runtime.operationLog[0]).toMatchObject({
      seq: 1,
      parentToolCallId: "call-google-1",
      toolName: "browser_navigate",
    });
    expect(runtime.operationLog[0]?.resultSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("waits until one CSV file is stable and binds its exact bytes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "google-download-test-"));
    temporaryDirectories.push(directory);
    const preClickEntries = await snapshotEmptyDownloadDirectory(directory);
    const initiatedAt = new Date().toISOString();

    setTimeout(() => {
      void writeFile(
        path.join(directory, "multiTimeline.csv"),
        "Time,제주\n2026-08-01T00,10",
        "utf8",
      );
    }, 20);

    const result = await waitForStableCsvDownload({
      runId: "run-1",
      parentToolCallId: "call-google-1",
      clickOperationId: "operation-click-1",
      outputDirectory: directory,
      preClickEntries,
      rawArtifactId: "google-artifact-csv-1",
      initiatedAt,
      timeoutMs: 1_000,
      pollMs: 10,
      stableSamples: 2,
    });

    expect(new TextDecoder().decode(result.bytes)).toContain("Time,제주");
    expect(result.receipt.byteLength).toBe(result.bytes.byteLength);
    expect(result.receipt.csvSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a non-empty output directory before click", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "google-download-test-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "stale.csv"), "stale", "utf8");

    await expect(snapshotEmptyDownloadDirectory(directory)).rejects.toThrow(
      "비어 있어야",
    );
  });
});
