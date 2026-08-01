import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GOOGLE_EXPLORE_CONFIG,
  type GoogleCandidate,
} from "../src/content-domain.js";
import type { McpCallResult } from "../src/google-browser-runtime.js";
import {
  createGoogleTrendsMcpCapture,
  type GoogleMcpServer,
} from "../src/google-trends-mcp-capture.js";
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

function screen(
  exploreUrl: string,
  mode: "top" | "rising",
  bodyState: GoogleRenderedScreen["bodyState"] = "ready",
): GoogleRenderedScreen {
  return {
    schemaVersion: "1.0",
    pageUrl: exploreUrl,
    pageTitle: "Google Trends",
    bodyState,
    partialBoundary: { state: "none" },
    cards:
      bodyState === "ready"
        ? candidates.flatMap((candidate) =>
            (["related_queries", "related_topics"] as const).map((kind) => ({
              candidateLabel: candidate.label,
              kind,
              mode,
              heading:
                kind === "related_queries"
                  ? "Related queries"
                  : "Related topics",
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
          )
        : [],
  };
}

class ToggleServer implements GoogleMcpServer {
  private modeClicks = 0;

  constructor(
    private readonly directory: string,
    private readonly exploreUrl: string,
    private readonly targetCount = 8,
    private readonly bodyState: GoogleRenderedScreen["bodyState"] = "ready",
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<McpCallResult> {
    if (toolName === "browser_evaluate") {
      const mode = this.modeClicks >= 8 ? "rising" : "top";
      return {
        content: [
          {
            type: "text",
            text: `### Result\n${JSON.stringify(
              screen(this.exploreUrl, mode, this.bodyState),
            )}`,
          },
        ],
      };
    }
    if (toolName === "browser_snapshot") {
      if (this.modeClicks < 8) {
        return {
          content: [
            {
              type: "text",
              text: Array.from(
                { length: this.targetCount },
                (_, index) => `- option "Rising" [ref=r${index}]`,
              ).join("\n"),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: '- heading "Interest over time" [ref=i1]\n  - button "Download" [ref=d1]',
          },
        ],
      };
    }
    if (toolName === "browser_click") {
      const target = typeof args?.target === "string" ? args.target : "";
      if (target.startsWith("r")) {
        this.modeClicks += 1;
      }
      if (target === "d1") {
        const rows = Array.from({ length: 8 }, (_, index) => {
          const hour = String(index).padStart(2, "0");
          return `2026-08-01T${hour},${10 + index},${20 + index},${30 + index},${40 + index}`;
        });
        await writeFile(
          path.join(this.directory, "multiTimeline.csv"),
          ["Time,제주 추천,부산 여행,서울 숙소,강릉 교통", ...rows].join(
            "\n",
          ),
          "utf8",
        );
      }
    }
    return { content: [{ type: "text", text: "ok" }] };
  }
}

async function captureWith(
  targetCount: number,
  bodyState: GoogleRenderedScreen["bodyState"] = "ready",
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "google-toggle-test-"));
  directories.push(directory);
  const exploreUrl =
    "https://trends.google.com/trends/explore?hl=en&date=now+7-d&geo=KR&q=a%2Cb%2Cc%2Cd";
  const capture = createGoogleTrendsMcpCapture({
    outputDirectory: directory,
    createServer: () =>
      new ToggleServer(directory, exploreUrl, targetCount, bodyState),
    downloadTimeoutMs: 1_000,
    downloadPollMs: 5,
    downloadStableSamples: 1,
  });
  return capture({
    runId: "run-google-toggle",
    parentToolCallId: "call-google-toggle",
    candidates,
    config: DEFAULT_GOOGLE_EXPLORE_CONFIG,
    exploreUrl,
  });
}

describe("Google Top/Rising mode capture", () => {
  it("explicitly toggles Rising and merges it with Top before scoring", async () => {
    const batch = await captureWith(8);

    expect(batch.status).toBe("complete");
    expect(batch.observations[0]?.relatedQueries.top.state).toBe("available");
    expect(batch.observations[0]?.relatedQueries.rising.state).toBe(
      "available",
    );
  });

  it("preserves selector cardinality drift as unavailable instead of guessing", async () => {
    const batch = await captureWith(7);

    expect(batch.status).toBe("partial");
    expect(batch.observations[0]?.relatedQueries.rising).toEqual({
      state: "unavailable",
      value: null,
      reasonCode: "schema_changed",
    });
    expect(batch.observations[0]?.warningCodes).toContain(
      "google_schema_changed",
    );
  });

  it("preserves HTTP 429 as rate_limited/unavailable and does not bypass it", async () => {
    const batch = await captureWith(0, "rate_limited");

    expect(batch.status).toBe("unavailable");
    expect(batch.observations[0]?.interestOverTime).toEqual({
      state: "unavailable",
      value: null,
      reasonCode: "rate_limited",
    });
  });
});
