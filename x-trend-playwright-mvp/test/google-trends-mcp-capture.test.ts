import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GOOGLE_EXPLORE_CONFIG,
  type GoogleCandidate,
} from "../src/content-domain.js";
import type {
  GoogleBrowserOperation,
  GoogleCsvDownloadReceipt,
  McpCallResult,
} from "../src/google-browser-runtime.js";
import {
  createGoogleTrendsMcpCapture,
  type GoogleMcpServer,
} from "../src/google-trends-mcp-capture.js";
import { evaluateGooglePreemptionStage } from "../src/google-preemption-stage.js";
import type { GoogleRenderedScreen } from "../src/google-trends-screen-extractor-v1.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true });
  }
});

const candidates: GoogleCandidate[] = [
  { candidateId: "c1", label: "제주 추천" },
  { candidateId: "c2", label: "부산 여행" },
  { candidateId: "c3", label: "서울 숙소" },
  { candidateId: "c4", label: "강릉 교통" },
];

function renderedScreen(exploreUrl: string): GoogleRenderedScreen {
  return {
    schemaVersion: "1.0",
    pageUrl: exploreUrl,
    pageTitle: "Google Trends",
    bodyState: "ready",
    partialBoundary: { state: "none" },
    cards: candidates.flatMap((candidate) =>
      (["related_queries", "related_topics"] as const).flatMap((kind) =>
        (["top", "rising"] as const).map((mode) => ({
          candidateLabel: candidate.label,
          kind,
          mode,
          heading: kind === "related_queries" ? "Related queries" : "Related topics",
          rows: [
            {
              label: `${candidate.label} ${mode}`,
              displayedValue:
                kind === "related_queries" && mode === "rising"
                  ? "+250%"
                  : "100",
              secondaryText: kind === "related_topics" ? "Topic" : null,
            },
          ],
        })),
      ),
    ),
  };
}

class FakeGoogleMcpServer implements GoogleMcpServer {
  constructor(
    private readonly directory: string,
    private readonly screen: GoogleRenderedScreen,
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async callToolResult(
    toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<McpCallResult> {
    if (toolName === "browser_evaluate") {
      return {
        content: [
          { type: "text", text: `### Result\n${JSON.stringify(this.screen)}` },
        ],
      };
    }
    if (toolName === "browser_snapshot") {
      return {
        content: [
          {
            type: "text",
            text: '### Snapshot\n- heading "Interest over time" [ref=e1]\n  - button "Download" [ref=e2]',
          },
        ],
      };
    }
    if (toolName === "browser_click") {
      const rows = Array.from({ length: 8 }, (_, index) => {
        const hour = String(index).padStart(2, "0");
        return `2026-08-01T${hour},${10 + index},${20 + index},${30 + index},${40 + index}`;
      });
      await writeFile(
        path.join(this.directory, "multiTimeline.csv"),
        ["Time,제주 추천,부산 여행,서울 숙소,강릉 교통", ...rows].join("\n"),
        "utf8",
      );
    }
    return { content: [{ type: "text", text: "ok" }] };
  }
}

describe("Google Trends MCP capture", () => {
  it("binds screen rows and the clicked CSV into one validated batch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "google-capture-test-"));
    directories.push(directory);
    const exploreUrl =
      "https://trends.google.com/trends/explore?hl=en&date=now+7-d&geo=KR&q=a%2Cb%2Cc%2Cd";
    const screen = renderedScreen(exploreUrl);
    const operations: GoogleBrowserOperation[] = [];
    const receipts: GoogleCsvDownloadReceipt[] = [];
    const capture = createGoogleTrendsMcpCapture({
      outputDirectory: directory,
      createServer: () => new FakeGoogleMcpServer(directory, screen),
      onOperation: (operation) => operations.push(operation),
      onDownloadReceipt: (receipt) => receipts.push(receipt),
      downloadTimeoutMs: 1_000,
      downloadPollMs: 5,
      downloadStableSamples: 1,
    });

    const batch = await capture({
      runId: "run-google-1",
      parentToolCallId: "call-google-1",
      candidates,
      config: DEFAULT_GOOGLE_EXPLORE_CONFIG,
      exploreUrl,
    });

    expect(batch.status).toBe("complete");
    expect(batch.rawArtifacts.map((artifact) => artifact.kind)).toEqual([
      "screen_extraction",
      "interest_over_time_csv",
    ]);
    expect(batch.observations[0]?.interestOverTime.state).toBe("available");
    expect(
      batch.observations[0]?.interestOverTime.state === "available"
        ? batch.observations[0].interestOverTime.value[0]
        : null,
    ).toMatchObject({ value: 10, isPartial: false });
    expect(operations.map((operation) => operation.toolName)).toEqual([
      "browser_navigate",
      "browser_wait_for",
      "browser_evaluate",
      "browser_snapshot",
      "browser_click",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.parentToolCallId).toBe("call-google-1");

    const evaluated = evaluateGooglePreemptionStage(batch);
    expect(
      evaluated.evaluations.every(
        (evaluation) => evaluation.scoreStatus === "complete",
      ),
    ).toBe(true);
    expect(evaluated.selectorInput.selectionMode).toBe("google_scored");
    expect(JSON.stringify(evaluated.selectorInput)).not.toMatch(
      /rawArtifact|relatedQueries|interestOverTime/u,
    );
  });
});
