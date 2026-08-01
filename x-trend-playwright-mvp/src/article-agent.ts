import { z } from "zod";

import {
  ArticleDraftV1Schema,
  ClaimRecordV1Schema,
  ContentBriefV1Schema,
  PersonaSnapshotV1Schema,
  WriterLinkChoiceV1Schema,
  WriterSourceProjectionV1Schema,
  type ArticleDraftV1,
  type ClaimRecordV1,
  type ContentBriefV1,
  type PersonaSnapshotV1,
  type WriterLinkChoiceV1,
  type WriterSourceProjectionV1,
} from "./content-domain.js";

export const WriterClaimProjectionV1Schema = z.strictObject({
  claimId: z.string().min(1),
  text: z.string().min(1),
  importance: z.enum(["core", "supporting"]),
  status: z.enum(["accepted", "qualified"]),
  qualification: z.string().min(1).nullable(),
  validAt: z.string().min(1).nullable(),
});

export type WriterClaimProjectionV1 = z.infer<
  typeof WriterClaimProjectionV1Schema
>;

export type ArticleWriterInputV1 = Readonly<{
  brief: ContentBriefV1;
  persona: PersonaSnapshotV1;
  claims: readonly WriterClaimProjectionV1[];
  sources: readonly WriterSourceProjectionV1[];
  links: readonly WriterLinkChoiceV1[];
}>;

export type ArticleDraftProviderRequestV1 =
  | Readonly<{
      mode: "initial";
      input: ArticleWriterInputV1;
    }>
  | Readonly<{
      mode: "repair";
      input: ArticleWriterInputV1;
      originalDraft: ArticleDraftV1;
      editableUnitIds: readonly string[];
      failureCodes: readonly string[];
    }>;

export type ArticleDraftProviderContext = Readonly<{
  signal?: AbortSignal;
  onRawEvent?: (event: unknown) => void;
}>;

export interface ArticleDraftProvider {
  generate(
    request: ArticleDraftProviderRequestV1,
    context: ArticleDraftProviderContext,
  ): Promise<unknown>;
}

const ARTICLE_ID =
  /^article_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNIT_ID = /^unit_[a-z0-9][a-z0-9_-]{0,47}$/u;
const BLOCK_ID = /^block_[a-z0-9][a-z0-9_-]{0,47}$/u;
const PAIR_ID = /^pair_[a-z0-9][a-z0-9_-]{0,47}$/u;
const URL_OR_MARKUP =
  /(?:https?:\/\/|www\.|<\/?[a-z][^>]*>|\[[^\]]+\]\([^)]+\)|javascript:|data:text\/html)/iu;

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectDraftUnits(draft: ArticleDraftV1): Array<{
  unitId: string;
  text: string;
  assertion: "fact";
  claimId: string;
}> {
  const units = [draft.title, draft.metaDescription];
  for (const block of draft.blocks) {
    switch (block.kind) {
      case "intro":
      case "section":
        units.push(...block.paragraphs);
        if (block.kind === "section") {
          units.push(block.heading.text);
        }
        break;
      case "summary":
      case "checklist":
        units.push(block.heading.text, ...block.items);
        break;
      case "faq":
        units.push(block.heading.text);
        for (const pair of block.pairs) {
          units.push(pair.question, ...pair.answers);
        }
        break;
      case "related_link":
      case "cta":
        if (block.supportingCopy) {
          units.push(block.supportingCopy);
        }
        break;
    }
  }
  return units;
}

function draftStructure(draft: ArticleDraftV1): unknown {
  return {
    ...draft,
    title: { ...draft.title, text: "" },
    metaDescription: { ...draft.metaDescription, text: "" },
    blocks: draft.blocks.map((block) => {
      switch (block.kind) {
        case "intro":
        case "section":
          return {
            ...block,
            ...(block.kind === "section"
              ? { heading: { ...block.heading, text: { ...block.heading.text, text: "" } } }
              : {}),
            paragraphs: block.paragraphs.map((unit) => ({ ...unit, text: "" })),
          };
        case "summary":
        case "checklist":
          return {
            ...block,
            heading: { ...block.heading, text: { ...block.heading.text, text: "" } },
            items: block.items.map((unit) => ({ ...unit, text: "" })),
          };
        case "faq":
          return {
            ...block,
            heading: { ...block.heading, text: { ...block.heading.text, text: "" } },
            pairs: block.pairs.map((pair) => ({
              ...pair,
              question: { ...pair.question, text: "" },
              answers: pair.answers.map((unit) => ({ ...unit, text: "" })),
            })),
          };
        case "related_link":
        case "cta":
          return {
            ...block,
            supportingCopy: block.supportingCopy
              ? { ...block.supportingCopy, text: "" }
              : null,
          };
      }
    }),
  };
}

export function createArticleWriterInput(input: {
  brief: ContentBriefV1;
  persona: PersonaSnapshotV1;
  claims: readonly ClaimRecordV1[];
  sources: readonly WriterSourceProjectionV1[];
  links: readonly WriterLinkChoiceV1[];
}): ArticleWriterInputV1 {
  const brief = ContentBriefV1Schema.parse(input.brief);
  const persona = PersonaSnapshotV1Schema.parse(input.persona);
  const claims = input.claims.map((value) => ClaimRecordV1Schema.parse(value));
  if (claims.some((claim) => !["accepted", "qualified"].includes(claim.status))) {
    throw new Error("Writer에는 accepted 또는 qualified Claim만 전달할 수 있습니다.");
  }
  if (claims.some((claim) => claim.evidence.length === 0)) {
    throw new Error("Writer Claim에는 EvidenceLink가 하나 이상 필요합니다.");
  }
  if (!claims.some((claim) => claim.importance === "core")) {
    throw new Error("Writer 입력에는 core Claim이 하나 이상 필요합니다.");
  }
  const claimIds = claims.map((claim) => claim.claimId);
  if (new Set(claimIds).size !== claimIds.length) {
    throw new Error("Writer Claim ID가 중복됩니다.");
  }

  const sources = input.sources.map((source) =>
    WriterSourceProjectionV1Schema.parse(source),
  );
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
    throw new Error("Writer Source projection ID가 중복됩니다.");
  }
  const links = input.links.map((link) => WriterLinkChoiceV1Schema.parse(link));
  if (new Set(links.map((link) => link.linkCandidateId)).size !== links.length) {
    throw new Error("Writer link choice ID가 중복됩니다.");
  }

  return Object.freeze({
    brief,
    persona,
    claims: Object.freeze(
      claims.map((claim) =>
        WriterClaimProjectionV1Schema.parse({
          claimId: claim.claimId,
          text: claim.text,
          importance: claim.importance,
          status: claim.status,
          qualification: claim.qualification,
          validAt: claim.validAt,
        }),
      ),
    ),
    sources: Object.freeze(sources),
    links: Object.freeze(links),
  });
}

export function validateArticleDraftForWriter(
  draftValue: unknown,
  input: ArticleWriterInputV1,
): ArticleDraftV1 {
  const draft = ArticleDraftV1Schema.parse(draftValue);
  if (!ARTICLE_ID.test(draft.articleId)) {
    throw new Error("articleId는 lower-case UUIDv4 문법이어야 합니다.");
  }
  if (draft.personaSnapshotId !== input.persona.snapshotId) {
    throw new Error("ArticleDraft personaSnapshotId가 현재 Persona와 다릅니다.");
  }
  if (
    draft.primaryKeyword !== input.brief.primaryKeyword ||
    !sameStringArray(draft.secondaryKeywords, input.brief.secondaryKeywords) ||
    draft.searchIntent !== input.brief.articleIntent
  ) {
    throw new Error("ArticleDraft keyword 또는 search intent가 ContentBrief와 다릅니다.");
  }

  const blockIds = draft.blocks.map((block) => block.blockId);
  if (
    blockIds.some((id) => !BLOCK_ID.test(id)) ||
    new Set(blockIds).size !== blockIds.length
  ) {
    throw new Error("blockId 문법 또는 고유성 검사가 실패했습니다.");
  }
  const pairIds = draft.blocks.flatMap((block) =>
    block.kind === "faq" ? block.pairs.map((pair) => pair.pairId) : [],
  );
  if (
    pairIds.some((id) => !PAIR_ID.test(id)) ||
    new Set(pairIds).size !== pairIds.length
  ) {
    throw new Error("pairId 문법 또는 고유성 검사가 실패했습니다.");
  }

  const units = collectDraftUnits(draft);
  const unitIds = units.map((unit) => unit.unitId);
  const allowedClaimIds = new Set(input.claims.map((claim) => claim.claimId));
  if (
    unitIds.some((id) => !UNIT_ID.test(id) || id.startsWith("system_")) ||
    new Set(unitIds).size !== unitIds.length
  ) {
    throw new Error("unitId 문법 또는 고유성 검사가 실패했습니다.");
  }
  for (const unit of units) {
    if (!allowedClaimIds.has(unit.claimId)) {
      throw new Error(`Writer가 허용되지 않은 Claim을 사용했습니다: ${unit.claimId}`);
    }
    if (URL_OR_MARKUP.test(unit.text)) {
      throw new Error(`Writer text에 URL 또는 markup이 포함되었습니다: ${unit.unitId}`);
    }
  }

  if (draft.blocks[0]?.kind !== "intro") {
    throw new Error("ArticleDraft 첫 block은 intro여야 합니다.");
  }
  if (draft.blocks.filter((block) => block.kind === "intro").length !== 1) {
    throw new Error("ArticleDraft intro는 정확히 하나여야 합니다.");
  }
  if (draft.blocks.filter((block) => block.kind === "summary").length > 1) {
    throw new Error("ArticleDraft summary는 최대 하나입니다.");
  }
  if (draft.blocks.filter((block) => block.kind === "faq").length > 1) {
    throw new Error("ArticleDraft FAQ는 최대 하나입니다.");
  }
  const ctaIndexes = draft.blocks
    .map((block, index) => (block.kind === "cta" ? index : -1))
    .filter((index) => index >= 0);
  if (
    ctaIndexes.length > 1 ||
    (ctaIndexes.length === 1 && ctaIndexes[0] !== draft.blocks.length - 1)
  ) {
    throw new Error("CTA는 최대 하나이며 마지막 block이어야 합니다.");
  }

  let hasH2 = false;
  for (const block of draft.blocks) {
    if (!("heading" in block)) {
      continue;
    }
    if (block.heading.level === 2) {
      hasH2 = true;
    } else if (!hasH2) {
      throw new Error("H3는 앞선 H2 group 안에서만 사용할 수 있습니다.");
    }
  }
  if (!hasH2) {
    throw new Error("ArticleDraft에는 H2 heading이 하나 이상 필요합니다.");
  }

  const selectedLinks = draft.blocks.flatMap((block) =>
    block.kind === "related_link" || block.kind === "cta"
      ? [{ id: block.linkCandidateId, kind: block.kind === "cta" ? "cta" : "internal" }]
      : [],
  );
  if (new Set(selectedLinks.map((link) => link.id)).size !== selectedLinks.length) {
    throw new Error("같은 link candidate를 반복 사용할 수 없습니다.");
  }
  for (const selected of selectedLinks) {
    const choice = input.links.find((link) => link.linkCandidateId === selected.id);
    if (!choice || choice.kind !== selected.kind) {
      throw new Error("ArticleDraft link choice가 Writer 입력과 다릅니다.");
    }
  }

  return draft;
}

function validateRepair(
  original: ArticleDraftV1,
  repaired: ArticleDraftV1,
  editableUnitIds: readonly string[],
): void {
  if (editableUnitIds.length === 0 || new Set(editableUnitIds).size !== editableUnitIds.length) {
    throw new Error("repair editableUnitIds는 비어 있지 않은 고유 배열이어야 합니다.");
  }
  if (JSON.stringify(draftStructure(original)) !== JSON.stringify(draftStructure(repaired))) {
    throw new Error("Writer repair는 ID, Claim, block 구조 또는 metadata를 바꿀 수 없습니다.");
  }
  const editable = new Set(editableUnitIds);
  const before = new Map(collectDraftUnits(original).map((unit) => [unit.unitId, unit.text]));
  for (const unit of collectDraftUnits(repaired)) {
    if (!editable.has(unit.unitId) && unit.text !== before.get(unit.unitId)) {
      throw new Error(`Writer repair가 허용되지 않은 unit을 변경했습니다: ${unit.unitId}`);
    }
  }
}

export async function writeArticleDraft(
  provider: ArticleDraftProvider,
  request: ArticleDraftProviderRequestV1,
  context: ArticleDraftProviderContext = {},
): Promise<ArticleDraftV1> {
  const rawDraft = await provider.generate(request, context);
  const draft = validateArticleDraftForWriter(rawDraft, request.input);
  if (request.mode === "repair") {
    validateRepair(request.originalDraft, draft, request.editableUnitIds);
  }
  return draft;
}
