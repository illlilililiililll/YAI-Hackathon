import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  XSignalBatchSchema,
  XSignalCollectionResultSchema,
  type XQueryObservation,
  type XSignal,
  type XSignalCollectionResult,
} from "./content-domain.js";
import {
  BrowserRuntime,
  type BrowserMcpServer,
  type BrowserLeaseSession,
} from "./browser-runtime.js";
import {
  XSearchResultSchema,
  buildXSearchUrl,
  normalizeKeyword,
  type XSearchResult,
} from "./domain.js";
import {
  X_PAGE_EXTRACTION_FUNCTION,
  parseExtraction,
} from "./raw-x-search.js";
import {
  type CollectXSignalsInput,
  type XSignalCollectionPort,
} from "./signal-provider-ports.js";
import { createPlaywrightMcpServer } from "./x-search-agent.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");

export const X_SIGNAL_EXTRACTOR_BUILD_SHA256 =
  "fecbae06feb69d0f6a3593501e303d5467cd5b014ff9f60b8dda880b1cc6e8a1" as const;

export type XQueryCollector = (
  session: BrowserLeaseSession,
  query: string,
  limit: number,
) => Promise<XSearchResult>;

export type PlaywrightXSignalAdapterOptions = {
  runtime: BrowserRuntime;
  collectQuery?: XQueryCollector;
  extractorBuildSha256?: string;
};

export type DefaultPlaywrightXSignalAdapterOptions = {
  xProfileDirectory?: string;
  googleProfileDirectory?: string;
  runtime?: BrowserRuntime;
};

function normalizeQueries(input: string[]): string[] {
  if (input.length < 1 || input.length > 3) {
    throw new Error("X batch query는 1..3개여야 합니다.");
  }
  const queries = input.map((query) => normalizeKeyword(query));
  if (new Set(queries).size !== queries.length) {
    throw new Error("X batch query는 정규화 후에도 고유해야 합니다.");
  }
  return queries;
}

export function normalizeXSignalText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function authorKey(authorLabel: string): string | null {
  const handle = /@([A-Za-z0-9_]{1,30})/u.exec(authorLabel)?.[1];
  const value = handle
    ? `@${handle.toLowerCase()}`
    : normalizeXSignalText(authorLabel);
  return value || null;
}

function dedupeKey(signal: XSignal): string {
  return signal.canonicalUrl
    ? `url:${signal.canonicalUrl}`
    : `text:${normalizeXSignalText(signal.text)}`;
}

async function defaultCollectQuery(
  session: BrowserLeaseSession,
  query: string,
  limit: number,
): Promise<XSearchResult> {
  const searchUrl = buildXSearchUrl(query);
  await session.call("browser_navigate", { url: searchUrl });
  await session.call("browser_wait_for", { time: 3 });
  const evaluated = await session.call("browser_evaluate", {
    function: X_PAGE_EXTRACTION_FUNCTION,
  });
  const extracted = parseExtraction(evaluated.text);
  const status = extracted.isLogin
    ? "login_required"
    : extracted.isBlocked
      ? "blocked"
      : "ok";
  return XSearchResultSchema.parse({
    keyword: query,
    status,
    searchUrl,
    collectedAt: new Date().toISOString(),
    posts: status === "ok" ? extracted.posts.slice(0, limit) : [],
    message:
      status === "login_required"
        ? "X 로그인이 필요합니다."
        : status === "blocked"
          ? "X가 자동화 접근을 차단했거나 오류 화면을 표시했습니다."
          : `첫 화면에서 게시물 ${Math.min(extracted.posts.length, limit)}개를 수집했습니다.`,
  });
}

function warningForStatus(
  status: XQueryObservation["status"],
): string | null {
  return status === "ok" ? null : `x_${status}`;
}

function buildBatch(results: XSearchResult[], queries: string[]) {
  const deduped = new Map<string, XSignal>();
  const observationKeys: string[][] = [];

  for (const result of results) {
    if (result.status !== "ok" && result.posts.length > 0) {
      throw new Error("X non-ok observation은 posts를 포함할 수 없습니다.");
    }
    const keys: string[] = [];
    for (const post of result.posts) {
      const candidate: XSignal = {
        signalId: `signal_${randomUUID()}`,
        authorLabel: post.author,
        authorKey: authorKey(post.author),
        text: post.text,
        canonicalUrl: post.url,
        visibleTimestamp: null,
        matchedQueries: [result.keyword],
        collectedAt: result.collectedAt,
      };
      const key = dedupeKey(candidate);
      const existing = deduped.get(key);
      if (existing) {
        if (!existing.matchedQueries.includes(result.keyword)) {
          existing.matchedQueries.push(result.keyword);
        }
      } else {
        deduped.set(key, candidate);
      }
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    observationKeys.push(keys);
  }

  const observations: XQueryObservation[] = results.map((result, index) => ({
    query: result.keyword,
    status: result.status,
    signals: (observationKeys[index] ?? []).map((key) => {
      const signal = deduped.get(key);
      if (!signal) {
        throw new Error("X dedupe key가 signal로 resolve되지 않습니다.");
      }
      return signal;
    }),
    attemptedAt: result.collectedAt,
    warningCode: warningForStatus(result.status),
  }));
  return XSignalBatchSchema.parse({
    plannedQueries: queries,
    observations,
    dedupedSignals: [...deduped.values()],
    coverageRatio:
      observations.filter((observation) => observation.status === "ok").length /
      queries.length,
  });
}

export class PlaywrightXSignalAdapter implements XSignalCollectionPort {
  readonly provider = "playwright" as const;
  private readonly collectQuery: XQueryCollector;
  private readonly extractorBuildSha256: string;

  constructor(private readonly options: PlaywrightXSignalAdapterOptions) {
    this.collectQuery = options.collectQuery ?? defaultCollectQuery;
    this.extractorBuildSha256 =
      options.extractorBuildSha256 ?? X_SIGNAL_EXTRACTOR_BUILD_SHA256;
  }

  get browserRuntime(): BrowserRuntime {
    return this.options.runtime;
  }

  async collect(input: CollectXSignalsInput): Promise<XSignalCollectionResult> {
    input.signal?.throwIfAborted();
    const queries = normalizeQueries(input.queries);
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("X query limit은 1..10 정수여야 합니다.");
    }
    const execution = await this.options.runtime.execute({
      runId: input.runId,
      parentToolCallId: input.parentToolCallId,
      site: "x",
      stage: "collecting_x",
      request: { queries, limit },
      extractorId: "x-signal-extractor-v1",
      extractorBuildSha256: this.extractorBuildSha256,
      signal: input.signal,
      execute: async (session) => {
        const results: XSearchResult[] = [];
        for (const query of queries) {
          input.signal?.throwIfAborted();
          try {
            results.push(await this.collectQuery(session, query, limit));
          } catch (error) {
            input.signal?.throwIfAborted();
            results.push(
              XSearchResultSchema.parse({
                keyword: query,
                status: "error",
                searchUrl: buildXSearchUrl(query),
                collectedAt: new Date().toISOString(),
                posts: [],
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }
        return { output: buildBatch(results, queries) };
      },
    });
    return XSignalCollectionResultSchema.parse({
      batch: execution.output,
      acquisition: execution.acquisition,
    });
  }
}

export function createDefaultPlaywrightXSignalAdapter(
  options: DefaultPlaywrightXSignalAdapterOptions = {},
): PlaywrightXSignalAdapter {
  const xProfileDirectory = path.resolve(
    options.xProfileDirectory ?? path.join(projectDirectory, ".browser-profile"),
  );
  const googleProfileDirectory = path.resolve(
    options.googleProfileDirectory ??
      path.join(projectDirectory, ".browser-profile-google-trends"),
  );
  const runtime =
    options.runtime ??
    new BrowserRuntime({
      profiles: {
        x: xProfileDirectory,
        google_trends: googleProfileDirectory,
      },
      createServer: ({ site, profileDirectory }) => {
        if (site !== "x") {
          throw new Error("X adapter runtime은 Google server를 만들지 않습니다.");
        }
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
      },
    });
  return new PlaywrightXSignalAdapter({ runtime });
}
