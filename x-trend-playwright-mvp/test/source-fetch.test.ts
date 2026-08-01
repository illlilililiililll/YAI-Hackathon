import { describe, expect, it, vi } from "vitest";

import type { SourceDiscoveryRefV1 } from "../src/content-domain.js";
import {
  fetchSourcePage,
  isPublicGlobalAddress,
  type PinnedSourceTransport,
  type PinnedTransportResponse,
  type SourceHostResolver,
} from "../src/source-fetch.js";

function discovery(url: string): SourceDiscoveryRefV1 {
  return {
    webSearchCallId: "ws_1",
    rawEventSeq: 1,
    semanticPayloadSha256: "a".repeat(64),
    candidateUrl: url,
  };
}

const publicResolver: SourceHostResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

function queuedTransport(
  responses: PinnedTransportResponse[],
): PinnedSourceTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("response queue empty");
    }
    return response;
  });
  return { request };
}

describe("SSRF-safe Source fetch boundary", () => {
  it("fetches one pinned public HTTPS HTML response and extracts blocks", async () => {
    const transport = queuedTransport([
      {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
        body: Buffer.from("<title>Official</title><p>2026-08-02 운영</p>"),
        remoteAddress: "93.184.216.34",
      },
    ]);
    const result = await fetchSourcePage({
      discovery: discovery("https://official.example/guide"),
      fetchToolCallId: "fetch_1",
      resolver: publicResolver,
      transport,
      provenanceMode: "mock",
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(result.finalUrl).toBe("https://official.example/guide");
    expect(result.blocks.map((block) => block.text)).toEqual([
      "Official",
      "2026-08-02 운영",
    ]);
    expect(result.provenanceMode).toBe("mock");
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "official.example",
        approvedAddresses: [{ address: "93.184.216.34", family: 4 }],
      }),
    );
  });

  it("blocks localhost, metadata/private IP, credential query and DNS rebinding", async () => {
    const transport = queuedTransport([]);
    await expect(
      fetchSourcePage({
        discovery: discovery("https://localhost/page"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "non_public_ip" });

    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/?access_token=secret"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "redirect_policy" });

    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_1",
        resolver: async () => [{ address: "169.254.169.254", family: 4 }],
        transport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "non_public_ip" });

    const reboundTransport = queuedTransport([
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<title>Official</title>"),
        remoteAddress: "8.8.8.8",
      },
    ]);
    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport: reboundTransport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "non_public_ip" });
  });

  it("revalidates redirects and enforces content type, body size and timeout", async () => {
    const redirectTransport = queuedTransport([
      {
        status: 302,
        headers: { location: "https://other.example/page" },
        body: new Uint8Array(),
        remoteAddress: "93.184.216.34",
      },
    ]);
    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport: redirectTransport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "redirect_policy" });

    const malformedRedirectTransport = queuedTransport([
      {
        status: 302,
        headers: { location: "https://[invalid" },
        body: new Uint8Array(),
        remoteAddress: "93.184.216.34",
      },
    ]);
    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_invalid_redirect",
        resolver: publicResolver,
        transport: malformedRedirectTransport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "redirect_policy" });

    const nonHtmlTransport = queuedTransport([
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
        remoteAddress: "93.184.216.34",
      },
    ]);
    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport: nonHtmlTransport,
        provenanceMode: "mock",
      }),
    ).rejects.toMatchObject({ code: "content_type" });

    const oversizedTransport = queuedTransport([
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<p>too large</p>"),
        remoteAddress: "93.184.216.34",
      },
    ]);
    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport: oversizedTransport,
        provenanceMode: "mock",
        maxBodyBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "body_too_large" });

    const hangingTransport: PinnedSourceTransport = {
      request: async () => new Promise(() => undefined),
    };
    await expect(
      fetchSourcePage({
        discovery: discovery("https://official.example/page"),
        fetchToolCallId: "fetch_1",
        resolver: publicResolver,
        transport: hangingTransport,
        provenanceMode: "mock",
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies representative non-public address families", () => {
    expect(isPublicGlobalAddress("8.8.8.8")).toBe(true);
    expect(isPublicGlobalAddress("10.0.0.1")).toBe(false);
    expect(isPublicGlobalAddress("100.64.0.1")).toBe(false);
    expect(isPublicGlobalAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicGlobalAddress("::1")).toBe(false);
    expect(isPublicGlobalAddress("fc00::1")).toBe(false);
    expect(isPublicGlobalAddress("2001:db8::1")).toBe(false);
    expect(isPublicGlobalAddress("2001:0db8::1")).toBe(false);
  });
});
