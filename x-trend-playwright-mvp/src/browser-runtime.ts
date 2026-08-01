import { randomBytes, randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  BrowserInvocationReceiptSchema,
  BrowserLeaseReceiptSchema,
  BrowserMcpArgumentsSchema,
  BrowserOperationEnvelopeSchema,
  ExtractorReceiptSchema,
  McpCallToolResultProjectionSchema,
  ObservationAcquisitionReceiptSchema,
  WrapperCausalReceiptSchema,
  type BrowserInvocationReceipt,
  type BrowserLeaseReceipt,
  type BrowserMcpArguments,
  type BrowserMcpToolName,
  type BrowserOperationEnvelope,
  type BrowserSite,
  type ExtractorReceipt,
  type McpCallToolResultProjection,
  type ObservationAcquisitionReceipt,
  type SignalProviderError,
  type WrapperCausalReceipt,
} from "./content-domain.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Canonical,
} from "./canonical-json.js";

export interface BrowserMcpServer {
  connect(): Promise<void>;
  close(): Promise<void>;
  callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  readonly serverInfo?: unknown;
}

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: SignalProviderError["code"],
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrowserRuntimeError";
  }
}

export type BrowserRuntimeServerContext = {
  site: BrowserSite;
  profileDirectory: string;
  leaseId: string;
};

export type BrowserRuntimeOptions = {
  profiles: Record<BrowserSite, string>;
  createServer: (
    context: BrowserRuntimeServerContext,
  ) => BrowserMcpServer | Promise<BrowserMcpServer>;
  allowedTools?: Partial<Record<BrowserSite, readonly BrowserMcpToolName[]>>;
  onOperation?: (operation: BrowserOperationEnvelope) => void;
};

export type BrowserLeaseExecutionInput<T> = {
  runId: string;
  parentToolCallId: string;
  site: BrowserSite;
  stage: "collecting_x" | "evaluating_google";
  request: unknown;
  extractorId:
    | "x-signal-extractor-v1"
    | "google-trends-explore-extractor-v1";
  extractorBuildSha256: string;
  signal?: AbortSignal;
  execute: (session: BrowserLeaseSession) => Promise<{
    output: T;
    downloadReceiptSha256s?: string[];
  }>;
};

export type BrowserCausalBundle<T> = {
  output: T;
  operations: BrowserOperationEnvelope[];
  lease: BrowserLeaseReceipt;
  invocation: BrowserInvocationReceipt;
  extractor: ExtractorReceipt;
  wrapper: WrapperCausalReceipt;
  acquisition: ObservationAcquisitionReceipt & { adapter: "playwright" };
};

const DEFAULT_ALLOWED_TOOLS: Record<
  BrowserSite,
  readonly BrowserMcpToolName[]
> = {
  x: [
    "browser_navigate",
    "browser_wait_for",
    "browser_snapshot",
    "browser_evaluate",
    "browser_close",
  ],
  google_trends: [
    "browser_navigate",
    "browser_wait_for",
    "browser_snapshot",
    "browser_click",
    "browser_evaluate",
    "browser_close",
  ],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function materializeMcpResult(value: unknown): McpCallToolResultProjection {
  let materialized: unknown;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("MCP result가 JSON value가 아닙니다.");
    }
    materialized = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new BrowserRuntimeError(
      "contract_violation",
      `MCP result를 JSON-safe value로 만들 수 없습니다: ${errorMessage(error)}`,
    );
  }

  if (typeof materialized !== "object" || materialized === null) {
    throw new BrowserRuntimeError(
      "contract_violation",
      "MCP result root는 object여야 합니다.",
    );
  }
  const source = materialized as {
    isError?: unknown;
    content?: unknown;
    structuredContent?: unknown;
  };
  if (!Array.isArray(source.content)) {
    throw new BrowserRuntimeError(
      "contract_violation",
      "MCP result content는 array여야 합니다.",
    );
  }
  const content = source.content.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "MCP result content는 text item만 허용합니다.",
      );
    }
    return { type: "text" as const, text: (item as { text: string }).text };
  });
  return McpCallToolResultProjectionSchema.parse({
    isError: source.isError === true,
    content,
    structuredContent: source.structuredContent ?? null,
  });
}

function resultText(result: McpCallToolResultProjection): string {
  return result.content.map((item) => item.text).join("\n");
}

class SerialMutex {
  private tail: Promise<void> = Promise.resolve();

  async lock(): Promise<() => void> {
    let unlockCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      unlockCurrent = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        unlockCurrent();
      }
    };
  }
}

type ProfileLockMetadata = {
  schemaVersion: "1.0";
  token: string;
  pid: number;
  profileDirectory: string;
  acquiredAt: string;
};

export class BrowserProfileLock {
  private released = false;

  private constructor(
    readonly profileDirectory: string,
    readonly lockPath: string,
    private readonly handle: FileHandle,
    private readonly metadata: ProfileLockMetadata,
  ) {}

  static async acquire(profileDirectoryInput: string): Promise<BrowserProfileLock> {
    const profileDirectory = path.resolve(profileDirectoryInput);
    const lockPath = `${profileDirectory}.yai-browser.lock`;
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BrowserRuntimeError(
          "profile_in_use",
          `브라우저 profile lock이 이미 존재합니다: ${lockPath}`,
          true,
        );
      }
      throw error;
    }
    const metadata: ProfileLockMetadata = {
      schemaVersion: "1.0",
      token: randomBytes(32).toString("hex"),
      pid: process.pid,
      profileDirectory,
      acquiredAt: new Date().toISOString(),
    };
    try {
      await handle.writeFile(`${canonicalJson(metadata)}\n`, "utf8");
      await handle.sync();
      return new BrowserProfileLock(
        profileDirectory,
        lockPath,
        handle,
        metadata,
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "브라우저 profile lock은 두 번 해제할 수 없습니다.",
      );
    }
    const stat = await lstat(this.lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "브라우저 profile lock inode가 바뀌었습니다.",
      );
    }
    const stored = await readFile(this.lockPath, "utf8");
    if (stored !== `${canonicalJson(this.metadata)}\n`) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "브라우저 profile lock owner가 바뀌었습니다.",
      );
    }
    await this.handle.close();
    await unlink(this.lockPath);
    this.released = true;
  }
}

type BrowserLeaseSessionOptions = {
  server: BrowserMcpServer;
  runId: string;
  invocationId: string;
  parentToolCallId: string;
  leaseId: string;
  site: BrowserSite;
  allowedTools: ReadonlySet<BrowserMcpToolName>;
  signal?: AbortSignal;
  nextSeq: () => number;
  onOperation?: (operation: BrowserOperationEnvelope) => void;
};

export class BrowserLeaseSession {
  private readonly operationEnvelopes: BrowserOperationEnvelope[] = [];

  constructor(private readonly options: BrowserLeaseSessionOptions) {}

  get operations(): readonly BrowserOperationEnvelope[] {
    return this.operationEnvelopes;
  }

  get leaseId(): string {
    return this.options.leaseId;
  }

  get invocationId(): string {
    return this.options.invocationId;
  }

  get parentToolCallId(): string {
    return this.options.parentToolCallId;
  }

  async call(
    toolName: BrowserMcpToolName,
    args: Record<string, unknown>,
  ): Promise<{ result: McpCallToolResultProjection; text: string; operationId: string }> {
    this.options.signal?.throwIfAborted();
    if (!this.options.allowedTools.has(toolName)) {
      throw new BrowserRuntimeError(
        "contract_violation",
        `${this.options.site} lease에서 ${toolName} 호출은 허용되지 않습니다.`,
      );
    }
    const request = BrowserMcpArgumentsSchema.parse({ toolName, args });
    const operationId = `operation_${randomUUID()}`;
    const base = {
      operationId,
      invocationId: this.options.invocationId,
      parentToolCallId: this.options.parentToolCallId,
      leaseId: this.options.leaseId,
      site: this.options.site,
    } as const;
    this.append({
      schemaVersion: "1.0",
      runId: this.options.runId,
      seq: this.options.nextSeq(),
      observedAt: new Date().toISOString(),
      provider: "playwright_mcp",
      operation: {
        phase: "call",
        ...base,
        request,
        argsSha256: sha256Canonical(request.args),
      },
    });

    let result: McpCallToolResultProjection;
    try {
      const raw = await this.options.server.callToolResult(
        toolName,
        request.args,
        null,
        this.options.signal ? { signal: this.options.signal } : undefined,
      );
      result = materializeMcpResult(raw);
    } catch (error) {
      const runtimeError = {
        kind: "runtime_error" as const,
        code: "mcp_call_failed" as const,
        message: errorMessage(error) || "MCP call failed",
      };
      this.append({
        schemaVersion: "1.0",
        runId: this.options.runId,
        seq: this.options.nextSeq(),
        observedAt: new Date().toISOString(),
        provider: "playwright_mcp",
        operation: {
          phase: "result",
          ...base,
          toolName,
          result: runtimeError,
          resultSha256: sha256Canonical(runtimeError),
        },
      });
      throw error;
    }

    const operationResult = {
      kind: "mcp_result" as const,
      value: result,
    };
    this.append({
      schemaVersion: "1.0",
      runId: this.options.runId,
      seq: this.options.nextSeq(),
      observedAt: new Date().toISOString(),
      provider: "playwright_mcp",
      operation: {
        phase: "result",
        ...base,
        toolName,
        result: operationResult,
        resultSha256: sha256Canonical(operationResult),
      },
    });
    if (result.isError) {
      throw new BrowserRuntimeError(
        "adapter_start_failed",
        resultText(result) || `${toolName} MCP 호출이 실패했습니다.`,
        true,
      );
    }
    return { result, text: resultText(result), operationId };
  }

  private append(input: BrowserOperationEnvelope): void {
    const envelope = BrowserOperationEnvelopeSchema.parse(input);
    this.operationEnvelopes.push(envelope);
    this.options.onOperation?.(envelope);
  }
}

export class BrowserRuntime {
  private readonly mutex = new SerialMutex();
  private sequence = 0;
  private readonly profiles: Record<BrowserSite, string>;

  constructor(private readonly options: BrowserRuntimeOptions) {
    this.profiles = {
      x: path.resolve(options.profiles.x),
      google_trends: path.resolve(options.profiles.google_trends),
    };
    if (this.profiles.x === this.profiles.google_trends) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "X와 Google Trends는 같은 persistent profile을 사용할 수 없습니다.",
      );
    }
  }

  async execute<T>(
    input: BrowserLeaseExecutionInput<T>,
  ): Promise<BrowserCausalBundle<T>> {
    input.signal?.throwIfAborted();
    if (
      (input.site === "x" && input.stage !== "collecting_x") ||
      (input.site === "google_trends" && input.stage !== "evaluating_google")
    ) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "Browser site와 stage가 일치하지 않습니다.",
      );
    }

    const releaseSerial = await this.mutex.lock();
    let profileLock: BrowserProfileLock | null = null;
    let server: BrowserMcpServer | null = null;
    let connected = false;
    let keepLock = false;
    try {
      input.signal?.throwIfAborted();
      profileLock = await BrowserProfileLock.acquire(this.profiles[input.site]);
      const leaseId = `lease_${randomUUID()}`;
      const invocationId = `invocation_${randomUUID()}`;
      server = await this.options.createServer({
        site: input.site,
        profileDirectory: this.profiles[input.site],
        leaseId,
      });
      try {
        await server.connect();
        connected = true;
      } catch (error) {
        throw new BrowserRuntimeError(
          "adapter_start_failed",
          `Playwright MCP 연결에 실패했습니다: ${errorMessage(error)}`,
          true,
        );
      }

      const nonce = randomBytes(32);
      const lease = BrowserLeaseReceiptSchema.parse({
        schemaVersion: "1.0",
        leaseId,
        runId: input.runId,
        mode: "live",
        profile: input.site,
        connectedAt: new Date().toISOString(),
        serverInfoSha256: sha256Canonical(
          server.serverInfo ?? {
            name: "playwright-mcp",
            site: input.site,
            connected: true,
          },
        ),
        nonceSha256: sha256Bytes(nonce),
      });
      const session = new BrowserLeaseSession({
        server,
        runId: input.runId,
        invocationId,
        parentToolCallId: input.parentToolCallId,
        leaseId,
        site: input.site,
        allowedTools: new Set(
          this.options.allowedTools?.[input.site] ??
            DEFAULT_ALLOWED_TOOLS[input.site],
        ),
        signal: input.signal,
        nextSeq: () => ++this.sequence,
        onOperation: this.options.onOperation,
      });
      const executed = await input.execute(session);
      const operations = [...session.operations];
      if (operations.length === 0 || operations.length % 2 !== 0) {
        throw new BrowserRuntimeError(
          "contract_violation",
          "live Browser invocation에는 하나 이상의 closed operation pair가 필요합니다.",
        );
      }
      const operationCount = operations.length / 2;
      const firstSeq = operations[0]?.seq;
      const lastSeq = operations.at(-1)?.seq;
      if (firstSeq === undefined || lastSeq === undefined) {
        throw new BrowserRuntimeError(
          "contract_violation",
          "Browser operation sequence가 비어 있습니다.",
        );
      }
      const resultSha256 = sha256Canonical(executed.output);
      const invocation = BrowserInvocationReceiptSchema.parse({
        schemaVersion: "1.0",
        runId: input.runId,
        invocationId,
        parentToolCallId: input.parentToolCallId,
        leaseId,
        stage: input.stage,
        requestSha256: sha256Canonical(input.request),
        resultSha256,
        firstSeq,
        lastSeq,
        operationCount,
        status: "completed",
      });
      const extractor = ExtractorReceiptSchema.parse({
        schemaVersion: "1.0",
        extractorId: input.extractorId,
        extractorBuildSha256: input.extractorBuildSha256,
        orderedOperationIds: operations
          .filter((operation) => operation.operation.phase === "call")
          .map((operation) => operation.operation.operationId),
        // Despite the legacy field name, bind the complete ordered envelopes.
        // This transitively commits tool names, arguments, pair identity,
        // results, timestamps and sequence into extractor→wrapper hashes.
        operationResultsSha256: sha256Canonical(operations),
        output: executed.output,
        outputSha256: resultSha256,
      });
      const downloadReceiptSha256s = executed.downloadReceiptSha256s ?? [];
      const wrapperWithoutSelf = {
        schemaVersion: "1.0" as const,
        parentToolCallId: input.parentToolCallId,
        leaseId,
        leaseReceiptSha256: sha256Canonical(lease),
        invocationReceiptSha256: sha256Canonical(invocation),
        downloadReceiptSha256s,
        extractorReceiptSha256: sha256Canonical(extractor),
        outputSha256: resultSha256,
      };
      const wrapper = WrapperCausalReceiptSchema.parse({
        ...wrapperWithoutSelf,
        receiptSha256: sha256Canonical(wrapperWithoutSelf),
      });
      const acquisitionWithoutSelf = {
        adapter: "playwright" as const,
        wrapperCausalReceiptSha256: wrapper.receiptSha256,
        downloadReceiptSha256s,
      };
      const acquisition = ObservationAcquisitionReceiptSchema.parse({
        ...acquisitionWithoutSelf,
        receiptSha256: sha256Canonical(acquisitionWithoutSelf),
      }) as BrowserCausalBundle<T>["acquisition"];
      const bundle: BrowserCausalBundle<T> = {
        output: executed.output,
        operations,
        lease,
        invocation,
        extractor,
        wrapper,
        acquisition,
      };
      validateBrowserCausalBundle(bundle, {
        runId: input.runId,
        parentToolCallId: input.parentToolCallId,
        site: input.site,
        extractorBuildSha256: input.extractorBuildSha256,
        request: input.request,
      });
      return bundle;
    } finally {
      let closeError: unknown = null;
      if (server) {
        try {
          await server.close();
        } catch (error) {
          keepLock = true;
          closeError = new BrowserRuntimeError(
            "contract_violation",
            `Playwright MCP 종료에 실패해 profile lock을 보존했습니다: ${errorMessage(error)}`,
          );
        }
      }
      try {
        if (profileLock && !keepLock) {
          await profileLock.release();
        }
      } finally {
        releaseSerial();
      }
      if (closeError) {
        throw closeError;
      }
    }
  }
}

export function validateBrowserCausalBundle<T>(
  bundleInput: BrowserCausalBundle<T>,
  expected?: {
    runId?: string;
    parentToolCallId?: string;
    site?: BrowserSite;
    extractorBuildSha256?: string;
    request?: unknown;
  },
): BrowserCausalBundle<T> {
  const lease = BrowserLeaseReceiptSchema.parse(bundleInput.lease);
  const invocation = BrowserInvocationReceiptSchema.parse(bundleInput.invocation);
  const extractor = ExtractorReceiptSchema.parse(bundleInput.extractor);
  const wrapper = WrapperCausalReceiptSchema.parse(bundleInput.wrapper);
  const acquisition = ObservationAcquisitionReceiptSchema.parse(
    bundleInput.acquisition,
  );
  if (acquisition.adapter !== "playwright") {
    throw new BrowserRuntimeError(
      "contract_violation",
      "Browser causal bundle acquisition은 Playwright여야 합니다.",
    );
  }
  const operations = bundleInput.operations.map((operation) =>
    BrowserOperationEnvelopeSchema.parse(operation),
  );
  if (operations.length === 0 || operations.length % 2 !== 0) {
    throw new BrowserRuntimeError(
      "contract_violation",
      "Browser operation pair가 닫히지 않았습니다.",
    );
  }
  for (let index = 0; index < operations.length; index += 2) {
    const call = operations[index];
    const result = operations[index + 1];
    if (!call || !result || call.operation.phase !== "call" || result.operation.phase !== "result") {
      throw new BrowserRuntimeError(
        "contract_violation",
        "Browser operation은 연속 call→result pair여야 합니다.",
      );
    }
    if (result.seq !== call.seq + 1) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "Browser operation seq가 연속이 아닙니다.",
      );
    }
    const parityFields = [
      "operationId",
      "invocationId",
      "parentToolCallId",
      "leaseId",
      "site",
    ] as const;
    if (
      parityFields.some(
        (field) => call.operation[field] !== result.operation[field],
      ) ||
      call.operation.request.toolName !== result.operation.toolName
    ) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "Browser operation call/result identity가 다릅니다.",
      );
    }
    if (call.operation.argsSha256 !== sha256Canonical(call.operation.request.args)) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "Browser operation args hash가 다릅니다.",
      );
    }
    if (result.operation.resultSha256 !== sha256Canonical(result.operation.result)) {
      throw new BrowserRuntimeError(
        "contract_violation",
        "Browser operation result hash가 다릅니다.",
      );
    }
  }
  if (
    operations.some((operation, index) =>
      index === 0 ? false : operation.seq !== (operations[index - 1]?.seq ?? 0) + 1,
    )
  ) {
    throw new BrowserRuntimeError(
      "contract_violation",
      "Browser invocation operation range가 contiguous하지 않습니다.",
    );
  }
  const callRows = operations.filter(
    (operation) => operation.operation.phase === "call",
  );
  const outputSha256 = sha256Canonical(bundleInput.output);
  const mismatched =
    lease.leaseId !== invocation.leaseId ||
    lease.leaseId !== wrapper.leaseId ||
    invocation.parentToolCallId !== wrapper.parentToolCallId ||
    invocation.runId !== lease.runId ||
    invocation.firstSeq !== operations[0]?.seq ||
    invocation.lastSeq !== operations.at(-1)?.seq ||
    invocation.operationCount !== callRows.length ||
    invocation.resultSha256 !== outputSha256 ||
    operations.some(
      (operation) =>
        operation.runId !== lease.runId ||
        operation.operation.invocationId !== invocation.invocationId ||
        operation.operation.parentToolCallId !== invocation.parentToolCallId ||
        operation.operation.leaseId !== lease.leaseId ||
        operation.operation.site !== lease.profile,
    ) ||
    extractor.outputSha256 !== outputSha256 ||
    sha256Canonical(extractor.output) !== outputSha256 ||
    extractor.orderedOperationIds.length !== callRows.length ||
    extractor.orderedOperationIds.some(
      (operationId, index) =>
        operationId !==
        (callRows[index]?.operation.phase === "call"
          ? callRows[index].operation.operationId
          : undefined),
    ) ||
    extractor.operationResultsSha256 !==
      sha256Canonical(operations) ||
    wrapper.leaseReceiptSha256 !== sha256Canonical(lease) ||
    wrapper.invocationReceiptSha256 !== sha256Canonical(invocation) ||
    wrapper.extractorReceiptSha256 !== sha256Canonical(extractor) ||
    wrapper.outputSha256 !== outputSha256 ||
    wrapper.receiptSha256 !==
      sha256Canonical({
        schemaVersion: wrapper.schemaVersion,
        parentToolCallId: wrapper.parentToolCallId,
        leaseId: wrapper.leaseId,
        leaseReceiptSha256: wrapper.leaseReceiptSha256,
        invocationReceiptSha256: wrapper.invocationReceiptSha256,
        downloadReceiptSha256s: wrapper.downloadReceiptSha256s,
        extractorReceiptSha256: wrapper.extractorReceiptSha256,
        outputSha256: wrapper.outputSha256,
      }) ||
    acquisition.wrapperCausalReceiptSha256 !== wrapper.receiptSha256 ||
    canonicalJson(acquisition.downloadReceiptSha256s) !==
      canonicalJson(wrapper.downloadReceiptSha256s) ||
    acquisition.receiptSha256 !==
      sha256Canonical({
        adapter: acquisition.adapter,
        wrapperCausalReceiptSha256:
          acquisition.wrapperCausalReceiptSha256,
        downloadReceiptSha256s: acquisition.downloadReceiptSha256s,
      });
  if (mismatched) {
    throw new BrowserRuntimeError(
      "contract_violation",
      "Browser causal receipt graph가 output/operation과 일치하지 않습니다.",
    );
  }
  if (
    (expected?.runId !== undefined && expected.runId !== lease.runId) ||
    (expected?.parentToolCallId !== undefined &&
      expected.parentToolCallId !== wrapper.parentToolCallId) ||
    (expected?.site !== undefined && expected.site !== lease.profile) ||
    (expected?.extractorBuildSha256 !== undefined &&
      expected.extractorBuildSha256 !== extractor.extractorBuildSha256) ||
    (expected?.request !== undefined &&
      invocation.requestSha256 !== sha256Canonical(expected.request)) ||
    (lease.profile === "x" && invocation.stage !== "collecting_x") ||
    (lease.profile === "google_trends" &&
      invocation.stage !== "evaluating_google")
  ) {
    throw new BrowserRuntimeError(
      "contract_violation",
      "Browser causal receipt가 기대한 Run/provider/build와 다릅니다.",
    );
  }
  return {
    ...bundleInput,
    lease,
    invocation,
    extractor,
    wrapper,
    acquisition,
    operations,
  } as BrowserCausalBundle<T>;
}
