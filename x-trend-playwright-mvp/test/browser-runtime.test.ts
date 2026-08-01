import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserProfileLock,
  BrowserRuntime,
  BrowserRuntimeError,
  validateBrowserCausalBundle,
  type BrowserCausalBundle,
  type BrowserMcpServer,
} from "../src/browser-runtime.js";
import { sha256Canonical } from "../src/canonical-json.js";

const directories: string[] = [];
const extractorBuildSha256 = "b".repeat(64);

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}.yai-browser.lock`, { force: true });
  }
});

function server(hooks: { onConnect?: () => void; onClose?: () => void } = {}): BrowserMcpServer {
  return {
    serverInfo: { name: "fake-playwright", version: "1" },
    async connect() {
      hooks.onConnect?.();
    },
    async close() {
      hooks.onClose?.();
    },
    async callToolResult() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

async function profiles() {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-runtime-test-"));
  const x = path.join(root, "x-profile");
  const google = path.join(root, "google-profile");
  directories.push(root);
  return { x, google_trends: google } as const;
}

async function executeOne(runtime: BrowserRuntime) {
  return runtime.execute({
    runId: "run-test-1",
    parentToolCallId: "call-test-1",
    site: "x",
    stage: "collecting_x",
    request: { queries: ["여행"] },
    extractorId: "x-signal-extractor-v1",
    extractorBuildSha256,
    execute: async (lease) => {
      await lease.call("browser_navigate", { url: "https://example.com/" });
      return { output: { observed: true } };
    },
  });
}

describe("BrowserRuntime", () => {
  it("issues a closed lease→operation→extractor→wrapper receipt graph", async () => {
    const runtime = new BrowserRuntime({
      profiles: await profiles(),
      createServer: () => server(),
    });

    const bundle = await executeOne(runtime);

    expect(bundle.operations.map((row) => row.operation.phase)).toEqual([
      "call",
      "result",
    ]);
    expect(bundle.acquisition.adapter).toBe("playwright");
    expect(() => validateBrowserCausalBundle(bundle)).not.toThrow();
  });

  it("rejects an altered invocation/output/hash instead of issuing live proof", async () => {
    const runtime = new BrowserRuntime({
      profiles: await profiles(),
      createServer: () => server(),
    });
    const bundle = await executeOne(runtime);
    const tampered = structuredClone(bundle) as BrowserCausalBundle<{
      observed: boolean;
    }>;
    tampered.invocation.resultSha256 = "0".repeat(64);

    expect(() => validateBrowserCausalBundle(tampered)).toThrow(
      "causal receipt graph",
    );
  });

  it("binds full ordered call arguments above a recomputed args hash", async () => {
    const runtime = new BrowserRuntime({
      profiles: await profiles(),
      createServer: () => server(),
    });
    const bundle = await executeOne(runtime);
    const tampered = structuredClone(bundle) as BrowserCausalBundle<{
      observed: boolean;
    }>;
    const call = tampered.operations[0];
    if (
      !call ||
      call.operation.phase !== "call" ||
      call.operation.request.toolName !== "browser_navigate"
    ) {
      throw new Error("navigate call fixture가 아닙니다.");
    }
    call.operation.request.args.url = "https://example.org/";
    call.operation.argsSha256 = sha256Canonical(call.operation.request.args);

    expect(() => validateBrowserCausalBundle(tampered)).toThrow(
      "causal receipt graph",
    );
  });

  it("serializes X and Google leases inside one process", async () => {
    let active = 0;
    let maximumActive = 0;
    const runtime = new BrowserRuntime({
      profiles: await profiles(),
      createServer: () =>
        server({
          onConnect: () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
          },
          onClose: () => {
            active -= 1;
          },
        }),
    });
    const execute = (
      site: "x" | "google_trends",
      stage: "collecting_x" | "evaluating_google",
    ) =>
      runtime.execute({
        runId: "run-serial",
        parentToolCallId: `call-${site}`,
        site,
        stage,
        request: { site },
        extractorId:
          site === "x"
            ? "x-signal-extractor-v1"
            : "google-trends-explore-extractor-v1",
        extractorBuildSha256,
        execute: async (lease) => {
          await lease.call("browser_snapshot", {});
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { output: { site } };
        },
      });

    await Promise.all([
      execute("x", "collecting_x"),
      execute("google_trends", "evaluating_google"),
    ]);
    expect(maximumActive).toBe(1);
  });

  it("fails on an existing cross-process profile lock before connecting", async () => {
    const runtimeProfiles = await profiles();
    const held = await BrowserProfileLock.acquire(runtimeProfiles.x);
    let connectCount = 0;
    const runtime = new BrowserRuntime({
      profiles: runtimeProfiles,
      createServer: () =>
        server({
          onConnect: () => {
            connectCount += 1;
          },
        }),
    });

    await expect(executeOne(runtime)).rejects.toMatchObject({
      code: "profile_in_use",
    } satisfies Partial<BrowserRuntimeError>);
    expect(connectCount).toBe(0);
    await held.release();
  });
});
