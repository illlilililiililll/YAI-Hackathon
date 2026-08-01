import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserRuntime,
  type BrowserMcpServer,
} from "../src/browser-runtime.js";
import { buildXSearchUrl, type XSearchResult } from "../src/domain.js";
import { PlaywrightXSignalAdapter } from "../src/x-signal-adapter.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("PlaywrightXSignalAdapter", () => {
  it("uses one lease, preserves query status/order, and stably dedupes posts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "x-signal-adapter-"));
    directories.push(root);
    let connectCount = 0;
    const fakeServer: BrowserMcpServer = {
      async connect() {
        connectCount += 1;
      },
      async close() {},
      async callToolResult() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const runtime = new BrowserRuntime({
      profiles: {
        x: path.join(root, "x"),
        google_trends: path.join(root, "google"),
      },
      createServer: () => fakeServer,
    });
    const adapter = new PlaywrightXSignalAdapter({
      runtime,
      collectQuery: async (lease, query): Promise<XSearchResult> => {
        await lease.call("browser_snapshot", {});
        const loginRequired = query === "세 번째";
        return {
          keyword: query,
          searchUrl: buildXSearchUrl(query),
          collectedAt: "2026-08-02T00:00:00.000Z",
          status: loginRequired ? "login_required" : "ok",
          posts: loginRequired
            ? []
            : [
                {
                  author: "Traveler @same",
                  text: query === "첫 번째" ? "제주  여행" : "제주 여행",
                  url: "https://x.com/same/status/1",
                },
              ],
          message: loginRequired ? "로그인 필요" : "완료",
        };
      },
    });

    const result = await adapter.collect({
      runId: "run-x-1",
      parentToolCallId: "call-x-1",
      queries: ["첫 번째", "두 번째", "세 번째"],
    });

    expect(connectCount).toBe(1);
    expect(result.batch.observations.map((item) => item.query)).toEqual([
      "첫 번째",
      "두 번째",
      "세 번째",
    ]);
    expect(result.batch.observations.map((item) => item.status)).toEqual([
      "ok",
      "ok",
      "login_required",
    ]);
    expect(result.batch.coverageRatio).toBe(2 / 3);
    expect(result.batch.dedupedSignals).toHaveLength(1);
    expect(result.batch.dedupedSignals[0]?.matchedQueries).toEqual([
      "첫 번째",
      "두 번째",
    ]);
    expect(result.acquisition.adapter).toBe("playwright");
  });

  it("rejects posts returned by a non-ok query result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "x-signal-non-ok-"));
    directories.push(root);
    const runtime = new BrowserRuntime({
      profiles: {
        x: path.join(root, "x"),
        google_trends: path.join(root, "google"),
      },
      createServer: () => ({
        async connect() {},
        async close() {},
        async callToolResult() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    });
    const adapter = new PlaywrightXSignalAdapter({
      runtime,
      collectQuery: async (lease, query) => {
        await lease.call("browser_snapshot", {});
        return {
          keyword: query,
          searchUrl: buildXSearchUrl(query),
          collectedAt: "2026-08-02T00:00:00.000Z",
          status: "blocked",
          posts: [
            {
              author: "Blocked result",
              text: "신뢰할 수 없는 화면의 게시물",
              url: "https://x.com/blocked/status/1",
            },
          ],
          message: "차단됨",
        };
      },
    });

    await expect(
      adapter.collect({
        runId: "run-x-blocked",
        parentToolCallId: "call-x-blocked",
        queries: ["차단 쿼리"],
      }),
    ).rejects.toThrow("non-ok observation");
  });
});
