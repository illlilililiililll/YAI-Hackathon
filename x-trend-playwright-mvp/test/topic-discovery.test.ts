import { describe, expect, it } from "vitest";

import { clusterTopicCandidates, expandTravelQueries, normalizeSeedKeyword, requireViableCandidates } from "../src/topic-discovery.js";
import type { XSignalBatch } from "../src/content-domain.js";

const batch: XSignalBatch = {
  plannedQueries: ["여행", "여행 추천"],
  observations: [
    { query: "여행", status: "ok", signals: [], attemptedAt: "2026-08-02T00:00:00.000Z", warningCode: null },
    { query: "여행 추천", status: "ok", signals: [], attemptedAt: "2026-08-02T00:00:01.000Z", warningCode: null },
  ],
  dedupedSignals: [
    { signalId: "signal_1", authorLabel: "a", authorKey: "a", text: "#제주도 #부산 #경주 #강릉 여행", canonicalUrl: "https://x.com/a/status/1", visibleTimestamp: null, matchedQueries: ["여행"], collectedAt: "2026-08-02T00:00:00.000Z" },
    { signalId: "signal_2", authorLabel: "b", authorKey: "b", text: "제주도 부산 경주 강릉 추천", canonicalUrl: "https://x.com/b/status/2", visibleTimestamp: null, matchedQueries: ["여행 추천"], collectedAt: "2026-08-02T00:00:01.000Z" },
  ],
  coverageRatio: 1,
};

describe("topic discovery", () => {
  it("정규화한 입력으로 유한한 검색어를 만든다", () => {
    expect(normalizeSeedKeyword("  여\u006D\u006D행  ")).toBe("여mm행");
    expect(expandTravelQueries(" 여행 ", 2)).toEqual(["여행", "여행 추천"]);
  });

  it("X 원문에 실제 등장한 후보만 만들고 4개 미만을 거절한다", () => {
    const candidates = clusterTopicCandidates(batch, "여행", "fixture");
    expect(candidates.map((candidate) => candidate.label)).toEqual(
      expect.arrayContaining(["제주도", "부산", "경주", "강릉"]),
    );
    expect(requireViableCandidates(candidates)).toHaveLength(4);
    expect(() => requireViableCandidates(candidates.slice(0, 3))).toThrow("no_viable_topic");
  });
});
