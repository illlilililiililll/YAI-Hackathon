import { sha256Canonical } from "./canonical-json.js";
import {
  ArticleRenderInputV1Schema,
  ClaimRecordV1Schema,
  ContentBriefV1Schema,
  PersonaSnapshotV1Schema,
  QualityReportV1Schema,
  SourceLedgerEntryV1Schema,
  type ArticleRenderInputV1,
  type ClaimRecordV1,
  type ContentBriefV1,
  type PersonaSnapshotV1,
  type QualityReportV1,
  type SourceLedgerEntryV1,
} from "./content-domain.js";
import { validateSurfaceIndex } from "./surface-index-validator.js";

type Gate = QualityReportV1["gates"][number];

export type ArticleQualityInput = Readonly<{
  article: ArticleRenderInputV1;
  brief: ContentBriefV1;
  persona: PersonaSnapshotV1;
  claims: readonly ClaimRecordV1[];
  sources: readonly SourceLedgerEntryV1[];
  repairAttempts?: 0 | 1;
}>;

function gate(gateName: Gate["gate"], passed: boolean, code: string): Gate {
  return { gate: gateName, passed, code };
}

function usedClaims(
  article: ArticleRenderInputV1,
  claims: readonly ClaimRecordV1[],
): ClaimRecordV1[] {
  const map = new Map(claims.map((claim) => [claim.claimId, claim]));
  return [...new Set(article.content.claimUsages.map((usage) => usage.claimId))].flatMap(
    (claimId) => {
      const claim = map.get(claimId);
      return claim ? [claim] : [];
    },
  );
}

function evidenceGate(
  article: ArticleRenderInputV1,
  claims: readonly ClaimRecordV1[],
  sources: readonly SourceLedgerEntryV1[],
): Gate {
  const claimMap = new Map(claims.map((claim) => [claim.claimId, claim]));
  const sourceMap = new Map(
    sources.flatMap((entry) =>
      entry.status === "admitted" ? [[entry.snapshot.sourceId, entry.snapshot] as const] : [],
    ),
  );
  const usedSourceIds = new Set<string>();
  for (const usage of article.content.claimUsages) {
    const claim = claimMap.get(usage.claimId);
    if (
      !claim ||
      (claim.status !== "accepted" && claim.status !== "qualified") ||
      claim.evidence.length === 0
    ) {
      return gate("evidence", false, "claim_not_supported");
    }
    for (const link of claim.evidence) {
      const source = sourceMap.get(link.sourceId);
      if (!source || !source.spans.some((span) => span.evidenceSpanId === link.evidenceSpanId)) {
        return gate("evidence", false, "evidence_link_unresolved");
      }
      usedSourceIds.add(link.sourceId);
    }
  }
  const expectedSources = [...usedSourceIds].sort().map((sourceId) => sourceMap.get(sourceId)!);
  if (
    article.content.sources.length !== expectedSources.length ||
    article.content.sources.some((citation, index) => {
      const source = expectedSources[index];
      return (
        !source ||
        citation.sourceId !== source.sourceId ||
        citation.title !== source.title ||
        citation.url !== source.canonicalUrl ||
        citation.retrievedAt !== source.retrievedAt
      );
    })
  ) {
    return gate("evidence", false, "source_citation_mismatch");
  }
  return gate("evidence", true, "evidence_ok");
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

function freshnessGate(claims: readonly ClaimRecordV1[]): Gate {
  for (const claim of claims) {
    if (claim.volatility === "high" || claim.riskDomain !== "none") {
      if (!claim.validAt || !isIsoCalendarDate(claim.validAt)) {
        return gate("freshness", false, "temporal_evidence_required");
      }
    }
  }
  return gate("freshness", true, "freshness_ok");
}

function integrityGate(article: ArticleRenderInputV1, claims: readonly ClaimRecordV1[]): Gate {
  try {
    validateSurfaceIndex(article.content, claims);
    if (sha256Canonical(article.content) !== article.contentRevisionSha256) {
      return gate("integrity", false, "content_revision_mismatch");
    }
    return gate("integrity", true, "integrity_ok");
  } catch {
    return gate("integrity", false, "surface_integrity_failed");
  }
}

function personaGate(
  article: ArticleRenderInputV1,
  persona: PersonaSnapshotV1,
): Gate {
  const matches =
    article.content.personaSnapshotId === persona.snapshotId &&
    article.content.personaSnapshotSha256 === persona.personaSnapshotSha256;
  return gate("persona", matches, matches ? "persona_ok" : "persona_mismatch");
}

function seoGate(article: ArticleRenderInputV1, brief: ContentBriefV1): Gate {
  const { content } = article;
  const primary = brief.primaryKeyword.normalize("NFC");
  const metaLength = [...content.metaDescription.text].length;
  const hasH2 = content.blocks.some(
    (block) => "heading" in block && block.heading.level === 2,
  );
  const passed =
    content.title.text.normalize("NFC").includes(primary) &&
    content.metaDescription.text.normalize("NFC").includes(primary) &&
    metaLength >= 50 &&
    metaLength <= 160 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(content.slug) &&
    hasH2;
  return gate("seo", passed, passed ? "seo_ok" : "seo_contract_failed");
}

function geoGate(article: ArticleRenderInputV1, claims: readonly ClaimRecordV1[]): Gate {
  const claimMap = new Map(claims.map((claim) => [claim.claimId, claim]));
  const usageMap = new Map(
    article.content.claimUsages.map((usage) => [usage.surfaceId, usage.claimId]),
  );
  const intro = article.content.blocks.find((block) => block.kind === "intro");
  const introClaim = intro
    ? claimMap.get(usageMap.get(intro.paragraphs[0]!.surfaceId) ?? "")
    : undefined;
  if (!introClaim || introClaim.importance !== "core") {
    return gate("geo", false, "answer_first_core_claim_required");
  }
  for (const block of article.content.blocks) {
    if (block.kind === "section") {
      if (!usageMap.has(block.paragraphs[0]!.surfaceId)) {
        return gate("geo", false, "section_answer_claim_required");
      }
    }
    if (block.kind === "faq") {
      for (const pair of block.pairs) {
        if (
          !usageMap.has(pair.question.surfaceId) ||
          !usageMap.has(pair.answers[0]!.surfaceId)
        ) {
          return gate("geo", false, "faq_claim_required");
        }
      }
    }
  }
  return gate("geo", true, "geo_ok");
}

function safetyGate(
  claims: readonly ClaimRecordV1[],
  sources: readonly SourceLedgerEntryV1[],
): Gate {
  const sourceMap = new Map(
    sources.flatMap((entry) =>
      entry.status === "admitted" ? [[entry.snapshot.sourceId, entry.snapshot] as const] : [],
    ),
  );
  for (const claim of claims.filter((value) => value.riskDomain !== "none")) {
    const hasTierA = claim.evidence.some(
      (link) => sourceMap.get(link.sourceId)?.tier === "A",
    );
    if (
      claim.status !== "qualified" ||
      !claim.qualification?.trim() ||
      !claim.validAt ||
      !hasTierA
    ) {
      return gate("safety", false, "risk_claim_policy_failed");
    }
  }
  return gate("safety", true, "safety_ok");
}

export function evaluateArticleQuality(input: ArticleQualityInput): QualityReportV1 {
  const article = ArticleRenderInputV1Schema.parse(input.article);
  const brief = ContentBriefV1Schema.parse(input.brief);
  const persona = PersonaSnapshotV1Schema.parse(input.persona);
  const claims = input.claims.map((claim) => ClaimRecordV1Schema.parse(claim));
  const sources = input.sources.map((source) => SourceLedgerEntryV1Schema.parse(source));
  const used = usedClaims(article, claims);
  const gates: Gate[] = [
    evidenceGate(article, claims, sources),
    freshnessGate(used),
    integrityGate(article, claims),
    personaGate(article, persona),
    seoGate(article, brief),
    geoGate(article, claims),
    safetyGate(used, sources),
  ];
  return QualityReportV1Schema.parse({
    passed: gates.every((entry) => entry.passed),
    repairAttempts: input.repairAttempts ?? 0,
    gates,
  });
}

export function attachRenderIntegrity(
  reportValue: QualityReportV1,
  result: { passed: boolean; code: string },
): QualityReportV1 {
  const report = QualityReportV1Schema.parse(reportValue);
  if (report.gates.some((entry) => entry.gate === "render_integrity")) {
    throw new Error("render_integrity Gate가 이미 존재합니다.");
  }
  const gates = [...report.gates, gate("render_integrity", result.passed, result.code)];
  return QualityReportV1Schema.parse({
    ...report,
    passed: gates.every((entry) => entry.passed),
    gates,
  });
}

export type WriterQualityDecisionV1 =
  | { status: "passed"; report: QualityReportV1 }
  | {
      status: "repair_required";
      report: QualityReportV1;
      failureCodes: string[];
      editableUnitIds: string[];
    }
  | { status: "failed"; report: QualityReportV1; failureCodes: string[] };

export function decideWriterRepair(
  reportValue: QualityReportV1,
  article: ArticleRenderInputV1,
): WriterQualityDecisionV1 {
  const report = QualityReportV1Schema.parse(reportValue);
  if (report.passed) {
    return { status: "passed", report };
  }
  const failures = report.gates.filter((entry) => !entry.passed);
  const failureCodes = failures.map((entry) => entry.code);
  const repairable = failures.every(
    (entry) => entry.gate === "seo" || entry.gate === "geo",
  );
  if (!repairable || report.repairAttempts >= 1) {
    return { status: "failed", report, failureCodes };
  }
  const editable = new Set<string>();
  for (const failure of failures) {
    if (failure.gate === "seo") {
      editable.add(article.content.title.unitId);
      editable.add(article.content.metaDescription.unitId);
      for (const block of article.content.blocks) {
        if ("heading" in block) {
          editable.add(block.heading.text.unitId);
        }
      }
    }
    if (failure.gate === "geo") {
      for (const block of article.content.blocks) {
        if (block.kind === "intro" || block.kind === "section") {
          editable.add(block.paragraphs[0]!.unitId);
        } else if (block.kind === "faq") {
          for (const pair of block.pairs) {
            editable.add(pair.question.unitId);
            editable.add(pair.answers[0]!.unitId);
          }
        }
      }
    }
  }
  return {
    status: "repair_required",
    report,
    failureCodes,
    editableUnitIds: [...editable],
  };
}
