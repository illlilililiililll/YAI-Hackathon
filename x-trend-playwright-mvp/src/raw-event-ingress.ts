import { createHash } from "node:crypto";

import {
  FrozenRawJournalReceiptV1Schema,
  RawEventEnvelopeV1Schema,
  type FrozenRawJournalReceiptV1,
} from "./content-domain.js";
import { canonicalJson, sha256Canonical, sha256Bytes } from "./canonical-json.js";
import type { RawEventPort } from "./raw-event-port.js";

const SENSITIVE_KEY_NAMES = [
  "authorization",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "cookie",
  "set-cookie",
] as const;
const REPLACEMENT = "[REDACTED]";
const PORT_FLUSH_DEADLINE_MS = 250;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RawAuditEntry = {
  seq: number;
  semanticPayloadSha256: string | null;
  redactedEventSha256: string;
};

export type SealedRawAuditIndex = {
  schemaVersion: "1.0";
  runId: string;
  entries: RawAuditEntry[];
};

export type RedactionPlan = {
  schemaVersion: "1.0";
  algorithm: "recursive-secret-value-redaction-v1";
  replacement: "[REDACTED]";
  sensitiveKeyNames: readonly string[];
  secretValueSha256: string[];
};

export type SealedRawJournal = {
  fileBytes: Uint8Array;
  receipt: FrozenRawJournalReceiptV1;
  auditIndex: SealedRawAuditIndex;
  redactionPlan: RedactionPlan;
  redactionPlanSha256: string;
  semanticProjectionSha256: string;
};

export type SemanticProjector = (snapshot: JsonValue) => unknown | null;

export type RawEventIngressOptions = {
  runId: string;
  secrets: readonly string[];
  port: RawEventPort;
  now?: () => Date;
  semanticProjector?: SemanticProjector;
  portFlushDeadlineMs?: number;
};

function assertJsonSafe(value: unknown, ancestors: Set<object>, inArray: boolean): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("SDK event는 non-finite number를 포함할 수 없습니다.");
    }
    return;
  }
  if (value === undefined) {
    if (inArray) {
      throw new Error("SDK event array는 undefined를 포함할 수 없습니다.");
    }
    return;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error(`SDK event는 ${typeof value} 값을 포함할 수 없습니다.`);
  }
  if (typeof value !== "object") {
    throw new Error("SDK event에 지원하지 않는 값이 있습니다.");
  }
  if (ancestors.has(value)) {
    throw new Error("SDK event는 cycle을 포함할 수 없습니다.");
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonSafe(item, nextAncestors, true);
    }
    return;
  }
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    throw new Error("SDK event object는 symbol key를 포함할 수 없습니다.");
  }
  for (const key of Object.keys(value)) {
    assertJsonSafe((value as Record<string, unknown>)[key], nextAncestors, false);
  }
}

function materializeCandidate(candidate: unknown): JsonValue {
  assertJsonSafe(candidate, new Set(), false);
  const text = JSON.stringify(candidate);
  if (text === undefined) {
    throw new Error("SDK event를 JSON으로 materialize할 수 없습니다.");
  }
  return JSON.parse(text) as JsonValue;
}

export function materializeSdkPublicEvent(event: unknown): JsonValue {
  if (typeof event !== "object" || event === null) {
    throw new Error("SDK stream event는 object여야 합니다.");
  }
  const candidate = event as {
    type?: unknown;
    name?: unknown;
    item?: { toJSON?: () => unknown };
    source?: unknown;
    data?: unknown;
    agent?: { name?: unknown };
  };
  if (candidate.type === "run_item_stream_event") {
    if (typeof candidate.name !== "string" || typeof candidate.item?.toJSON !== "function") {
      throw new Error("run item event의 name/item.toJSON()이 필요합니다.");
    }
    return materializeCandidate({
      type: candidate.type,
      name: candidate.name,
      item: candidate.item.toJSON(),
    });
  }
  if (candidate.type === "raw_model_stream_event") {
    return materializeCandidate({
      type: candidate.type,
      source: candidate.source,
      data: candidate.data,
    });
  }
  if (candidate.type === "agent_updated_stream_event") {
    if (typeof candidate.agent?.name !== "string") {
      throw new Error("agent updated event의 agent.name이 필요합니다.");
    }
    return materializeCandidate({
      type: candidate.type,
      agent: { name: candidate.agent.name },
    });
  }
  throw new Error("지원하지 않는 SDK stream event type입니다.");
}

function utf8CodePointLength(firstByte: number): number {
  if ((firstByte & 0x80) === 0) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  throw new Error("유효하지 않은 UTF-8 secret scan 입력입니다.");
}

type SecretMatcher = {
  value: string;
  bytes: Uint8Array;
  sha256: string;
};

function redactString(value: string, matchers: readonly SecretMatcher[]): string {
  const input = Buffer.from(value, "utf8");
  const chunks: Uint8Array[] = [];
  const replacement = Buffer.from(REPLACEMENT, "utf8");
  let offset = 0;
  while (offset < input.byteLength) {
    const match = matchers.find((candidate) => {
      if (offset + candidate.bytes.byteLength > input.byteLength) return false;
      return input.subarray(offset, offset + candidate.bytes.byteLength).equals(candidate.bytes);
    });
    if (match) {
      chunks.push(replacement);
      offset += match.bytes.byteLength;
      continue;
    }
    const width = utf8CodePointLength(input[offset] ?? 0);
    chunks.push(input.subarray(offset, offset + width));
    offset += width;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redactValue(
  value: JsonValue,
  matchers: readonly SecretMatcher[],
): JsonValue {
  if (typeof value === "string") return redactString(value, matchers);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, matchers));
  const redacted: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_NAMES.includes(
      key.toLowerCase() as (typeof SENSITIVE_KEY_NAMES)[number],
    )
      ? REPLACEMENT
      : redactValue(item, matchers);
  }
  return redacted;
}

function assertNoResidualSecret(
  value: JsonValue,
  secrets: readonly string[],
): void {
  if (typeof value === "string") {
    if (secrets.some((secret) => value.includes(secret))) {
      throw new Error("redaction 뒤 SDK event에 secret이 남았습니다.");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoResidualSecret(item, secrets));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (secrets.some((secret) => key.includes(secret))) {
      throw new Error("redaction 뒤 SDK event key에 secret이 남았습니다.");
    }
    assertNoResidualSecret(item, secrets);
  }
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} ${deadlineMs}ms deadline을 초과했습니다.`)),
      deadlineMs,
    );
    timeout.unref();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class RawEventIngress {
  private readonly matchers: SecretMatcher[];
  private readonly now: () => Date;
  private readonly semanticProjector: SemanticProjector;
  private readonly flushDeadlineMs: number;
  private readonly envelopeLines: Uint8Array[] = [];
  private readonly orderedEventLines: Uint8Array[] = [];
  private readonly auditEntries: RawAuditEntry[] = [];
  private queue: Promise<void> = Promise.resolve();
  private appendFailure: unknown;
  private sealRequested = false;

  readonly redactionPlan: RedactionPlan;

  constructor(private readonly options: RawEventIngressOptions) {
    const uniqueSecrets = [...new Set(options.secrets)];
    if (uniqueSecrets.some((secret) => secret.length === 0)) {
      throw new Error("empty secret은 redaction plan에 넣을 수 없습니다.");
    }
    this.matchers = uniqueSecrets
      .map((value) => ({
        value,
        bytes: Buffer.from(value, "utf8"),
        sha256: createHash("sha256").update(value, "utf8").digest("hex"),
      }))
      .sort(
        (left, right) =>
          right.bytes.byteLength - left.bytes.byteLength ||
          left.sha256.localeCompare(right.sha256, "en"),
      );
    this.redactionPlan = Object.freeze({
      schemaVersion: "1.0" as const,
      algorithm: "recursive-secret-value-redaction-v1" as const,
      replacement: REPLACEMENT,
      sensitiveKeyNames: SENSITIVE_KEY_NAMES,
      secretValueSha256: this.matchers.map((matcher) => matcher.sha256).sort(),
    });
    this.now = options.now ?? (() => new Date());
    this.semanticProjector = options.semanticProjector ?? (() => null);
    this.flushDeadlineMs = options.portFlushDeadlineMs ?? PORT_FLUSH_DEADLINE_MS;
  }

  accept(event: unknown): Promise<number> {
    if (this.sealRequested) {
      return Promise.reject(new Error("RawEventIngress는 seal 요청 뒤 append할 수 없습니다."));
    }
    const task = this.queue.then(() => this.append(event));
    this.queue = task.then(
      () => undefined,
      (error) => {
        this.appendFailure = error;
      },
    );
    return task;
  }

  private async append(event: unknown): Promise<number> {
    const snapshot = materializeSdkPublicEvent(event);
    const semanticProjection = this.semanticProjector(snapshot);
    if (semanticProjection === undefined) {
      throw new Error("semantic projector는 undefined를 반환할 수 없습니다.");
    }
    let semanticPayloadSha256: string | null = null;
    if (semanticProjection !== null) {
      const semanticSnapshot = materializeCandidate(semanticProjection);
      assertNoResidualSecret(
        semanticSnapshot,
        this.matchers.map((matcher) => matcher.value),
      );
      semanticPayloadSha256 = sha256Canonical(semanticSnapshot);
    }
    const redacted = redactValue(snapshot, this.matchers);
    assertNoResidualSecret(
      redacted,
      this.matchers.map((matcher) => matcher.value),
    );
    const seq = this.auditEntries.length + 1;
    const envelope = RawEventEnvelopeV1Schema.parse({
      schemaVersion: "1.0",
      runId: this.options.runId,
      seq,
      observedAt: this.now().toISOString(),
      event: redacted,
    });
    const encoder = new TextEncoder();
    const eventLine = encoder.encode(`${canonicalJson(redacted)}\n`);
    const envelopeLine = encoder.encode(`${canonicalJson(envelope)}\n`);
    await withDeadline(
      this.options.port.write(envelopeLine),
      this.flushDeadlineMs,
      "RawEventPort flush",
    );
    this.orderedEventLines.push(eventLine);
    this.envelopeLines.push(envelopeLine);
    this.auditEntries.push({
      seq,
      semanticPayloadSha256,
      redactedEventSha256: sha256Canonical(redacted),
    });
    return seq;
  }

  async seal(): Promise<SealedRawJournal> {
    if (this.sealRequested) {
      throw new Error("RawEventIngress는 두 번 seal할 수 없습니다.");
    }
    this.sealRequested = true;
    await this.queue;
    if (this.appendFailure) throw this.appendFailure;

    const fileBytes = joinBytes(this.envelopeLines);
    const orderedEventBytes = joinBytes(this.orderedEventLines);
    const portReceipt = await withDeadline(
      this.options.port.seal(),
      this.flushDeadlineMs,
      "RawEventPort seal",
    );
    const fileSha256 = sha256Bytes(fileBytes);
    if (
      portReceipt.eventCount !== this.auditEntries.length ||
      portReceipt.fileByteLength !== fileBytes.byteLength ||
      portReceipt.fileSha256 !== fileSha256
    ) {
      throw new Error("RawEventPort와 journal 저장본의 count/order/hash가 다릅니다.");
    }

    const semanticHash = createHash("sha256");
    for (const entry of this.auditEntries) {
      const bytes = new TextEncoder().encode(canonicalJson(entry));
      const prefix = Buffer.alloc(8);
      prefix.writeBigUInt64BE(BigInt(bytes.byteLength));
      semanticHash.update(prefix);
      semanticHash.update(bytes);
    }
    const sealedAt = this.now().toISOString();
    const receipt = FrozenRawJournalReceiptV1Schema.parse({
      schemaVersion: "1.0",
      runId: this.options.runId,
      firstSeq: this.auditEntries.length === 0 ? null : 1,
      lastSeq: this.auditEntries.length,
      eventCount: this.auditEntries.length,
      orderedEventSha256: sha256Bytes(orderedEventBytes),
      fileByteLength: fileBytes.byteLength,
      fileSha256,
      sealedAt,
    });
    const auditIndex: SealedRawAuditIndex = {
      schemaVersion: "1.0",
      runId: this.options.runId,
      entries: this.auditEntries.map((entry) => ({ ...entry })),
    };
    return {
      fileBytes,
      receipt,
      auditIndex,
      redactionPlan: this.redactionPlan,
      redactionPlanSha256: sha256Canonical(this.redactionPlan),
      semanticProjectionSha256: semanticHash.digest("hex"),
    };
  }
}
