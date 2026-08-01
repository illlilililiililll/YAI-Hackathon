import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { sha256Bytes, sha256Canonical } from "./canonical-json.js";

export type McpTextContent = { type: "text"; text: string };
export type McpCallResult = {
  isError?: boolean;
  content: Array<McpTextContent | { type: string; [key: string]: unknown }>;
  structuredContent?: unknown;
};

export interface McpToolCaller {
  callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallResult>;
}

export type GoogleBrowserOperation = {
  operationId: string;
  seq: number;
  parentToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsSha256: string;
  result: McpCallResult;
  resultSha256: string;
  observedAt: string;
};

export type GoogleCsvDownloadReceipt = {
  schemaVersion: "1.0";
  runId: string;
  parentToolCallId: string;
  clickOperationId: string;
  outputDirectoryPathSha256: string;
  preClickDirectoryEntriesSha256: string;
  relativeFilename: string;
  initiatedAt: string;
  completedAt: string;
  rawArtifactId: string;
  byteLength: number;
  csvSha256: string;
  receiptSha256: string;
};

export type StableDownload = {
  bytes: Uint8Array;
  receipt: GoogleCsvDownloadReceipt;
};

function textContent(result: McpCallResult): string {
  return result.content
    .filter(
      (item): item is McpTextContent =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function resultProjection(result: McpCallResult): unknown {
  return {
    isError: result.isError === true,
    content: result.content.map((item) =>
      item.type === "text" && typeof item.text === "string"
        ? { type: "text", text: item.text }
        : { type: item.type },
    ),
    structuredContent: result.structuredContent ?? null,
  };
}

export class GoogleBrowserRuntime {
  private sequence = 0;
  private readonly operations: GoogleBrowserOperation[] = [];

  constructor(
    private readonly server: McpToolCaller,
    private readonly parentToolCallId: string,
    private readonly onOperation?: (operation: GoogleBrowserOperation) => void,
  ) {}

  get operationLog(): readonly GoogleBrowserOperation[] {
    return this.operations;
  }

  async call(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ operation: GoogleBrowserOperation; text: string }> {
    signal?.throwIfAborted();
    const result = await this.server.callToolResult(
      toolName,
      args,
      null,
      signal ? { signal } : undefined,
    );
    const operation: GoogleBrowserOperation = {
      operationId: `operation_${randomUUID()}`,
      seq: ++this.sequence,
      parentToolCallId: this.parentToolCallId,
      toolName,
      args,
      argsSha256: sha256Canonical(args),
      result,
      resultSha256: sha256Canonical(resultProjection(result)),
      observedAt: new Date().toISOString(),
    };
    this.operations.push(operation);
    this.onOperation?.(operation);
    const text = textContent(result);
    if (result.isError) {
      throw new Error(text || `${toolName} MCP 호출이 실패했습니다.`);
    }
    return { operation, text };
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Google CSV 다운로드가 중단되었습니다."));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function snapshotEmptyDownloadDirectory(
  outputDirectory: string,
): Promise<string[]> {
  const stat = await lstat(outputDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Google output directory는 실제 directory여야 합니다.");
  }
  const entries = (await readdir(outputDirectory)).sort();
  if (entries.length !== 0) {
    throw new Error("Google output directory는 click 전에 비어 있어야 합니다.");
  }
  return entries;
}

export async function waitForStableCsvDownload(input: {
  runId: string;
  parentToolCallId: string;
  clickOperationId: string;
  outputDirectory: string;
  preClickEntries: string[];
  rawArtifactId: string;
  initiatedAt: string;
  timeoutMs?: number;
  pollMs?: number;
  stableSamples?: number;
  signal?: AbortSignal;
}): Promise<StableDownload> {
  const timeoutMs = input.timeoutMs ?? 12_000;
  const pollMs = input.pollMs ?? 100;
  const stableSamples = input.stableSamples ?? 3;
  const started = performance.now();
  let lastSignature: string | null = null;
  let stableCount = 0;

  while (performance.now() - started <= timeoutMs) {
    input.signal?.throwIfAborted();
    const entries = (await readdir(input.outputDirectory)).sort();
    const newEntries = entries.filter(
      (entry) => !input.preClickEntries.includes(entry),
    );
    if (newEntries.length > 1) {
      throw new Error("Google CSV click 뒤 파일이 둘 이상 생성되었습니다.");
    }
    const filename = newEntries[0];
    if (!filename) {
      await delay(pollMs, input.signal);
      continue;
    }

    const filePath = path.join(input.outputDirectory, filename);
    const relative = path.relative(input.outputDirectory, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Google CSV 다운로드 경로가 output directory 밖입니다.");
    }
    const stat = await lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Google CSV 다운로드는 실제 regular file이어야 합니다.");
    }
    if (stat.size === 0n) {
      stableCount = 0;
      lastSignature = null;
      await delay(pollMs, input.signal);
      continue;
    }

    const signature = `${stat.size}:${stat.mtimeNs}`;
    stableCount = signature === lastSignature ? stableCount + 1 : 1;
    lastSignature = signature;
    if (stableCount < stableSamples) {
      await delay(pollMs, input.signal);
      continue;
    }

    const bytes = new Uint8Array(await readFile(filePath));
    const afterRead = await lstat(filePath, { bigint: true });
    if (`${afterRead.size}:${afterRead.mtimeNs}` !== signature) {
      stableCount = 0;
      lastSignature = null;
      await delay(pollMs, input.signal);
      continue;
    }
    const receiptWithoutSelf = {
      schemaVersion: "1.0" as const,
      runId: input.runId,
      parentToolCallId: input.parentToolCallId,
      clickOperationId: input.clickOperationId,
      outputDirectoryPathSha256: sha256Canonical(
        path.resolve(input.outputDirectory),
      ),
      preClickDirectoryEntriesSha256: sha256Canonical(input.preClickEntries),
      relativeFilename: relative,
      initiatedAt: input.initiatedAt,
      completedAt: new Date().toISOString(),
      rawArtifactId: input.rawArtifactId,
      byteLength: bytes.byteLength,
      csvSha256: sha256Bytes(bytes),
    };
    return {
      bytes,
      receipt: {
        ...receiptWithoutSelf,
        receiptSha256: sha256Canonical(receiptWithoutSelf),
      },
    };
  }

  throw new Error("Google CSV 다운로드가 12초 안에 안정화되지 않았습니다.");
}
