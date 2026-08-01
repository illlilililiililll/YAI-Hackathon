import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

import {
  MCPServerStdio,
  createMCPToolStaticFilter,
} from "@openai/agents";

import {
  GoogleSignalCollectionResultSchema,
  type GoogleExploreBatch,
  type GoogleSignalCollectionResult,
} from "./content-domain.js";
import {
  BrowserRuntime,
  type BrowserMcpServer,
} from "./browser-runtime.js";
import type {
  GoogleBrowserOperation,
  GoogleCsvDownloadReceipt,
} from "./google-browser-runtime.js";
import {
  createGoogleTrendsMcpCapture,
  type GoogleMcpServer,
} from "./google-trends-mcp-capture.js";
import { captureGoogleTrendsWithCausalLease } from "./google-trends-causal-capture.js";
import {
  buildGoogleExploreUrl,
  validateGoogleExploreBatch,
  type CollectGoogleTrendsInput,
  type GoogleTrendsObservationPort,
} from "./google-trends-observation-port.js";
import type { GoogleSignalCollectionPort } from "./signal-provider-ports.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");
const mcpCli = path.join(
  projectDirectory,
  "node_modules",
  "@playwright",
  "mcp",
  "cli.js",
);

export type GoogleTrendsPlaywrightMcpOptions = {
  profileDirectory: string;
  outputDirectory: string;
};

export type DefaultGoogleTrendsPlaywrightAdapterOptions =
  GoogleTrendsPlaywrightMcpOptions & {
    onOperation?: (operation: GoogleBrowserOperation) => void;
    onDownloadReceipt?: (receipt: GoogleCsvDownloadReceipt) => void;
  };

export function createGoogleTrendsPlaywrightMcpServer(
  options: GoogleTrendsPlaywrightMcpOptions,
): MCPServerStdio {
  const profileDirectory = path.resolve(options.profileDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);

  return new MCPServerStdio({
    name: "google-trends-playwright",
    command: process.execPath,
    args: [
      mcpCli,
      "--browser",
      "chrome",
      "--user-data-dir",
      profileDirectory,
      "--output-dir",
      outputDirectory,
      "--image-responses",
      "omit",
      "--timeout-action",
      "8000",
      "--timeout-navigation",
      "30000",
    ],
    cwd: projectDirectory,
    cacheToolsList: true,
    timeout: 120_000,
    toolFilter: createMCPToolStaticFilter({
      allowed: [
        "browser_navigate",
        "browser_wait_for",
        "browser_snapshot",
        "browser_click",
        "browser_evaluate",
        "browser_close",
      ],
    }),
  });
}

export type GoogleTrendsPlaywrightCapture = (
  input: CollectGoogleTrendsInput & { exploreUrl: string },
) => Promise<GoogleExploreBatch>;

export class PlaywrightGoogleTrendsObservationAdapter
  implements GoogleTrendsObservationPort
{
  readonly adapter = "playwright" as const;

  constructor(private readonly capture: GoogleTrendsPlaywrightCapture) {}

  async collect(input: CollectGoogleTrendsInput): Promise<GoogleExploreBatch> {
    input.signal?.throwIfAborted();
    const exploreUrl = buildGoogleExploreUrl(input.candidates, input.config);
    const batch = await this.capture({ ...input, exploreUrl });
    input.signal?.throwIfAborted();
    return validateGoogleExploreBatch(batch, input.candidates, input.config);
  }
}

export function createDefaultGoogleTrendsPlaywrightAdapter(
  options: DefaultGoogleTrendsPlaywrightAdapterOptions,
): PlaywrightGoogleTrendsObservationAdapter {
  const capture = createGoogleTrendsMcpCapture({
    outputDirectory: path.resolve(options.outputDirectory),
    createServer: () =>
      createGoogleTrendsPlaywrightMcpServer(options) as unknown as GoogleMcpServer,
    onOperation: options.onOperation,
    onDownloadReceipt: options.onDownloadReceipt,
  });
  return new PlaywrightGoogleTrendsObservationAdapter(capture);
}

export const GOOGLE_TRENDS_EXTRACTOR_BUILD_SHA256 =
  "ae97c0190584c5479c2cf7a8320e8237b985ce9256e296a46601142eebfa641a" as const;

export type CausalPlaywrightGoogleTrendsAdapterOptions = {
  runtime: BrowserRuntime;
  outputDirectoryForLease: (leaseId: string) => string;
  extractorBuildSha256?: string;
  downloadTimeoutMs?: number;
  downloadPollMs?: number;
  downloadStableSamples?: number;
};

export type DefaultCausalPlaywrightGoogleTrendsAdapterOptions = {
  xProfileDirectory?: string;
  googleProfileDirectory?: string;
  outputBaseDirectory?: string;
  runtime?: BrowserRuntime;
  outputDirectoryForLease?: (leaseId: string) => string;
};

export class CausalPlaywrightGoogleTrendsAdapter
  implements GoogleSignalCollectionPort
{
  readonly provider = "playwright" as const;

  constructor(
    private readonly options: CausalPlaywrightGoogleTrendsAdapterOptions,
  ) {}

  get browserRuntime(): BrowserRuntime {
    return this.options.runtime;
  }

  async collect(
    input: CollectGoogleTrendsInput,
  ): Promise<GoogleSignalCollectionResult> {
    input.signal?.throwIfAborted();
    const exploreUrl = buildGoogleExploreUrl(input.candidates, input.config);
    const execution = await this.options.runtime.execute({
      runId: input.runId,
      parentToolCallId: input.parentToolCallId,
      site: "google_trends",
      stage: "evaluating_google",
      request: {
        candidates: input.candidates,
        config: input.config,
      },
      extractorId: "google-trends-explore-extractor-v1",
      extractorBuildSha256:
        this.options.extractorBuildSha256 ??
        GOOGLE_TRENDS_EXTRACTOR_BUILD_SHA256,
      signal: input.signal,
      execute: async (session) => {
        const outputDirectory = this.options.outputDirectoryForLease(
          session.leaseId,
        );
        await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
        const captured = await captureGoogleTrendsWithCausalLease(
          session,
          { ...input, exploreUrl },
          {
            outputDirectory,
            downloadTimeoutMs: this.options.downloadTimeoutMs,
            downloadPollMs: this.options.downloadPollMs,
            downloadStableSamples: this.options.downloadStableSamples,
          },
        );
        return {
          output: validateGoogleExploreBatch(
            captured.batch,
            input.candidates,
            input.config,
          ),
          downloadReceiptSha256s: captured.downloadReceiptSha256s,
        };
      },
    });
    return GoogleSignalCollectionResultSchema.parse({
      batch: execution.output,
      acquisition: execution.acquisition,
    });
  }
}

export function createDefaultCausalPlaywrightGoogleTrendsAdapter(
  options: DefaultCausalPlaywrightGoogleTrendsAdapterOptions = {},
): CausalPlaywrightGoogleTrendsAdapter {
  const xProfileDirectory = path.resolve(
    options.xProfileDirectory ?? path.join(projectDirectory, ".browser-profile"),
  );
  const googleProfileDirectory = path.resolve(
    options.googleProfileDirectory ??
      path.join(projectDirectory, ".browser-profile-google-trends"),
  );
  const outputBaseDirectory = path.resolve(
    options.outputBaseDirectory ??
      path.join(projectDirectory, ".browser-downloads", "google-trends"),
  );
  const outputDirectoryForLease =
    options.outputDirectoryForLease ??
    ((leaseId: string) => path.join(outputBaseDirectory, leaseId));
  const runtime =
    options.runtime ??
    new BrowserRuntime({
      profiles: {
        x: xProfileDirectory,
        google_trends: googleProfileDirectory,
      },
      createServer: async ({ site, profileDirectory, leaseId }) => {
        if (site !== "google_trends") {
          throw new Error("Google adapter runtime은 X server를 만들지 않습니다.");
        }
        await mkdir(outputBaseDirectory, { recursive: true, mode: 0o700 });
        const outputDirectory = path.join(outputBaseDirectory, leaseId);
        await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
        return createGoogleTrendsPlaywrightMcpServer({
          profileDirectory,
          outputDirectory,
        }) as unknown as BrowserMcpServer;
      },
    });
  return new CausalPlaywrightGoogleTrendsAdapter({
    runtime,
    outputDirectoryForLease,
  });
}
