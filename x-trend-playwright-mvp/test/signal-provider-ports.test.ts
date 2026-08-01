import { describe, expect, it, vi } from "vitest";

import {
  SignalProviderRegistry,
  UnsupportedSignalProviderError,
  assertSignalAcquisitionMayBecomeLiveProvenance,
  createOfficialApiMcpAcquisitionReceipt,
  createSignalProviderRuntime,
  validateObservationAcquisitionReceipt,
  type GoogleSignalCollectionPort,
  type XSignalCollectionPort,
} from "../src/signal-provider-ports.js";

describe("SignalProviderRegistry", () => {
  it("blocks acquisition-only receipts from live provenance", () => {
    expect(() => assertSignalAcquisitionMayBecomeLiveProvenance()).toThrow(
      "live provenance",
    );
  });

  it("selects Playwright for both signals by default", () => {
    const x = {
      provider: "playwright",
      collect: vi.fn(),
    } as unknown as XSignalCollectionPort;
    const googleTrends = {
      provider: "playwright",
      collect: vi.fn(),
    } as unknown as GoogleSignalCollectionPort;
    const registry = new SignalProviderRegistry()
      .registerX(x)
      .registerGoogleTrends(googleTrends);

    const runtime = createSignalProviderRuntime(registry);
    expect(runtime.x.provider).toBe("playwright");
    expect(runtime.googleTrends.provider).toBe("playwright");
  });

  it("fails before any adapter starts when a provider is unsupported", () => {
    const collect = vi.fn();
    const registry = new SignalProviderRegistry()
      .registerX({
        provider: "playwright",
        collect,
      } as unknown as XSignalCollectionPort)
      .registerGoogleTrends({
        provider: "playwright",
        collect,
      } as unknown as GoogleSignalCollectionPort);

    expect(() =>
      createSignalProviderRuntime(registry, {
        x: "official_api_mcp",
      }),
    ).toThrow(UnsupportedSignalProviderError);
    expect(collect).not.toHaveBeenCalled();
  });

  it("does not treat an explicit null provider as omission", () => {
    const registry = new SignalProviderRegistry()
      .registerX({
        provider: "playwright",
        collect: vi.fn(),
      } as unknown as XSignalCollectionPort)
      .registerGoogleTrends({
        provider: "playwright",
        collect: vi.fn(),
      } as unknown as GoogleSignalCollectionPort);

    expect(() => createSignalProviderRuntime(registry, { x: null })).toThrow(
      UnsupportedSignalProviderError,
    );
  });

  it("keeps official API/MCP proof in a distinct receipt variant", () => {
    const receipt = createOfficialApiMcpAcquisitionReceipt({
      providerContractVersion: "x-official-v1",
      providerReceiptSha256: "a".repeat(64),
    });

    expect(receipt).toMatchObject({
      adapter: "official_api_mcp",
      providerContractVersion: "x-official-v1",
    });
    expect(receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt).not.toHaveProperty("wrapperCausalReceiptSha256");
    expect(() =>
      validateObservationAcquisitionReceipt({
        ...receipt,
        providerReceiptSha256: "b".repeat(64),
      }),
    ).toThrow("receipt hash");
  });
});
