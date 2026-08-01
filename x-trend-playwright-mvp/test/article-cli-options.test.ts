import { describe, expect, it } from "vitest";

import { parseArticleCliArguments } from "../src/article-cli-options.js";
import { projectBrowserOperationLog } from "../src/article-progress.js";

describe("article CLI options", () => {
  it("keeps the preview flag out of the campaign input", () => {
    expect(
      parseArticleCliArguments([
        "--unverified-preview",
        "유럽 전문 여행사가 20대에게 패키지 상품을 판매하는 글",
      ]),
    ).toEqual({
      unverifiedPreview: true,
      input: "유럽 전문 여행사가 20대에게 패키지 상품을 판매하는 글",
    });
  });

  it("defaults to the verified fail-closed path and rejects unknown options", () => {
    expect(parseArticleCliArguments(["유럽 여행"])).toEqual({
      unverifiedPreview: false,
      input: "유럽 여행",
    });
    expect(() => parseArticleCliArguments(["--publish", "유럽 여행"])).toThrow(
      /알 수 없는 옵션/u,
    );
  });
});

describe("browser operation progress projection", () => {
  it("exposes operation identity without arguments or browser output", () => {
    const projected = projectBrowserOperationLog({
      schemaVersion: "1.0",
      runId: "run_00000000-0000-4000-8000-000000000001",
      seq: 1,
      observedAt: "2026-08-02T00:00:00.000Z",
      provider: "playwright_mcp",
      operation: {
        phase: "call",
        operationId: "operation_00000000-0000-4000-8000-000000000001",
        invocationId: "invocation_00000000-0000-4000-8000-000000000001",
        parentToolCallId: "call-secret-free-id",
        leaseId: "lease_00000000-0000-4000-8000-000000000001",
        site: "x",
        request: {
          toolName: "browser_evaluate",
          args: { function: "sensitive browser source that must not be logged" },
        },
        argsSha256: "a".repeat(64),
      },
    });

    expect(projected).toMatchObject({
      type: "browser_operation",
      site: "x",
      phase: "call",
      toolName: "browser_evaluate",
    });
    expect(JSON.stringify(projected)).not.toContain("sensitive browser source");
    expect(JSON.stringify(projected)).not.toContain("parentToolCallId");
  });
});
