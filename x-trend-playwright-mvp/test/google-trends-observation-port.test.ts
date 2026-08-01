import { describe, expect, it } from "vitest";

import {
  DEFAULT_GOOGLE_EXPLORE_CONFIG,
  type GoogleExploreBatch,
} from "../src/content-domain.js";
import {
  buildGoogleExploreUrl,
  validateGoogleExploreBatch,
} from "../src/google-trends-observation-port.js";

const candidates = ["제주 일정", "부산 숙소", "교토 교통", "오사카 비용"].map(
  (label, index) => ({ candidateId: `candidate-${index + 1}`, label }),
);
const hash = "a".repeat(64);

function unavailableBatch(): GoogleExploreBatch {
  const artifact = {
    artifactId: "google-artifact-screen",
    kind: "screen_extraction" as const,
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    exploreUrl: buildGoogleExploreUrl(candidates, DEFAULT_GOOGLE_EXPLORE_CONFIG),
    collectedAt: "2026-08-01T00:00:00.000Z",
    configSha256: hash,
    extraction: { cards: [] },
    sha256: hash,
    extractorReceiptSha256: hash,
  };
  const capture = {
    state: "unavailable" as const,
    value: null,
    reasonCode: "timeout" as const,
  };
  return {
    config: DEFAULT_GOOGLE_EXPLORE_CONFIG,
    requestedCandidates: candidates,
    observations: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      query: candidate.label,
      exploreUrl: artifact.exploreUrl,
      checkedAt: "2026-08-01T00:00:00.000Z",
      relatedQueries: { top: capture, rising: capture },
      relatedTopics: { top: capture, rising: capture },
      interestOverTime: capture,
      rawArtifactRefs: [
        {
          artifactId: artifact.artifactId,
          jsonPointer: "/rawArtifacts/0",
          sha256: artifact.sha256,
        },
      ],
      warningCodes: ["timeout"],
    })),
    rawArtifacts: [artifact],
    status: "unavailable",
  };
}

describe("GoogleTrendsObservationPort contracts", () => {
  it("builds one KR/7-day comparison URL for the ordered candidates", () => {
    const url = new URL(
      buildGoogleExploreUrl(candidates, DEFAULT_GOOGLE_EXPLORE_CONFIG),
    );
    expect(url.origin).toBe("https://trends.google.com");
    expect(url.searchParams.get("geo")).toBe("KR");
    expect(url.searchParams.get("date")).toBe("now 7-d");
    expect(url.searchParams.get("q")).toBe(candidates.map((item) => item.label).join(","));
  });

  it("accepts unavailable only when raw refs and candidate order remain causal", () => {
    expect(
      validateGoogleExploreBatch(
        unavailableBatch(),
        candidates,
        DEFAULT_GOOGLE_EXPLORE_CONFIG,
      ).status,
    ).toBe("unavailable");
  });

  it("rejects observations reordered independently from the request", () => {
    const batch = unavailableBatch();
    batch.observations = [...batch.observations].reverse();
    expect(() =>
      validateGoogleExploreBatch(
        batch,
        candidates,
        DEFAULT_GOOGLE_EXPLORE_CONFIG,
      ),
    ).toThrow("observation 순서");
  });
});
