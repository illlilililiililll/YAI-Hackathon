import { describe, expect, it } from "vitest";

import { evaluateArticlePreflight } from "../src/article-preflight.js";

describe("article preflight", () => {
  it("필수 실행 조건을 한 번에 보고한다", () => {
    const result = evaluateArticlePreflight({
      nodeMajor: 25,
      hasOpenAiApiKey: false,
      chromeAvailable: false,
      xProfileAvailable: false,
      xProfileLocked: true,
      rawOutputAvailable: false,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(6);
  });

  it("Node 24·key·Chrome·profile·raw 출력이 준비되면 통과한다", () => {
    const result = evaluateArticlePreflight({
      nodeMajor: 24,
      hasOpenAiApiKey: true,
      chromeAvailable: true,
      xProfileAvailable: true,
      xProfileLocked: false,
      rawOutputAvailable: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});
