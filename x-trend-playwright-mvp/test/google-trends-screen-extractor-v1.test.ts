import { describe, expect, it } from "vitest";

import type { GoogleCandidate } from "../src/content-domain.js";
import {
  extractGoogleRenderedCaptures,
  findInterestDownloadTarget,
  parseGoogleRenderedScreen,
  type GoogleRenderedScreen,
} from "../src/google-trends-screen-extractor-v1.js";

const candidates: GoogleCandidate[] = [
  { candidateId: "c1", label: "제주 추천" },
  { candidateId: "c2", label: "부산 여행" },
  { candidateId: "c3", label: "서울 숙소" },
  { candidateId: "c4", label: "강릉 교통" },
];

function completeScreen(): GoogleRenderedScreen {
  return {
    schemaVersion: "1.0",
    pageUrl:
      "https://trends.google.com/trends/explore?hl=en&date=now+7-d&geo=KR&q=a%2Cb%2Cc%2Cd",
    pageTitle: "Google Trends",
    bodyState: "ready",
    partialBoundary: { state: "none" },
    cards: candidates.flatMap((candidate) => [
      {
        candidateLabel: candidate.label,
        kind: "related_queries" as const,
        mode: "top" as const,
        heading: "Related queries",
        rows: [
          { label: `${candidate.label} 일정`, displayedValue: "100", secondaryText: null },
        ],
      },
      {
        candidateLabel: candidate.label,
        kind: "related_queries" as const,
        mode: "rising" as const,
        heading: "Related queries",
        rows: [
          {
            label: `${candidate.label} 비용`,
            displayedValue: candidate.candidateId === "c1" ? "Breakout" : "+1,250.50%",
            secondaryText: null,
          },
        ],
      },
      {
        candidateLabel: candidate.label,
        kind: "related_topics" as const,
        mode: "top" as const,
        heading: "Related topics",
        rows: [
          { label: `${candidate.label} 지역`, displayedValue: "100", secondaryText: "Topic" },
        ],
      },
      {
        candidateLabel: candidate.label,
        kind: "related_topics" as const,
        mode: "rising" as const,
        heading: "Related topics",
        rows: [],
      },
    ]),
  };
}

describe("Google rendered screen extractor", () => {
  it("parses the MCP result section and preserves strict screen data", () => {
    const screen = completeScreen();
    const parsed = parseGoogleRenderedScreen(
      `ignored\n### Result\n${JSON.stringify(screen)}\n### Snapshot\nignored`,
    );

    expect(parsed).toEqual(screen);
  });

  it("maps exact candidate/card/mode tuples without mixing query and topic data", () => {
    const result = extractGoogleRenderedCaptures(completeScreen(), candidates);

    expect(result.captures).toHaveLength(4);
    expect(result.captures[0]?.relatedQueries.rising).toMatchObject({
      state: "available",
      value: [{ risingValue: { kind: "breakout", rawText: "Breakout" } }],
    });
    expect(result.captures[1]?.relatedQueries.rising).toMatchObject({
      state: "available",
      value: [
        { risingValue: { kind: "percent", percentBasisPoints: 125_050 } },
      ],
    });
    expect(result.captures[0]?.relatedTopics.rising).toEqual({
      state: "available",
      value: [],
    });
  });

  it("marks a missing exact card unavailable instead of fabricating an empty list", () => {
    const screen = completeScreen();
    screen.cards = screen.cards.filter(
      (card) =>
        !(
          card.candidateLabel === "제주 추천" &&
          card.kind === "related_topics" &&
          card.mode === "top"
        ),
    );

    const result = extractGoogleRenderedCaptures(screen, candidates);
    expect(result.captures[0]?.relatedTopics.top).toEqual({
      state: "unavailable",
      value: null,
      reasonCode: "schema_changed",
    });
  });

  it("selects only the unique Interest over time download ref", () => {
    expect(
      findInterestDownloadTarget(`
- heading "Interest over time" [ref=e10]
  - button "Download" [ref=e14]
- heading "Related queries" [ref=e20]
  - button "Download" [ref=e22]
`),
    ).toBe("e14");
  });
});
