import { createHash } from "node:crypto";

import { sha256Canonical } from "./canonical-json.js";
import {
  createArticleWriterInput,
  validateArticleDraftForWriter,
} from "./article-agent.js";
import {
  ArticleRenderInputV1Schema,
  CanonicalArticleContentV1Schema,
  ClaimRecordV1Schema,
  ContentBriefV1Schema,
  DISCLOSURE_LITERAL_V1,
  PersonaSnapshotV1Schema,
  ProviderModeSchema,
  SourceLedgerEntryV1Schema,
  type ArticleDraftV1,
  type ArticleRenderInputV1,
  type CanonicalArticleContentV1,
  type ClaimRecordV1,
  type ContentBriefV1,
  type PersonaSnapshotV1,
  type ProviderMode,
  type SourceLedgerEntryV1,
} from "./content-domain.js";
import {
  projectWriterLinkChoices,
  resolveSiteLink,
  type SiteLinkRegistry,
} from "./site-link-registry.js";
import {
  collectCanonicalSurfaces,
  surfaceIdFor,
  validateSurfaceIndex,
} from "./surface-index-validator.js";

export type AssembleArticleDraftInput = Readonly<{
  runId: string;
  generatedAt: string;
  verifiedAt: string;
  provenanceMode: ProviderMode;
  draft: ArticleDraftV1;
  brief: ContentBriefV1;
  persona: PersonaSnapshotV1;
  claims: readonly ClaimRecordV1[];
  sources: readonly SourceLedgerEntryV1[];
  siteLinks: SiteLinkRegistry;
}>;

function normalizeDraftText(value: string, unitId: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  if (!normalized) {
    throw new Error(`Draft text가 정규화 후 비었습니다: ${unitId}`);
  }
  return normalized;
}

function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deriveProvenanceMode(
  requested: ProviderMode,
  claims: readonly ClaimRecordV1[],
  sourceModes: readonly ProviderMode[],
): ProviderMode {
  const modes = [requested, ...claims.map((claim) => claim.provenanceMode), ...sourceModes];
  if (modes.every((mode) => mode === "live")) {
    return "live";
  }
  return (["fixture", "replay", "mock"] as const).find((mode) => modes.includes(mode)) ?? "mock";
}

export function assembleArticleDraft(
  input: AssembleArticleDraftInput,
): ArticleRenderInputV1 {
  if (!input.runId.trim()) {
    throw new Error("runId가 필요합니다.");
  }
  const brief = ContentBriefV1Schema.parse(input.brief);
  const persona = PersonaSnapshotV1Schema.parse(input.persona);
  const requestedMode = ProviderModeSchema.parse(input.provenanceMode);
  const claims = input.claims.map((claim) => ClaimRecordV1Schema.parse(claim));
  const sourceLedger = input.sources.map((entry) =>
    SourceLedgerEntryV1Schema.parse(entry),
  );
  const admitted = sourceLedger.flatMap((entry) =>
    entry.status === "admitted" ? [entry.snapshot] : [],
  );
  const writerInput = createArticleWriterInput({
    brief,
    persona,
    claims: claims.filter(
      (claim) => claim.status === "accepted" || claim.status === "qualified",
    ),
    sources: admitted.map((source) => ({
      sourceId: source.sourceId,
      publisher: source.publisher,
      title: source.title,
      checkedAt: source.retrievedAt,
    })),
    links: projectWriterLinkChoices(input.siteLinks),
  });
  const draft = validateArticleDraftForWriter(input.draft, writerInput);
  const claimMap = new Map(claims.map((claim) => [claim.claimId, claim]));
  const sourceMap = new Map(admitted.map((source) => [source.sourceId, source]));
  const unitClaims = new Map<string, string>();

  const canonicalUnit = (unit: ArticleDraftV1["title"]) => {
    const claim = claimMap.get(unit.claimId);
    if (!claim || (claim.status !== "accepted" && claim.status !== "qualified")) {
      throw new Error(`Draft unit Claim이 승인되지 않았습니다: ${unit.unitId}`);
    }
    if (claim.status === "qualified" && !claim.qualification?.trim()) {
      throw new Error(`qualified Claim의 qualification이 없습니다: ${claim.claimId}`);
    }
    unitClaims.set(unit.unitId, claim.claimId);
    const text = normalizeDraftText(unit.text, unit.unitId);
    return {
      unitId: unit.unitId,
      surfaceId: surfaceIdFor(draft.articleId, unit.unitId),
      text,
      assertion: "fact" as const,
    };
  };

  const usedLinkIds = new Set<string>();
  const canonicalBlocks: CanonicalArticleContentV1["blocks"] = draft.blocks.map(
    (block) => {
      switch (block.kind) {
        case "intro":
          return {
            blockId: block.blockId,
            kind: block.kind,
            paragraphs: block.paragraphs.map(canonicalUnit),
          };
        case "summary":
        case "checklist":
          return {
            blockId: block.blockId,
            kind: block.kind,
            heading: { level: block.heading.level, text: canonicalUnit(block.heading.text) },
            items: block.items.map(canonicalUnit),
          };
        case "section":
          return {
            blockId: block.blockId,
            kind: block.kind,
            heading: { level: block.heading.level, text: canonicalUnit(block.heading.text) },
            paragraphs: block.paragraphs.map(canonicalUnit),
          };
        case "faq":
          return {
            blockId: block.blockId,
            kind: block.kind,
            heading: { level: block.heading.level, text: canonicalUnit(block.heading.text) },
            pairs: block.pairs.map((pair) => ({
              pairId: pair.pairId,
              question: canonicalUnit(pair.question),
              answers: pair.answers.map(canonicalUnit),
            })),
          };
        case "related_link":
        case "cta": {
          if (usedLinkIds.has(block.linkCandidateId)) {
            throw new Error("link candidate를 두 번 사용할 수 없습니다.");
          }
          usedLinkIds.add(block.linkCandidateId);
          const kind = block.kind === "cta" ? "cta" : "internal";
          const candidate = resolveSiteLink(
            input.siteLinks,
            block.linkCandidateId,
            kind,
          );
          const unitId = `system_link_${textSha256(
            `${draft.articleId}\0${block.blockId}\0${block.linkCandidateId}`,
          ).slice(0, 24)}`;
          return {
            blockId: block.blockId,
            kind: block.kind,
            supportingCopy: block.supportingCopy
              ? canonicalUnit(block.supportingCopy)
              : null,
            link: {
              unitId,
              surfaceId: surfaceIdFor(draft.articleId, unitId),
              linkCandidateId: candidate.linkCandidateId,
              kind: candidate.kind,
              displayLabel: candidate.displayLabel,
              url: candidate.url,
              assertion: "instruction" as const,
              claimId: null,
            },
          };
        }
      }
    },
  );

  const title = canonicalUnit(draft.title);
  const metaDescription = canonicalUnit(draft.metaDescription);
  const surfaceTree = {
    articleId: draft.articleId,
    title,
    metaDescription,
    blocks: canonicalBlocks,
  };
  const collected = collectCanonicalSurfaces(surfaceTree);
  const surfaceIndex = collected.map(
    ({ text: _text, claimId: _claimId, ...surface }) => surface,
  );
  const claimUsages = collected.flatMap((surface) => {
    if (surface.origin !== "writer") {
      return [];
    }
    const claimId = unitClaims.get(surface.unitId);
    if (!claimId) {
      throw new Error(`factual surface의 Claim mapping이 없습니다: ${surface.surfaceId}`);
    }
    return [{ claimId, surfaceId: surface.surfaceId }];
  });

  const usedSourceIds = new Set<string>();
  for (const claimId of new Set(claimUsages.map((usage) => usage.claimId))) {
    const claim = claimMap.get(claimId)!;
    if (claim.evidence.length === 0) {
      throw new Error(`사용된 Claim에 Evidence가 없습니다: ${claimId}`);
    }
    for (const link of claim.evidence) {
      const source = sourceMap.get(link.sourceId);
      if (!source) {
        throw new Error(`EvidenceLink가 admitted Source로 resolve되지 않습니다: ${link.sourceId}`);
      }
      if (!source.spans.some((span) => span.evidenceSpanId === link.evidenceSpanId)) {
        throw new Error(`EvidenceSpan reference가 Source에 없습니다: ${link.evidenceSpanId}`);
      }
      usedSourceIds.add(source.sourceId);
    }
  }
  const usedSources = [...usedSourceIds]
    .sort()
    .map((sourceId) => sourceMap.get(sourceId)!);
  const sources = usedSources.map((source) => ({
    sourceId: source.sourceId,
    title: source.title,
    url: (() => {
      const parsed = new URL(source.canonicalUrl);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        throw new Error(`SourceCitation URL이 안전한 HTTPS URL이 아닙니다: ${source.sourceId}`);
      }
      return parsed.href;
    })(),
    retrievedAt: source.retrievedAt,
  }));

  const usedClaims = [...new Set(claimUsages.map((usage) => usage.claimId))].map(
    (claimId) => claimMap.get(claimId)!,
  );
  const content = CanonicalArticleContentV1Schema.parse({
    schemaVersion: "1.0",
    runId: input.runId,
    articleId: draft.articleId,
    generatedAt: input.generatedAt,
    title,
    slug: draft.slug,
    metaDescription,
    primaryKeyword: draft.primaryKeyword,
    secondaryKeywords: draft.secondaryKeywords,
    searchIntent: draft.searchIntent,
    personaSnapshotId: persona.snapshotId,
    personaSnapshotSha256: persona.personaSnapshotSha256,
    blocks: canonicalBlocks,
    surfaceIndex,
    claimUsages,
    sources,
    disclosure: DISCLOSURE_LITERAL_V1,
    verifiedAt: input.verifiedAt,
    provenanceMode: deriveProvenanceMode(
      requestedMode,
      usedClaims,
      usedSources.map((source) => source.provenanceMode),
    ),
  });
  validateSurfaceIndex(content, claims);
  const contentRevisionSha256 = sha256Canonical(content);
  return ArticleRenderInputV1Schema.parse({
    schemaVersion: "1.0",
    contentRevisionSha256,
    content,
  });
}
