import { describe, expect, it } from "vitest";

import { sha256Bytes, sha256Canonical } from "../src/canonical-json.js";
import {
  buildClaimLedger,
  coreClaimsHaveTierAEvidence,
} from "../src/claim-ledger.js";
import type {
  ContentBriefV1,
  SourceDiscoveryRefV1,
  SourceSnapshotV1,
} from "../src/content-domain.js";
import { researchEvidence } from "../src/evidence-agent.js";
import { SourceFetchError, type FetchedSourcePage } from "../src/source-fetch.js";
import {
  admitSourceSnapshot,
  evidenceSpanMatchesBlock,
  loadSourceHostPolicy,
  SourceHostPolicyV1Schema,
  type SourceHostPolicyV1,
} from "../src/source-policy-gate.js";
import { extractSourceText } from "../src/source-text-extractor.js";

const brief: ContentBriefV1 = {
  schemaVersion: "1.0",
  primaryKeyword: "도쿄 여행",
  secondaryKeywords: ["교통", "일정", "준비"],
  articleIntent: "itinerary",
  coverage: "focused",
  keywordSelectionSha256: "a".repeat(64),
};

const policy: SourceHostPolicyV1 = SourceHostPolicyV1Schema.parse({
  schemaVersion: "1.0",
  policyId: "test-policy-v1",
  rules: [
    { hostname: "official.example", publisher: "Official Tourism", tier: "A" },
  ],
});

function ref(callId: string, path: string): SourceDiscoveryRefV1 {
  return {
    webSearchCallId: callId,
    rawEventSeq: callId === "ws_1" ? 1 : 2,
    semanticPayloadSha256: callId === "ws_1" ? "1".repeat(64) : "2".repeat(64),
    candidateUrl: `https://official.example/${path}`,
  };
}

function fetched(discovery: SourceDiscoveryRefV1, suffix = "1"): FetchedSourcePage {
  const html = `<title>Official Guide ${suffix}</title><p>2026-08-02 도쿄 공식 안내 ${suffix}</p>`;
  const body = Buffer.from(html);
  const blocks = extractSourceText(html, discovery.candidateUrl).blocks;
  const resultWithoutHash = {
    requestUrl: discovery.candidateUrl,
    finalUrl: discovery.candidateUrl,
    redirectChain: [] as string[],
    status: 200 as const,
    contentType: "text/html; charset=utf-8",
    retrievedAt: "2026-08-02T00:00:00.000Z",
    decompressedByteLength: body.byteLength,
    bodySha256: sha256Bytes(body),
    blocks,
    truncated: false,
    provenanceMode: "mock" as const,
  };
  return {
    discovery,
    fetchToolCallId: `fetch_${suffix}`,
    ...resultWithoutHash,
    resultSha256: sha256Canonical(resultWithoutHash),
  };
}

function idFactory(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}_${String(++index).padStart(2, "0")}`;
}

describe("SourcePolicy and Claim Ledger", () => {
  it("loads the code-owned policy and excludes unknown hosts", async () => {
    const loaded = await loadSourceHostPolicy();
    expect(loaded.policyId).toBe("hackathon-source-host-policy-v1");

    const unknownRef = {
      ...ref("ws_1", "guide"),
      candidateUrl: "https://unknown.example/guide",
    };
    const result = admitSourceSnapshot({
      discovery: unknownRef,
      fetched: {
        ...fetched(unknownRef),
        finalUrl: "https://unknown.example/guide",
      },
      policy,
    });
    expect(result).toMatchObject({ status: "excluded", reasonCode: "unknown_host" });
  });

  it("creates exact full-block EvidenceSpans and enforces tier A core evidence", () => {
    const discovery = ref("ws_1", "guide");
    const admitted = admitSourceSnapshot({
      discovery,
      fetched: fetched(discovery),
      policy,
      sourceIdFactory: () => "source_1",
      evidenceSpanIdFactory: idFactory("span"),
    });
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") {
      throw new Error("fixture admission failed");
    }
    const snapshot = admitted.snapshot;
    const fetchedPage = fetched(discovery);
    const koreanSpan = snapshot.spans[1]!;
    expect(evidenceSpanMatchesBlock(koreanSpan, fetchedPage)).toBe(true);
    expect(
      evidenceSpanMatchesBlock(
        {
          ...koreanSpan,
          endUtf8Byte: koreanSpan.endUtf8Byte - 1,
        },
        fetchedPage,
      ),
    ).toBe(false);
    const evidence = {
      sourceId: snapshot.sourceId,
      evidenceSpanId: snapshot.spans[1]!.evidenceSpanId,
    };
    const claims = buildClaimLedger(
      [
        {
          claimId: "claim_1",
          text: "공식 안내는 2026-08-02에 확인됐다.",
          importance: "core",
          volatility: "high",
          qualification: null,
          validAt: "2026-08-02",
          riskDomain: "none",
          evidence: [evidence],
        },
      ],
      [snapshot],
    );
    expect(claims[0]).toMatchObject({ status: "accepted", validAt: "2026-08-02" });
    expect(coreClaimsHaveTierAEvidence(claims, [snapshot])).toBe(true);

    const tierB = { ...snapshot, sourceId: "source_b", tier: "B" as const };
    const tierBClaims = buildClaimLedger(
      [
        {
          claimId: "claim_b",
          text: "Tier B만 있는 core Claim",
          importance: "core",
          volatility: "stable",
          qualification: null,
          validAt: null,
          riskDomain: "none",
          evidence: [
            {
              sourceId: tierB.sourceId,
              evidenceSpanId: tierB.spans[0]!.evidenceSpanId,
            },
          ],
        },
      ],
      [tierB],
    );
    expect(tierBClaims[0]?.status).toBe("unsupported");
    expect(coreClaimsHaveTierAEvidence(tierBClaims, [tierB])).toBe(false);

    expect(() =>
      buildClaimLedger(
        [
          {
            claimId: "claim_broken",
            text: "존재하지 않는 근거",
            importance: "core",
            volatility: "stable",
            qualification: null,
            validAt: null,
            riskDomain: "none",
            evidence: [{ sourceId: snapshot.sourceId, evidenceSpanId: "span_missing" }],
          },
        ],
        [snapshot],
      ),
    ).toThrow("resolve되지 않습니다");
  });
});

describe("Evidence research orchestration", () => {
  it("rejects an unknown source host before invoking the fetch port", async () => {
    let fetchCalls = 0;
    const unknownRef = {
      ...ref("ws_1", "guide"),
      candidateUrl: "https://unknown.example/guide",
    };
    const result = await researchEvidence(brief, {
      sourceHostPolicy: policy,
      discovery: { discover: async () => [unknownRef] },
      fetcher: {
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("unknown host must not reach the network boundary");
        },
      },
      claimExtractor: { extract: async () => [] },
    });

    expect(fetchCalls).toBe(0);
    expect(result.status).toBe("needs_evidence");
    expect(result.sources).toEqual([
      expect.objectContaining({ status: "excluded", reasonCode: "unknown_host" }),
    ]);
  });

  it("retries once and succeeds only after a core tier A Claim resolves", async () => {
    const sourceId = idFactory("source");
    const spanId = idFactory("span");
    const result = await researchEvidence(brief, {
      sourceHostPolicy: policy,
      discovery: {
        discover: async (_brief, attempt) =>
          attempt === 1 ? [ref("ws_1", "one")] : [ref("ws_2", "two")],
      },
      fetcher: {
        fetch: async (discovery, attempt) => fetched(discovery, String(attempt)),
      },
      claimExtractor: {
        extract: async ({ admittedSources, attempt }) => {
          if (attempt === 1) {
            return [
              {
                claimId: "claim_core",
                text: "도쿄 공식 안내가 있다.",
                importance: "core",
                volatility: "stable",
                qualification: null,
                validAt: null,
                riskDomain: "none",
                evidence: [],
              },
            ];
          }
          const source = admittedSources[0] as SourceSnapshotV1;
          return [
            {
              claimId: "claim_core",
              text: "도쿄 공식 안내가 있다.",
              importance: "core",
              volatility: "stable",
              qualification: null,
              validAt: null,
              riskDomain: "none",
              evidence: [
                {
                  sourceId: source.sourceId,
                  evidenceSpanId: source.spans[0]!.evidenceSpanId,
                },
              ],
            },
          ];
        },
      },
      sourceIdFactory: sourceId,
      evidenceSpanIdFactory: spanId,
    });

    expect(result.status).toBe("sufficient");
    expect(result.attempts).toBe(2);
    expect(result.sources.filter((entry) => entry.status === "admitted")).toHaveLength(2);
    expect(result.warningCodes).toContain("core_claim_research_retry");
  });

  it("returns needs_evidence after exactly two empty research attempts", async () => {
    const calls: number[] = [];
    const result = await researchEvidence(brief, {
      sourceHostPolicy: policy,
      discovery: {
        discover: async (_brief, attempt) => {
          calls.push(attempt);
          return [];
        },
      },
      fetcher: {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      },
      claimExtractor: { extract: async () => [] },
    });

    expect(calls).toEqual([1, 2]);
    expect(result).toMatchObject({ status: "needs_evidence", attempts: 2 });
  });

  it("returns source_blocked when every discovered source is blocked", async () => {
    const result = await researchEvidence(brief, {
      sourceHostPolicy: policy,
      discovery: {
        discover: async (_brief, attempt) => [
          ref(attempt === 1 ? "ws_1" : "ws_2", `blocked-${attempt}`),
        ],
      },
      fetcher: {
        fetch: async () => {
          throw new SourceFetchError("timeout", "blocked");
        },
      },
      claimExtractor: { extract: async () => [] },
    });

    expect(result.status).toBe("source_blocked");
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((entry) => entry.status === "excluded")).toBe(true);
  });

  it("does not misclassify ordinary HTTP/content failures as source_blocked", async () => {
    const result = await researchEvidence(brief, {
      sourceHostPolicy: policy,
      discovery: {
        discover: async (_brief, attempt) => [
          ref(attempt === 1 ? "ws_1" : "ws_2", `missing-${attempt}`),
        ],
      },
      fetcher: {
        fetch: async () => {
          throw new SourceFetchError("http_status", "404");
        },
      },
      claimExtractor: { extract: async () => [] },
    });

    expect(result.status).toBe("needs_evidence");
  });
});
