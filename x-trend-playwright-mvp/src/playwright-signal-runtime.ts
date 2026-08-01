import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BrowserRuntime,
  type BrowserMcpServer,
} from "./browser-runtime.js";
import {
  CausalPlaywrightGoogleTrendsAdapter,
  createGoogleTrendsPlaywrightMcpServer,
} from "./google-trends-playwright-adapter.js";
import {
  SignalProviderRegistry,
  createSignalProviderRuntime,
  type SignalProviderRuntimeSelection,
} from "./signal-provider-ports.js";
import { createPlaywrightMcpServer } from "./x-search-agent.js";
import { PlaywrightXSignalAdapter } from "./x-signal-adapter.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");

export type DefaultPlaywrightSignalRuntimeOptions = {
  xProfileDirectory?: string;
  googleProfileDirectory?: string;
  googleOutputBaseDirectory?: string;
  browserRuntime?: BrowserRuntime;
  outputDirectoryForLease?: (leaseId: string) => string;
  selection?: SignalProviderRuntimeSelection;
};

/**
 * Composes both default Playwright providers around one process-local runtime.
 * The shared runtime is the serialization boundary; site profiles remain distinct.
 */
export function createDefaultPlaywrightSignalRuntime(
  options: DefaultPlaywrightSignalRuntimeOptions = {},
) {
  const xProfileDirectory = path.resolve(
    options.xProfileDirectory ?? path.join(projectDirectory, ".browser-profile"),
  );
  const googleProfileDirectory = path.resolve(
    options.googleProfileDirectory ??
      path.join(projectDirectory, ".browser-profile-google-trends"),
  );
  const googleOutputBaseDirectory = path.resolve(
    options.googleOutputBaseDirectory ??
      path.join(projectDirectory, ".browser-downloads", "google-trends"),
  );
  const outputDirectoryForLease =
    options.outputDirectoryForLease ??
    ((leaseId: string) => path.join(googleOutputBaseDirectory, leaseId));

  const browserRuntime =
    options.browserRuntime ??
    new BrowserRuntime({
      profiles: {
        x: xProfileDirectory,
        google_trends: googleProfileDirectory,
      },
      createServer: async ({ site, profileDirectory, leaseId }) => {
        if (site === "x") {
          return createPlaywrightMcpServer({
            profileDirectory,
            name: "x-playwright",
            allowedTools: [
              "browser_navigate",
              "browser_wait_for",
              "browser_snapshot",
              "browser_evaluate",
              "browser_close",
            ],
          }) as unknown as BrowserMcpServer;
        }
        await mkdir(googleOutputBaseDirectory, {
          recursive: true,
          mode: 0o700,
        });
        const outputDirectory = outputDirectoryForLease(leaseId);
        await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
        return createGoogleTrendsPlaywrightMcpServer({
          profileDirectory,
          outputDirectory,
        }) as unknown as BrowserMcpServer;
      },
    });

  const xAdapter = new PlaywrightXSignalAdapter({ runtime: browserRuntime });
  const googleTrendsAdapter = new CausalPlaywrightGoogleTrendsAdapter({
    runtime: browserRuntime,
    outputDirectoryForLease,
  });
  const registry = new SignalProviderRegistry()
    .registerX(xAdapter)
    .registerGoogleTrends(googleTrendsAdapter);
  const providers = createSignalProviderRuntime(registry, options.selection);

  return {
    browserRuntime,
    registry,
    xAdapter,
    googleTrendsAdapter,
    providers,
  };
}
