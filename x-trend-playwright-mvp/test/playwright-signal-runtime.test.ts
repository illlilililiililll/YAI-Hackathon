import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserRuntime } from "../src/browser-runtime.js";
import { createDefaultPlaywrightSignalRuntime } from "../src/playwright-signal-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("createDefaultPlaywrightSignalRuntime", () => {
  it("composes X and Google adapters with one shared BrowserRuntime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "signal-runtime-"));
    directories.push(root);
    const browserRuntime = new BrowserRuntime({
      profiles: {
        x: path.join(root, "x"),
        google_trends: path.join(root, "google"),
      },
      createServer: () => {
        throw new Error("composition test must not connect a browser");
      },
    });

    const composed = createDefaultPlaywrightSignalRuntime({
      browserRuntime,
      googleOutputBaseDirectory: path.join(root, "downloads"),
    });

    expect(composed.browserRuntime).toBe(browserRuntime);
    expect(composed.xAdapter.browserRuntime).toBe(browserRuntime);
    expect(composed.googleTrendsAdapter.browserRuntime).toBe(browserRuntime);
    expect(composed.providers.x.provider).toBe("playwright");
    expect(composed.providers.googleTrends.provider).toBe("playwright");
  });
});
