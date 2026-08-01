import { describe, expect, it } from "vitest";

import type { GoogleExploreObservation } from "../src/content-domain.js";
import { scoreGooglePreemption } from "../src/google-preemption-scorer-v1.js";

function interestPoints(value: number) {
  return Array.from({ length: 7 }, (_, index) => ({
    observedAt: `2026-08-01T0${index}:00:00.000Z`,
    value,
    isPartial: false,
  }));
}

function observation(
  overrides: Partial<GoogleExploreObservation> = {},
): GoogleExploreObservation {
  return {
    candidateId: "candidate-1",
    query: "제주 일정",
    exploreUrl:
      "https://trends.google.com/trends/explore?geo=KR&date=now%207-d&q=%EC%A0%9C%EC%A3%BC",
    checkedAt: "2026-08-01T07:00:00.000Z",
    relatedQueries: {
      top: { state: "available", value: [] },
      rising: {
        state: "available",
        value: [
          {
            label: "제주 일정 추천",
            rank: 1,
            displayedValue: "Breakout",
            risingValue: {
              kind: "breakout",
              lowerBoundExclusivePercent: 5000,
              rawText: "Breakout",
            },
          },
        ],
      },
    },
    relatedTopics: {
      top: {
        state: "available",
        value: [
          { label: "제주도", topicType: "Island", rank: 1, displayedValue: "100" },
        ],
      },
      rising: {
        state: "available",
        value: [
          { label: "렌터카", topicType: null, rank: 1, displayedValue: "+200%" },
        ],
      },
    },
    interestOverTime: { state: "available", value: interestPoints(50) },
    rawArtifactRefs: [],
    warningCodes: [],
    ...overrides,
  };
}

describe("scoreGooglePreemption", () => {
  it("calculates the signed fixed-point score without LLM arithmetic", () => {
    const result = scoreGooglePreemption({ observation: observation() });

    expect(result.rising.basisPoints).toBe(10_000);
    expect(result.trend.basisPoints).toBe(5_000);
    expect(result.cluster.basisPoints).toBe(4_000);
    expect(result.intent.basisPoints).toBe(10_000);
    expect(result.calculationReceipt.scoreBasisPoints).toBe(450);
    expect(result.preemptionScore).toBe(0.045);
    expect(result.scoreStatus).toBe("complete");
  });

  it("uses 0.3 only for observed Top-only queries", () => {
    const base = observation();
    const result = scoreGooglePreemption({
      observation: {
        ...base,
        relatedQueries: {
          rising: { state: "available", value: [] },
          top: {
            state: "available",
            value: [
              {
                label: "제주 여행",
                rank: 1,
                displayedValue: "100",
                risingValue: null,
              },
            ],
          },
        },
      },
    });

    expect(result.rising.basisPoints).toBe(3_000);
    expect(result.risingRaw).toEqual({ source: "top_only", topDisplayedCount: 1 });
  });

  it("keeps unavailable Google data null and marks the evaluation unavailable", () => {
    const unavailable = { state: "unavailable" as const, value: null, reasonCode: "timeout" as const };
    const result = scoreGooglePreemption({
      observation: observation({
        relatedQueries: { top: unavailable, rising: unavailable },
        relatedTopics: { top: unavailable, rising: unavailable },
        interestOverTime: unavailable,
      }),
    });

    expect(result.rising.basisPoints).toBeNull();
    expect(result.trend.basisPoints).toBeNull();
    expect(result.cluster.basisPoints).toBeNull();
    expect(result.preemptionScore).toBeNull();
    expect(result.scoreStatus).toBe("unavailable");
  });

  it("requires a closed-schema decision only for ambiguous intent", () => {
    const result = scoreGooglePreemption({
      observation: observation({ query: "Kyoto hidden gems" }),
    });

    expect(result.intent.basisPoints).toBeNull();
    expect(result.intent.reasonCode).toBe("intent_llm_required");
    expect(result.scoreStatus).toBe("partial");
    expect(result.preemptionScore).toBeNull();
  });
});
