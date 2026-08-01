import { tool } from "@openai/agents";
import { z } from "zod";

import { sha256Canonical } from "./canonical-json.js";

import {
  GoogleCandidateSchema,
  GoogleExploreBatchSchema,
  GoogleExploreConfigSchema,
  GoogleSignalCollectionResultSchema,
  XSignalBatchSchema,
  XSignalCollectionResultSchema,
  type ObservationAcquisitionReceipt,
} from "./content-domain.js";
import {
  validateObservationAcquisitionReceipt,
  type GoogleSignalCollectionPort,
  type XSignalCollectionPort,
} from "./signal-provider-ports.js";

type AcquisitionKind = "x" | "google_trends";

export type StoredAcquisitionReceipt = {
  kind: AcquisitionKind;
  receipt: ObservationAcquisitionReceipt;
  outputSha256: string;
  output: unknown;
};

/**
 * The model never receives acquisition proof. The proof remains bound to the
 * SDK call id in this process-private store until the provenance validator
 * consumes it.
 */
export class AcquisitionReceiptStore {
  private readonly receipts = new Map<string, StoredAcquisitionReceipt>();

  record(
    callId: string,
    kind: AcquisitionKind,
    receiptInput: ObservationAcquisitionReceipt,
    output: unknown,
  ): void {
    if (!callId || this.receipts.has(callId)) {
      throw new Error("acquisition receipt에는 고유한 SDK callId가 필요합니다.");
    }
    const receipt = validateObservationAcquisitionReceipt(receiptInput);
    this.receipts.set(
      callId,
      structuredClone({
        kind,
        receipt,
        outputSha256: sha256Canonical(output),
        output,
      }) as StoredAcquisitionReceipt,
    );
  }

  list(kind: AcquisitionKind): Array<StoredAcquisitionReceipt & { callId: string }> {
    return [...this.receipts.entries()].flatMap(([callId, value]) =>
      value.kind === kind ? [{ callId, ...structuredClone(value) }] : [],
    );
  }

  get(callId: string): StoredAcquisitionReceipt | undefined {
    const value = this.receipts.get(callId);
    return value ? structuredClone(value) : undefined;
  }

  take(callId: string): StoredAcquisitionReceipt | undefined {
    const value = this.get(callId);
    if (value) this.receipts.delete(callId);
    return value;
  }
}

const SearchXParametersSchema = z.strictObject({
  queries: z.array(z.string().trim().min(1)).min(1).max(3),
  limit: z.number().int().min(1).max(10),
});

const EvaluateGoogleParametersSchema = z.strictObject({
  candidates: z.array(GoogleCandidateSchema).min(4).max(5),
  config: GoogleExploreConfigSchema,
});

// GoogleExploreBatch contains z.base64(), which the pinned Agents SDK maps to
// JSON Schema `contentEncoding`; strict Structured Outputs rejects that
// keyword. Keep the authoritative runtime parse above and expose one strict,
// lossless JSON-string projection at the SDK boundary.
export const GoogleExploreBatchSdkOutputSchema = z.strictObject({
  batchJson: z.string().min(2),
});

export const XSignalBatchSdkOutputSchema = z.strictObject({
  batchJson: z.string().min(2),
});

export function decodeXSignalBatchSdkOutput(input: unknown) {
  const projection = XSignalBatchSdkOutputSchema.parse(input);
  return XSignalBatchSchema.parse(JSON.parse(projection.batchJson));
}

export function decodeGoogleExploreBatchSdkOutput(input: unknown) {
  const projection = GoogleExploreBatchSdkOutputSchema.parse(input);
  return GoogleExploreBatchSchema.parse(JSON.parse(projection.batchJson));
}

export type SignalAgentToolOptions = {
  runId: string;
  x: XSignalCollectionPort;
  googleTrends: GoogleSignalCollectionPort;
  receipts: AcquisitionReceiptStore;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function invocationSignal(
  configured: AbortSignal | undefined,
  sdk: AbortSignal | undefined,
): AbortSignal | undefined {
  if (configured && sdk) return AbortSignal.any([configured, sdk]);
  return configured ?? sdk;
}

function requiredCallId(details: { toolCall?: { callId?: string } } | undefined): string {
  const callId = details?.toolCall?.callId;
  if (!callId) {
    throw new Error("Agents SDK ToolCallDetails.toolCall.callId가 필요합니다.");
  }
  return callId;
}

export function createSignalAgentTools(options: SignalAgentToolOptions) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const searchX = tool({
    name: "search_x_with_playwright",
    description:
      "현재 X 화면에서 여행 주제 후보용 신호를 수집한다. 게시물 문구는 사실 근거가 아니다.",
    parameters: SearchXParametersSchema,
    outputSchema: XSignalBatchSchema,
    strict: true,
    timeoutMs,
    timeoutBehavior: "raise_exception",
    errorFunction: null,
    execute: async (input, _context, details) => {
      const callId = requiredCallId(details);
      const result = XSignalCollectionResultSchema.parse(
        await options.x.collect({
          runId: options.runId,
          parentToolCallId: callId,
          queries: input.queries,
          limit: input.limit,
          signal: invocationSignal(options.signal, details?.signal),
        }),
      );
      options.receipts.record(callId, "x", result.acquisition, result.batch);
      return result.batch;
    },
  });

  const evaluateGoogle = tool({
    name: "evaluate_google_trends_with_playwright",
    description:
      "X에서 얻은 4~5개 후보를 동일한 Google Trends Explore 조건으로 관찰한다.",
    parameters: EvaluateGoogleParametersSchema,
    outputSchema: GoogleExploreBatchSdkOutputSchema,
    strict: true,
    timeoutMs,
    timeoutBehavior: "raise_exception",
    errorFunction: null,
    execute: async (input, _context, details) => {
      const callId = requiredCallId(details);
      const result = GoogleSignalCollectionResultSchema.parse(
        await options.googleTrends.collect({
          runId: options.runId,
          parentToolCallId: callId,
          candidates: input.candidates,
          config: input.config,
          signal: invocationSignal(options.signal, details?.signal),
        }),
      );
      options.receipts.record(
        callId,
        "google_trends",
        result.acquisition,
        result.batch,
      );
      return { batchJson: JSON.stringify(result.batch) };
    },
  });

  return { searchX, evaluateGoogle, tools: [searchX, evaluateGoogle] as const };
}
