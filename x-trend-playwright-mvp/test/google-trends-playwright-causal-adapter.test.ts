import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserRuntime,
  type BrowserMcpServer,
} from "../src/browser-runtime.js";
import {
  DEFAULT_GOOGLE_EXPLORE_CONFIG,
  type GoogleCandidate,
} from "../src/content-domain.js";
import { CausalPlaywrightGoogleTrendsAdapter } from "../src/google-trends-playwright-adapter.js";
import type { GoogleRenderedScreen } from "../src/google-trends-screen-extractor-v1.js";

const directories: string[] = [];
const candidates: GoogleCandidate[] = [
  { candidateId: "c1", label: "제주 추천" },
  { candidateId: "c2", label: "부산 여행" },
  { candidateId: "c3", label: "서울 숙소" },
  { candidateId: "c4", label: "강릉 교통" },
];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function completeScreen(exploreUrl: string): GoogleRenderedScreen {
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
          heading:
            kind === "related_queries" ? "Related queries" : "Related topics",
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

class FakeCausalGoogleServer implements BrowserMcpServer {
  constructor(
    private readonly outputDirectory: string,
    private readonly exploreUrl: string,
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<unknown> {
    if (toolName === "browser_evaluate") {
      return {
        content: [
          {
            type: "text",
            text: `### Result\n${JSON.stringify(completeScreen(this.exploreUrl))}`,
          },
        ],
      };
    }
    if (toolName === "browser_snapshot") {
      return {
        content: [
          {
            type: "text",
            text: '- heading "Interest over time" [ref=i1]\n  - button "Download" [ref=d1]',
          },
        ],
      };
    }
    if (toolName === "browser_click" && args?.target === "d1") {
      const rows = Array.from({ length: 8 }, (_, index) => {
        const hour = String(index).padStart(2, "0");
        return `2026-08-01T${hour},${10 + index},${20 + index},${30 + index},${40 + index}`;
      });
      await writeFile(
        path.join(this.outputDirectory, "multiTimeline.csv"),
        ["Time,제주 추천,부산 여행,서울 숙소,강릉 교통", ...rows].join(
          "\n",
        ),
        "utf8",
      );
    }
    return { content: [{ type: "text", text: "ok" }] };
  }
}

describe("CausalPlaywrightGoogleTrendsAdapter", () => {
  it("returns the provider-neutral batch with a bound Playwright acquisition receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "google-causal-adapter-"));
    directories.push(root);
    const exploreUrl =
      "https://trends.google.com/trends/explore?hl=en&date=now+7-d&geo=KR&cat=0&q=%EC%A0%9C%EC%A3%BC+%EC%B6%94%EC%B2%9C%2C%EB%B6%80%EC%82%B0+%EC%97%AC%ED%96%89%2C%EC%84%9C%EC%9A%B8+%EC%88%99%EC%86%8C%2C%EA%B0%95%EB%A6%89+%EA%B5%90%ED%86%B5";
    const outputDirectoryForLease = (leaseId: string) =>
      path.join(root, "downloads", leaseId);
    const runtime = new BrowserRuntime({
      profiles: {
        x: path.join(root, "x"),
        google_trends: path.join(root, "google"),
      },
      createServer: async ({ leaseId }) => {
        const outputDirectory = outputDirectoryForLease(leaseId);
        await mkdir(outputDirectory, { recursive: true });
        return new FakeCausalGoogleServer(outputDirectory, exploreUrl);
      },
    });
    const adapter = new CausalPlaywrightGoogleTrendsAdapter({
      runtime,
      outputDirectoryForLease,
      downloadTimeoutMs: 1_000,
      downloadPollMs: 5,
      downloadStableSamples: 1,
    });

    const result = await adapter.collect({
      runId: "run-google-causal",
      parentToolCallId: "call-google-causal",
      candidates,
      config: DEFAULT_GOOGLE_EXPLORE_CONFIG,
    });

    expect(result.batch.status).toBe("complete");
    expect(result.acquisition.adapter).toBe("playwright");
    if (result.acquisition.adapter !== "playwright") {
      throw new Error("Playwright acquisition receipt가 아닙니다.");
    }
    expect(result.acquisition.downloadReceiptSha256s).toHaveLength(1);
    const csv = result.batch.rawArtifacts[1];
    expect(csv?.kind).toBe("interest_over_time_csv");
    expect(
      csv?.kind === "interest_over_time_csv"
        ? csv.downloadReceiptSha256
        : null,
    ).toBe(result.acquisition.downloadReceiptSha256s[0]);
  });
});
