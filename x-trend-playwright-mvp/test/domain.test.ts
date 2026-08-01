import { describe, expect, it } from "vitest";

import {
  AgentSearchPayloadSchema,
  XSearchResultSchema,
  buildXSearchUrl,
  normalizeKeyword,
} from "../src/domain.js";
import { buildResultFileName } from "../src/result-store.js";
import { parseExtraction } from "../src/raw-x-search.js";

describe("normalizeKeyword", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeKeyword("  여행   트렌드  ")).toBe("여행 트렌드");
  });

  it("rejects blank input", () => {
    expect(() => normalizeKeyword(" \n ")).toThrow("검색 키워드");
  });

  it("rejects input longer than 100 characters", () => {
    expect(() => normalizeKeyword("가".repeat(101))).toThrow("100자");
  });
});

describe("buildXSearchUrl", () => {
  it("encodes the keyword and selects live results", () => {
    const url = new URL(buildXSearchUrl("여행 트렌드"));
    expect(url.origin).toBe("https://x.com");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("여행 트렌드");
    expect(url.searchParams.get("f")).toBe("live");
  });
});

describe("result schemas", () => {
  it("accepts an empty successful result", () => {
    expect(
      XSearchResultSchema.parse({
        keyword: "여행",
        status: "ok",
        searchUrl: "https://x.com/search?q=%EC%97%AC%ED%96%89",
        collectedAt: "2026-08-01T08:00:00.000Z",
        posts: [],
        message: "검색 결과가 없습니다.",
      }).posts,
    ).toEqual([]);
  });

  it("rejects more than 10 posts", () => {
    const post = { author: "user", text: "여행", url: null };
    expect(() =>
      AgentSearchPayloadSchema.parse({
        status: "ok",
        posts: Array.from({ length: 11 }, () => post),
        message: "완료",
      }),
    ).toThrow();
  });

  it("rejects non-X post URLs", () => {
    expect(() =>
      AgentSearchPayloadSchema.parse({
        status: "ok",
        posts: [
          { author: "user", text: "여행", url: "https://example.com/post" },
        ],
        message: "완료",
      }),
    ).toThrow("x.com");
  });
});

describe("buildResultFileName", () => {
  it("creates a stable JSON filename from time and keyword", () => {
    expect(
      buildResultFileName("여행 트렌드", new Date("2026-08-01T09:00:00.000Z")),
    ).toBe("20260801T090000Z-여행-트렌드.json");
  });
});

describe("parseExtraction", () => {
  it("ignores Playwright metadata after the result JSON", () => {
    const parsed = parseExtraction(
      '### Result\n{"pageUrl":"https://x.com/search","pageTitle":"X","isLogin":false,"isBlocked":false,"posts":[]}\n### Ran Playwright code\n```js\ncode\n```',
    );
    expect(parsed.pageUrl).toBe("https://x.com/search");
    expect(parsed.posts).toEqual([]);
  });
});
