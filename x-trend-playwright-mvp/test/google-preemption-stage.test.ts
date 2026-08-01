import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../src/canonical-json.js";
import {
  DEFAULT_GOOGLE_EXPLORE_CONFIG,
  type GoogleCandidate,
  type GoogleExploreBatch,
} from "../src/content-domain.js";
import { evaluateGooglePreemptionStage } from "../src/google-preemption-stage.js";
import { assembleContentBrief } from "../src/keyword-selector.js";

const candidates: GoogleCandidate[] = [
  { candidateId: "c1", label: "Tokyo travel" },
  { candidateId: "c2", label: "Osaka travel" },
  { candidateId: "c3", label: "Kyoto travel" },
  { candidateId: "c4", label: "Fukuoka travel" },
];

function unavailableBatch(): GoogleExploreBatch {
  const extraction = {
    schemaVersion: "1.0",
    pageUrl: "https://trends.google.com/trends/explore",
    bodyState: "rate_limited",
  };
  const artifactId = "google-screen-rate-limited";
  const artifactSha256 = sha256Canonical(extraction);
  const capture = {
    state: "unavailable" as const,
    value: null,
    reasonCode: "rate_limited" as const,
  };
  const exploreUrl =
    "https://trends.google.com/trends/explore?hl=en&date=now+7-d&geo=KR&q=a%2Cb%2Cc%2Cd";
  return {
    config: DEFAULT_GOOGLE_EXPLORE_CONFIG,
    requestedCandidates: candidates,
    observations: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      query: candidate.label,
      exploreUrl,
      checkedAt: "2026-08-01T12:00:00.000Z",
      relatedQueries: { top: capture, rising: capture },
      relatedTopics: { top: capture, rising: capture },
      interestOverTime: capture,
      rawArtifactRefs: [
        {
          artifactId,
          jsonPointer: "/rawArtifacts/0",
          sha256: artifactSha256,
        },
      ],
      warningCodes: ["google_rate_limited"],
    })),
    rawArtifacts: [
      {
        artifactId,
        kind: "screen_extraction",
        candidateIds: candidates.map((candidate) => candidate.candidateId),
        exploreUrl,
        collectedAt: "2026-08-01T12:00:00.000Z",
        configSha256: sha256Canonical(DEFAULT_GOOGLE_EXPLORE_CONFIG),
        extraction,
        sha256: artifactSha256,
        extractorReceiptSha256: sha256Canonical({ extraction: artifactSha256 }),
      },
    ],
    status: "unavailable",
  };
}

describe("Google preemption stage", () => {
  it("falls back to X ordering when every Google component is unavailable", () => {
    const stage = evaluateGooglePreemptionStage(unavailableBatch());

    expect(stage.evaluations.every((value) => value.scoreStatus === "unavailable")).toBe(
      true,
    );
    expect(stage.selectorInput).toMatchObject({
      selectionMode: "x_fallback_degraded",
      warningCodes: ["google_explore_all_unavailable"],
    });
    expect(stage.selectorInput.candidates.map((candidate) => candidate.xRank)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("keeps Google raw data and scores out of the Writer-facing ContentBrief", () => {
    const stage = evaluateGooglePreemptionStage(unavailableBatch());
    const brief = assembleContentBrief(
      {
        targetCandidateId: "c1",
        secondaryCandidateIds: ["c2", "c3", "c4"],
        selectionMode: "x_fallback_degraded",
        semanticCohesion: "coherent",
        coverage: "focused",
        articleIntent: "itinerary",
        duplicateIntentCandidateIds: [],
        warningCodes: ["google_explore_all_unavailable"],
      },
      stage.selectorInput,
    );

    expect(brief).toEqual({
      schemaVersion: "1.0",
      primaryKeyword: "Tokyo travel",
      secondaryKeywords: ["Osaka travel", "Kyoto travel", "Fukuoka travel"],
      articleIntent: "itinerary",
      coverage: "focused",
      keywordSelectionSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(brief)).not.toMatch(/score|google|rawArtifact/iu);
  });

  it("rejects a selector that drops the degraded-mode warning", () => {
    const stage = evaluateGooglePreemptionStage(unavailableBatch());
    expect(() =>
      assembleContentBrief(
        {
          targetCandidateId: "c1",
          secondaryCandidateIds: ["c2", "c3", "c4"],
          selectionMode: "x_fallback_degraded",
          semanticCohesion: "coherent",
          coverage: "focused",
          articleIntent: "itinerary",
          duplicateIntentCandidateIds: [],
          warningCodes: [],
        },
        stage.selectorInput,
      ),
    ).toThrow(/warningCodes/u);
  });

  it("rejects duplicate or out-of-run ambiguous intent resolutions", () => {
    expect(() =>
      evaluateGooglePreemptionStage(unavailableBatch(), [
        { candidateId: "outside", ambiguityReasonCode: "non_korean" },
      ]),
    ).toThrow("현재 Run 후보");
  });
});
