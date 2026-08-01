import { describe, expect, it } from "vitest";

import {
  createArticleWriterInput,
  validateArticleDraftForWriter,
  writeArticleDraft,
  type ArticleDraftProvider,
} from "../src/article-agent.js";
import { sha256Bytes, sha256Canonical } from "../src/canonical-json.js";
import { assembleArticleDraft } from "../src/draft-assembler.js";
import {
  attachRenderIntegrity,
  decideWriterRepair,
  evaluateArticleQuality,
} from "../src/quality-gates.js";
import { checkStaticRender, validateStaticRender } from "../src/render-integrity-v1.js";
import { createSiteLinkRegistry, projectWriterLinkChoices } from "../src/site-link-registry.js";
import { renderStaticArticle } from "../src/static-html-renderer.js";
import type {
  ArticleDraftV1,
  ClaimRecordV1,
  ContentBriefV1,
  PersonaSnapshotV1,
  SourceLedgerEntryV1,
} from "../src/content-domain.js";

const HASH = "1".repeat(64);
const NOW = "2026-08-01T12:00:00.000Z";

const brief: ContentBriefV1 = {
  schemaVersion: "1.0",
  primaryKeyword: "여행",
  secondaryKeywords: ["여행 준비", "교통 정보", "안전 안내"],
  articleIntent: "preparation",
  coverage: "focused",
  keywordSelectionSha256: HASH,
};

const persona: PersonaSnapshotV1 = {
  schemaVersion: "1.0",
  snapshotId: "persona_111111111111111111111111",
  personaVersion: "1.3.0",
  personaDocumentSha256: HASH,
  personaSnapshotSha256: "2".repeat(64),
  brandName: "RoamRank",
  brandType: "여행 정보 서비스",
  targetReader: "여행을 준비하는 독자",
  tone: "차분하고 구체적인 합니다체",
  voiceTags: ["근거 중심"],
};

const sourceEntry: SourceLedgerEntryV1 = {
  status: "admitted",
  snapshot: {
    sourceId: "source_official",
    canonicalUrl: "https://official.example/travel-guide",
    title: "공식 여행 안내",
    publisher: "공식 관광 기관",
    tier: "A",
    publishedAt: null,
    retrievedAt: NOW,
    spans: [
      {
        evidenceSpanId: "span_official",
        fetchToolCallId: "call_fetch",
        fetchResultSha256: HASH,
        blockId: "block_source",
        startUtf8Byte: 0,
        endUtf8Byte: 10,
        locator: "html/body/p[1]",
        excerpt: "공식 여행 준비 안내",
        retrievedAt: NOW,
        payloadSha256: "3".repeat(64),
      },
    ],
    snapshotSha256: "4".repeat(64),
    provenanceMode: "live",
  },
};

const claims: ClaimRecordV1[] = [
  {
    claimId: "claim_core",
    text: "공식 자료를 먼저 확인하면 여행 준비 항목을 구체적으로 정리할 수 있다.",
    importance: "core",
    volatility: "stable",
    status: "accepted",
    qualification: null,
    validAt: null,
    riskDomain: "none",
    evidence: [{ sourceId: "source_official", evidenceSpanId: "span_official" }],
    provenanceMode: "live",
  },
  {
    claimId: "claim_support",
    text: "공식 안내는 교통과 준비 정보를 확인하는 근거가 된다.",
    importance: "supporting",
    volatility: "stable",
    status: "accepted",
    qualification: null,
    validAt: null,
    riskDomain: "none",
    evidence: [{ sourceId: "source_official", evidenceSpanId: "span_official" }],
    provenanceMode: "live",
  },
];

const registry = createSiteLinkRegistry({
  siteOrigin: "https://example.com/",
  allowedHosts: ["example.com"],
  candidates: [
    {
      linkCandidateId: "link_guide",
      kind: "internal",
      labelId: "internal_guide",
      url: "https://example.com/guides/travel",
    },
    {
      linkCandidateId: "link_contact",
      kind: "cta",
      labelId: "cta_contact",
      url: "https://example.com/contact",
    },
  ],
});

function draft(metaDescription = "여행 준비에 필요한 공식 일정과 교통 정보를 근거 중심으로 확인하고, 출발 전에 점검할 내용을 차분하게 정리한 실용 안내입니다."): ArticleDraftV1 {
  return {
    schemaVersion: "1.0",
    articleId: "article_11111111-1111-4111-8111-111111111111",
    personaSnapshotId: persona.snapshotId,
    title: {
      unitId: "unit_title",
      text: "여행 준비, 공식 자료부터 확인하는 실용 가이드",
      assertion: "fact",
      claimId: "claim_core",
    },
    slug: "travel-preparation-guide",
    metaDescription: {
      unitId: "unit_meta",
      text: metaDescription,
      assertion: "fact",
      claimId: "claim_core",
    },
    primaryKeyword: brief.primaryKeyword,
    secondaryKeywords: brief.secondaryKeywords,
    searchIntent: brief.articleIntent,
    blocks: [
      {
        blockId: "block_intro",
        kind: "intro",
        paragraphs: [
          {
            unitId: "unit_intro",
            text: "여행 준비는 공식 자료를 먼저 확인하면 필요한 항목을 구체적으로 정리할 수 있습니다. 2 < 3 & 4 > 1 같은 기호도 안전하게 표시합니다.",
            assertion: "fact",
            claimId: "claim_core",
          },
        ],
      },
      {
        blockId: "block_section",
        kind: "section",
        heading: {
          level: 2,
          text: {
            unitId: "unit_heading",
            text: "공식 안내에서 확인할 내용",
            assertion: "fact",
            claimId: "claim_support",
          },
        },
        paragraphs: [
          {
            unitId: "unit_section",
            text: "공식 안내는 교통과 준비 정보를 확인하는 근거가 됩니다.",
            assertion: "fact",
            claimId: "claim_support",
          },
        ],
      },
      {
        blockId: "block_link",
        kind: "related_link",
        supportingCopy: null,
        linkCandidateId: "link_guide",
      },
      {
        blockId: "block_cta",
        kind: "cta",
        supportingCopy: null,
        linkCandidateId: "link_contact",
      },
    ],
  };
}

function writerInput() {
  return createArticleWriterInput({
    brief,
    persona,
    claims,
    sources: [
      {
        sourceId: "source_official",
        publisher: "공식 관광 기관",
        title: "공식 여행 안내",
        checkedAt: NOW,
      },
    ],
    links: projectWriterLinkChoices(registry),
  });
}

describe("Writer to static output pipeline", () => {
  it("validates an injected draft, assembles Claim lineage, and renders deterministic safe bytes", async () => {
    let providerRequest = "";
    const provider: ArticleDraftProvider = {
      async generate(request) {
        providerRequest = JSON.stringify(request.input);
        return draft();
      },
    };
    const written = await writeArticleDraft(
      provider,
      { mode: "initial", input: writerInput() },
    );
    expect(providerRequest).not.toContain("https://");

    const article = assembleArticleDraft({
      runId: "run_11111111-1111-4111-8111-111111111111",
      generatedAt: NOW,
      verifiedAt: NOW,
      provenanceMode: "live",
      draft: written,
      brief,
      persona,
      claims,
      sources: [sourceEntry],
      siteLinks: registry,
    });
    expect(article.content.blocks[2]).toMatchObject({
      kind: "related_link",
      link: { url: "https://example.com/guides/travel" },
    });
    expect(article.content.provenanceMode).toBe("live");

    const quality = evaluateArticleQuality({
      article,
      brief,
      persona,
      claims,
      sources: [sourceEntry],
    });
    expect(quality.passed).toBe(true);

    const firstRender = await renderStaticArticle(article);
    const secondRender = await renderStaticArticle(article);
    expect(firstRender.files.map((file) => file.sha256)).toEqual(
      secondRender.files.map((file) => file.sha256),
    );
    await expect(validateStaticRender(article, firstRender)).resolves.toBeUndefined();
    const renderGate = await checkStaticRender(article, firstRender);
    expect(attachRenderIntegrity(quality, renderGate).passed).toBe(true);
    const html = new TextDecoder().decode(firstRender.files[0].bytes);
    expect(html).toContain("2 &lt; 3 &amp; 4 &gt; 1");
    expect(html).not.toMatch(/<(?:script|style|img|table)\b/iu);

    const tamperedRender = structuredClone(firstRender);
    const tamperedHtml = html.replace(
      "https://example.com/guides/travel",
      "https://example.com/guides/wrongx",
    );
    const tamperedBytes = new TextEncoder().encode(tamperedHtml);
    tamperedRender.files[0].bytes = tamperedBytes;
    tamperedRender.files[0].byteLength = tamperedBytes.byteLength;
    tamperedRender.files[0].sha256 = sha256Bytes(tamperedBytes);
    await expect(validateStaticRender(article, tamperedRender)).rejects.toThrow(
      "system link href",
    );
  });

  it("rejects Writer URLs and derives non-live taint monotonically", () => {
    const unsafe = draft();
    unsafe.blocks[0] = {
      blockId: "block_intro",
      kind: "intro",
      paragraphs: [
        {
          unitId: "unit_intro",
          text: "https://example.com 을 확인하세요.",
          assertion: "fact",
          claimId: "claim_core",
        },
      ],
    };
    expect(() => validateArticleDraftForWriter(unsafe, writerInput())).toThrow("URL");

    const fixtureClaims = claims.map((claim) => ({
      ...claim,
      provenanceMode: "fixture" as const,
    }));
    const article = assembleArticleDraft({
      runId: "run_22222222-2222-4222-8222-222222222222",
      generatedAt: NOW,
      verifiedAt: NOW,
      provenanceMode: "live",
      draft: draft(),
      brief,
      persona,
      claims: fixtureClaims,
      sources: [sourceEntry],
      siteLinks: registry,
    });
    expect(article.content.provenanceMode).toBe("fixture");
  });

  it("offers one targeted SEO repair but never repairs Evidence failures", () => {
    const article = assembleArticleDraft({
      runId: "run_33333333-3333-4333-8333-333333333333",
      generatedAt: NOW,
      verifiedAt: NOW,
      provenanceMode: "live",
      draft: draft("여행 준비 안내"),
      brief,
      persona,
      claims,
      sources: [sourceEntry],
      siteLinks: registry,
    });
    const quality = evaluateArticleQuality({
      article,
      brief,
      persona,
      claims,
      sources: [sourceEntry],
    });
    const decision = decideWriterRepair(quality, article);
    expect(decision).toMatchObject({
      status: "repair_required",
      failureCodes: ["seo_contract_failed"],
    });
    if (decision.status === "repair_required") {
      expect(decision.editableUnitIds).toContain("unit_meta");
    }

    const citationTamper = structuredClone(article);
    citationTamper.content.sources[0]!.title = "변조된 출처";
    citationTamper.contentRevisionSha256 = sha256Canonical(citationTamper.content);
    const tamperedQuality = evaluateArticleQuality({
      article: citationTamper,
      brief,
      persona,
      claims,
      sources: [sourceEntry],
    });
    expect(tamperedQuality.gates).toContainEqual({
      gate: "evidence",
      passed: false,
      code: "source_citation_mismatch",
    });
    expect(decideWriterRepair(tamperedQuality, citationTamper).status).toBe("failed");
  });
});
