import { describe, expect, it } from "vitest";

import { parseGoogleInterestOverTimeCsv } from "../src/google-csv-parser-v1.js";

const candidates = [
  { candidateId: "candidate-1", label: "제주 일정" },
  { candidateId: "candidate-2", label: "부산 숙소" },
];

describe("parseGoogleInterestOverTimeCsv", () => {
  it("parses the UI-downloaded shared CSV into ordered candidate series", () => {
    const csv = [
      "Interest over time",
      "",
      "Time,제주 일정,부산 숙소",
      "2026-08-01T00,10,20",
      "2026-08-01T01,30,40",
    ].join("\r\n");
    const result = parseGoogleInterestOverTimeCsv(
      new TextEncoder().encode(csv),
      candidates,
      { state: "from", timestamp: "2026-08-01T01" },
    );

    expect(result.csvSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.seriesByCandidateId["candidate-1"]).toEqual([
      { observedAt: "2026-07-31T15:00:00.000Z", value: 10, isPartial: false },
      { observedAt: "2026-07-31T16:00:00.000Z", value: 30, isPartial: true },
    ]);
    expect(result.seriesByCandidateId["candidate-2"]?.[1]?.value).toBe(40);
  });

  it("fails closed when candidate columns are reordered", () => {
    const csv = [
      "Time,부산 숙소,제주 일정",
      "2026-08-01T00,20,10",
    ].join("\n");

    expect(() =>
      parseGoogleInterestOverTimeCsv(
        new TextEncoder().encode(csv),
        candidates,
        { state: "none" },
      ),
    ).toThrow("column 순서");
  });

  it("does not guess when the partial boundary is unavailable", () => {
    const csv = "Time,제주 일정,부산 숙소\n2026-08-01T00,10,20";
    expect(() =>
      parseGoogleInterestOverTimeCsv(
        new TextEncoder().encode(csv),
        candidates,
        { state: "unavailable" },
      ),
    ).toThrow("Partial");
  });
});
