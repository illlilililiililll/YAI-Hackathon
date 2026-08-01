import { z } from "zod";

import {
  ClaimRecordV1Schema,
  EvidenceLinkV1Schema,
  SourceSnapshotV1Schema,
  type ClaimRecordV1,
  type EvidenceLinkV1,
  type ProviderMode,
  type SourceSnapshotV1,
} from "./content-domain.js";

export const ClaimDraftV1Schema = z.strictObject({
  claimId: z.string().min(1),
  text: z.string().min(1),
  importance: z.enum(["core", "supporting"]),
  volatility: z.enum(["stable", "high"]),
  qualification: z.string().min(1).nullable(),
  validAt: z.string().min(1).nullable(),
  riskDomain: z.enum(["none", "entry", "safety", "health"]),
  evidence: z.array(EvidenceLinkV1Schema),
});

export type ClaimDraftV1 = z.infer<typeof ClaimDraftV1Schema>;

const TAINT_ORDER: ProviderMode[] = ["live", "replay", "fixture", "mock"];

function combineModes(modes: readonly ProviderMode[]): ProviderMode {
  return modes.reduce<ProviderMode>((current, mode) =>
    TAINT_ORDER.indexOf(mode) > TAINT_ORDER.indexOf(current) ? mode : current,
  "live");
}

function exactCalendarDate(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input)) {
    return false;
  }
  const [year, month, day] = input.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function resolvedEvidence(
  linksInput: readonly EvidenceLinkV1[],
  sources: readonly SourceSnapshotV1[],
): Array<{ link: EvidenceLinkV1; source: SourceSnapshotV1; excerpt: string }> {
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
  return linksInput.map((input) => {
    const link = EvidenceLinkV1Schema.parse(input);
    const source = sourceMap.get(link.sourceId);
    const span = source?.spans.find(
      (candidate) => candidate.evidenceSpanId === link.evidenceSpanId,
    );
    if (!source || !span) {
      throw new Error(
        `Claim EvidenceLink가 admitted SourceSpan에 resolve되지 않습니다: ${link.sourceId}/${link.evidenceSpanId}`,
      );
    }
    return { link, source, excerpt: span.excerpt };
  });
}

export function buildClaimLedger(
  draftsInput: readonly ClaimDraftV1[],
  sourcesInput: readonly SourceSnapshotV1[],
): ClaimRecordV1[] {
  const sources = sourcesInput.map((source) => SourceSnapshotV1Schema.parse(source));
  const seenClaimIds = new Set<string>();
  return draftsInput.map((input) => {
    const draft = ClaimDraftV1Schema.parse(input);
    if (seenClaimIds.has(draft.claimId)) {
      throw new Error(`중복 Claim ID입니다: ${draft.claimId}`);
    }
    seenClaimIds.add(draft.claimId);
    const resolved = resolvedEvidence(draft.evidence, sources);
    const hasTierA = resolved.some(({ source }) => source.tier === "A");
    const temporalRequired =
      draft.volatility === "high" || draft.riskDomain !== "none";
    const temporalValid =
      draft.validAt !== null &&
      exactCalendarDate(draft.validAt) &&
      resolved.some(({ excerpt }) => excerpt.includes(draft.validAt ?? ""));

    let status: ClaimRecordV1["status"];
    let qualification = draft.qualification;
    let validAt = draft.validAt;
    if (resolved.length === 0 || (draft.importance === "core" && !hasTierA)) {
      status = "unsupported";
      qualification = null;
      validAt = null;
    } else if ((temporalRequired || draft.validAt !== null) && !temporalValid) {
      status = "stale";
      qualification = null;
      validAt = null;
    } else if (draft.riskDomain !== "none" && !draft.qualification) {
      status = "stale";
      qualification = null;
    } else if (draft.qualification) {
      status = "qualified";
    } else {
      status = "accepted";
    }

    return ClaimRecordV1Schema.parse({
      claimId: draft.claimId,
      text: draft.text,
      importance: draft.importance,
      volatility: draft.volatility,
      status,
      qualification,
      validAt,
      riskDomain: draft.riskDomain,
      evidence: resolved.map(({ link }) => link),
      provenanceMode:
        resolved.length === 0
          ? "mock"
          : combineModes(resolved.map(({ source }) => source.provenanceMode)),
    });
  });
}

export function coreClaimsHaveTierAEvidence(
  claimsInput: readonly ClaimRecordV1[],
  sourcesInput: readonly SourceSnapshotV1[],
): boolean {
  const claims = claimsInput.map((claim) => ClaimRecordV1Schema.parse(claim));
  const sources = sourcesInput.map((source) => SourceSnapshotV1Schema.parse(source));
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
  const coreClaims = claims.filter((claim) => claim.importance === "core");
  if (coreClaims.length === 0) {
    return false;
  }
  return coreClaims.every(
    (claim) =>
      (claim.status === "accepted" || claim.status === "qualified") &&
      claim.evidence.length > 0 &&
      claim.evidence.some((link) => sourceMap.get(link.sourceId)?.tier === "A"),
  );
}

export function writerEligibleClaims(
  claimsInput: readonly ClaimRecordV1[],
): ClaimRecordV1[] {
  return claimsInput
    .map((claim) => ClaimRecordV1Schema.parse(claim))
    .filter(
      (claim) => claim.status === "accepted" || claim.status === "qualified",
    );
}
