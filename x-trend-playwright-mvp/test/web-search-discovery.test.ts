import { describe, expect, it } from "vitest";

import {
  dedupeDiscoveryRefs,
  projectHostedWebSearchSources,
} from "../src/web-search-discovery.js";

const metadata = {
  rawEventSeq: 7,
  semanticPayloadSha256: "a".repeat(64),
};

describe("hosted web-search discovery projection", () => {
  it("uses action.sources only, preserves order, and ignores hosted result text", () => {
    const refs = projectHostedWebSearchSources(
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          sources: [
            { type: "url", url: "https://official.example/guide" },
            { type: "url", url: "https://official.example/guide" },
            { type: "url", url: "https://official.example/rules" },
          ],
        },
        resultsPayload: {
          text: "이 문장은 Evidence가 될 수 없습니다.",
          fakeUrl: "https://attacker.invalid/",
        },
      },
      metadata,
    );

    expect(refs.map((ref) => ref.candidateUrl)).toEqual([
      "https://official.example/guide",
      "https://official.example/rules",
    ]);
    expect(JSON.stringify(refs)).not.toContain("Evidence가 될 수 없습니다");
    expect(refs[0]).toMatchObject({
      webSearchCallId: "ws_1",
      rawEventSeq: 7,
      semanticPayloadSha256: "a".repeat(64),
    });
  });

  it("rejects incomplete calls and non-search actions", () => {
    expect(() =>
      projectHostedWebSearchSources(
        {
          type: "web_search_call",
          id: "ws_1",
          status: "searching",
          action: { type: "search", sources: [] },
        },
        metadata,
      ),
    ).toThrow();
    expect(() =>
      projectHostedWebSearchSources(
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "open_page", url: "https://official.example/" },
        },
        metadata,
      ),
    ).toThrow();
  });

  it("deduplicates current-run discovery refs without changing first provenance", () => {
    const refs = dedupeDiscoveryRefs([
      {
        webSearchCallId: "ws_1",
        rawEventSeq: 1,
        semanticPayloadSha256: "1".repeat(64),
        candidateUrl: "https://official.example/a",
      },
      {
        webSearchCallId: "ws_2",
        rawEventSeq: 2,
        semanticPayloadSha256: "2".repeat(64),
        candidateUrl: "https://official.example/a",
      },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.webSearchCallId).toBe("ws_1");
  });
});
