import {
  GoogleSignalCollectionResultSchema,
  ObservationAcquisitionReceiptSchema,
  SignalProviderSchema,
  XSignalCollectionResultSchema,
  type GoogleSignalCollectionResult,
  type ObservationAcquisitionReceipt,
  type SignalProvider,
  type XSignalCollectionResult,
} from "./content-domain.js";
import { sha256Canonical } from "./canonical-json.js";
import {
  validateGoogleExploreBatch,
  type CollectGoogleTrendsInput,
} from "./google-trends-observation-port.js";

export type CollectXSignalsInput = {
  runId: string;
  parentToolCallId: string;
  queries: string[];
  limit?: number;
  signal?: AbortSignal;
};

export interface XSignalCollectionPort {
  readonly provider: SignalProvider;
  collect(input: CollectXSignalsInput): Promise<XSignalCollectionResult>;
}

export interface GoogleSignalCollectionPort {
  readonly provider: SignalProvider;
  collect(input: CollectGoogleTrendsInput): Promise<GoogleSignalCollectionResult>;
}

export class UnsupportedSignalProviderError extends Error {
  readonly code = "unsupported_provider" as const;
  readonly retryable = false;

  constructor(
    readonly signal: "x" | "google_trends",
    readonly provider: string,
  ) {
    super(`${signal} provider '${provider}'가 등록되어 있지 않습니다.`);
    this.name = "UnsupportedSignalProviderError";
  }
}

function providerName(value: unknown): string {
  const candidate = value === undefined ? "playwright" : value;
  const parsed = SignalProviderSchema.safeParse(candidate);
  if (!parsed.success) {
    return typeof candidate === "string" ? candidate : String(candidate);
  }
  return parsed.data;
}

export class SignalProviderContractError extends Error {
  readonly code = "contract_violation" as const;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "SignalProviderContractError";
  }
}

/**
 * This slice proves adapter-local acquisition integrity only. Until branded
 * live MCP capability, complete download evidence, and deterministic
 * extractor replay are implemented, no caller may promote it to live
 * ObservationProvenance or a success/ready terminal.
 */
export const SIGNAL_ACQUISITION_LIVE_PROVENANCE_READY = false as const;

export function assertSignalAcquisitionMayBecomeLiveProvenance(): never {
  throw new SignalProviderContractError(
    "Signal acquisition은 아직 live provenance로 승격할 수 없습니다.",
  );
}

export function validateObservationAcquisitionReceipt(
  input: ObservationAcquisitionReceipt,
): ObservationAcquisitionReceipt {
  const receipt = ObservationAcquisitionReceiptSchema.parse(input);
  const expected =
    receipt.adapter === "playwright"
      ? sha256Canonical({
          adapter: receipt.adapter,
          wrapperCausalReceiptSha256: receipt.wrapperCausalReceiptSha256,
          downloadReceiptSha256s: receipt.downloadReceiptSha256s,
        })
      : sha256Canonical({
          adapter: receipt.adapter,
          providerContractVersion: receipt.providerContractVersion,
          providerReceiptSha256: receipt.providerReceiptSha256,
        });
  if (receipt.receiptSha256 !== expected) {
    throw new SignalProviderContractError(
      "Signal provider acquisition receipt hash가 다릅니다.",
    );
  }
  return receipt;
}

export class SignalProviderRegistry {
  private readonly xProviders = new Map<SignalProvider, XSignalCollectionPort>();
  private readonly googleProviders = new Map<
    SignalProvider,
    GoogleSignalCollectionPort
  >();

  registerX(adapter: XSignalCollectionPort): this {
    const provider = SignalProviderSchema.parse(adapter.provider);
    if (this.xProviders.has(provider)) {
      throw new Error(`X provider '${provider}'가 중복 등록되었습니다.`);
    }
    this.xProviders.set(provider, adapter);
    return this;
  }

  registerGoogleTrends(adapter: GoogleSignalCollectionPort): this {
    const provider = SignalProviderSchema.parse(adapter.provider);
    if (this.googleProviders.has(provider)) {
      throw new Error(`Google Trends provider '${provider}'가 중복 등록되었습니다.`);
    }
    this.googleProviders.set(provider, adapter);
    return this;
  }

  resolveX(providerInput: unknown = "playwright"): XSignalCollectionPort {
    const provider = providerName(providerInput);
    const parsed = SignalProviderSchema.safeParse(provider);
    const adapter = parsed.success ? this.xProviders.get(parsed.data) : undefined;
    if (!adapter) {
      throw new UnsupportedSignalProviderError("x", provider);
    }
    return {
      provider: adapter.provider,
      collect: async (input) => {
        const result = XSignalCollectionResultSchema.parse(
          await adapter.collect(input),
        );
        validateObservationAcquisitionReceipt(result.acquisition);
        if (result.acquisition.adapter !== adapter.provider) {
          throw new SignalProviderContractError(
            "X provider와 acquisition receipt variant가 다릅니다.",
          );
        }
        return result;
      },
    };
  }

  resolveGoogleTrends(
    providerInput: unknown = "playwright",
  ): GoogleSignalCollectionPort {
    const provider = providerName(providerInput);
    const parsed = SignalProviderSchema.safeParse(provider);
    const adapter = parsed.success
      ? this.googleProviders.get(parsed.data)
      : undefined;
    if (!adapter) {
      throw new UnsupportedSignalProviderError("google_trends", provider);
    }
    return {
      provider: adapter.provider,
      collect: async (input) => {
        const result = GoogleSignalCollectionResultSchema.parse(
          await adapter.collect(input),
        );
        validateObservationAcquisitionReceipt(result.acquisition);
        if (result.acquisition.adapter !== adapter.provider) {
          throw new SignalProviderContractError(
            "Google Trends provider와 acquisition receipt variant가 다릅니다.",
          );
        }
        return {
          ...result,
          batch: validateGoogleExploreBatch(
            result.batch,
            input.candidates,
            input.config,
          ),
        };
      },
    };
  }
}

export type SignalProviderRuntimeSelection = {
  x?: unknown;
  googleTrends?: unknown;
};

export function createSignalProviderRuntime(
  registry: SignalProviderRegistry,
  selection: SignalProviderRuntimeSelection = {},
): {
  x: XSignalCollectionPort;
  googleTrends: GoogleSignalCollectionPort;
} {
  // Resolve both adapters up front. A bad selection therefore fails before
  // either adapter can connect a browser or make a provider call.
  const x = registry.resolveX(selection.x);
  const googleTrends = registry.resolveGoogleTrends(selection.googleTrends);
  return { x, googleTrends };
}

export function validateXSignalProviderResult(
  result: XSignalCollectionResult,
): XSignalCollectionResult {
  const parsed = XSignalCollectionResultSchema.parse(result);
  validateObservationAcquisitionReceipt(parsed.acquisition);
  return parsed;
}

export function validateGoogleSignalProviderResult(
  result: GoogleSignalCollectionResult,
): GoogleSignalCollectionResult {
  const parsed = GoogleSignalCollectionResultSchema.parse(result);
  validateObservationAcquisitionReceipt(parsed.acquisition);
  return parsed;
}

export function createOfficialApiMcpAcquisitionReceipt(input: {
  providerContractVersion: string;
  providerReceiptSha256: string;
}): ObservationAcquisitionReceipt & { adapter: "official_api_mcp" } {
  const withoutSelf = {
    adapter: "official_api_mcp" as const,
    providerContractVersion: input.providerContractVersion,
    providerReceiptSha256: input.providerReceiptSha256,
  };
  return ObservationAcquisitionReceiptSchema.parse({
    ...withoutSelf,
    receiptSha256: sha256Canonical(withoutSelf),
  }) as ObservationAcquisitionReceipt & { adapter: "official_api_mcp" };
}
