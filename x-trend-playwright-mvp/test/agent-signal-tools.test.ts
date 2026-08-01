import { RunContext } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../src/canonical-json.js";
import {
  AcquisitionReceiptStore,
  createSignalAgentTools,
} from "../src/agent-signal-tools.js";
import type {
  GoogleSignalCollectionPort,
  XSignalCollectionPort,
} from "../src/signal-provider-ports.js";

const HASH = "a".repeat(64);

function acquisitionReceipt() {
  const receipt = {
    adapter: "playwright" as const,
    wrapperCausalReceiptSha256: HASH,
    downloadReceiptSha256s: [] as string[],
  };
  return { ...receipt, receiptSha256: sha256Canonical(receipt) };
}

describe("Agents SDK signal tool wrappers", () => {
  it("requires the SDK tool call id before invoking either provider", async () => {
    const xCollect = vi.fn();
    const googleCollect = vi.fn();
    const tools = createSignalAgentTools({
      runId: "run_00000000-0000-4000-8000-000000000001",
      x: { provider: "playwright", collect: xCollect } as XSignalCollectionPort,
      googleTrends: {
        provider: "playwright",
        collect: googleCollect,
      } as GoogleSignalCollectionPort,
      receipts: new AcquisitionReceiptStore(),
    });

    await expect(
      tools.searchX.invoke(
        new RunContext(),
        JSON.stringify({ queries: ["여행"], limit: 10 }),
      ),
    ).rejects.toThrow(/callId/u);
    await expect(
      tools.evaluateGoogle.invoke(
        new RunContext(),
        JSON.stringify({
          candidates: [
            { candidateId: "c1", label: "a" },
            { candidateId: "c2", label: "b" },
            { candidateId: "c3", label: "c" },
            { candidateId: "c4", label: "d" },
          ],
          config: {
            schemaVersion: "1.0",
            geo: "KR",
            timeRange: "now 7-d",
            searchType: "web",
            category: 0,
            browserTimeZone: "Asia/Seoul",
            uiLanguage: "en",
            comparisonType: "search_terms",
            candidateMax: 5,
            calculationVersion: "google-preemption-v1",
          },
        }),
      ),
    ).rejects.toThrow(/callId/u);
    expect(xCollect).not.toHaveBeenCalled();
    expect(googleCollect).not.toHaveBeenCalled();
  });

  it("returns only the X batch and keeps acquisition proof process-private", async () => {
    const receipt = acquisitionReceipt();
    const xCollect = vi.fn(async () => ({
      batch: {
        plannedQueries: ["여행"],
        observations: [
          {
            query: "여행",
            status: "ok" as const,
            signals: [],
            attemptedAt: "2026-08-02T00:00:00.000Z",
            warningCode: null,
          },
        ],
        dedupedSignals: [],
        coverageRatio: 1,
      },
      acquisition: receipt,
    }));
    const receipts = new AcquisitionReceiptStore();
    const tools = createSignalAgentTools({
      runId: "run_00000000-0000-4000-8000-000000000001",
      x: { provider: "playwright", collect: xCollect },
      googleTrends: {
        provider: "playwright",
        collect: vi.fn(),
      } as unknown as GoogleSignalCollectionPort,
      receipts,
    });

    const output = await tools.searchX.invoke(
      new RunContext(),
      JSON.stringify({ queries: ["여행"], limit: 10 }),
      {
        toolCall: {
          type: "function_call",
          callId: "call_x_1",
          name: "search_x_with_playwright",
          status: "in_progress",
          arguments: "{}",
        },
      },
    );

    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    expect(parsed).toEqual((await xCollect.mock.results[0]?.value).batch);
    expect(JSON.stringify(parsed)).not.toContain("acquisition");
    expect(receipts.get("call_x_1")).toEqual({
      kind: "x",
      receipt,
      outputSha256: sha256Canonical(parsed),
      output: parsed,
    });
    expect(xCollect).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_00000000-0000-4000-8000-000000000001",
        parentToolCallId: "call_x_1",
        queries: ["여행"],
        limit: 10,
      }),
    );
  });
});
