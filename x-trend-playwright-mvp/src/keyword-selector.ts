import { z } from "zod";

import {
  ArticleIntentSchema,
  ContentBriefV1Schema,
  GoogleCandidateSchema,
  GooglePreemptionEvaluationSchema,
  type ContentBriefV1,
  type GoogleCandidate,
  type GooglePreemptionEvaluation,
} from "./content-domain.js";
import { sha256Canonical } from "./canonical-json.js";

export const KeywordSelectorInputSchema = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        candidateId: z.string().trim().min(1),
        label: z.string().trim().min(1),
        xRank: z.number().int().min(1).max(5),
        scoreStatus: z.enum(["complete", "partial", "unavailable"]),
        componentBasisPoints: z.strictObject({
          rising: z.number().int().min(0).max(10_000).nullable(),
          trend: z.number().int().min(0).max(10_000).nullable(),
          cluster: z.number().int().min(0).max(10_000).nullable(),
          intent: z.number().int().min(0).max(10_000).nullable(),
        }),
        scoreBasisPoints: z.number().int().min(-6_000).max(4_000).nullable(),
      }),
    )
    .min(4)
    .max(5),
  selectionMode: z.enum(["google_scored", "x_fallback_degraded"]),
  warningCodes: z.array(
    z.enum([
      "google_explore_all_unavailable",
      "google_explore_no_complete_score",
      "google_partial_secondary",
    ]),
  ),
});

export const KeywordSelectionSchema = z.strictObject({
  targetCandidateId: z.string().trim().min(1),
  secondaryCandidateIds: z.array(z.string().trim().min(1)).min(3).max(5),
  selectionMode: z.enum(["google_scored", "x_fallback_degraded"]),
  semanticCohesion: z.literal("coherent"),
  coverage: z.enum(["focused", "broad"]),
  articleIntent: ArticleIntentSchema,
  duplicateIntentCandidateIds: z.array(z.string().trim().min(1)),
  warningCodes: KeywordSelectorInputSchema.shape.warningCodes,
});

export const ContentBriefSchema = ContentBriefV1Schema;

export type KeywordSelectorInput = z.infer<typeof KeywordSelectorInputSchema>;
export type KeywordSelection = z.infer<typeof KeywordSelectionSchema>;
export type ContentBrief = ContentBriefV1;

export function buildKeywordSelectorInput(
  candidatesInput: GoogleCandidate[],
  evaluationsInput: GooglePreemptionEvaluation[],
): KeywordSelectorInput {
  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  const evaluations = evaluationsInput.map((evaluation) =>
    GooglePreemptionEvaluationSchema.parse(evaluation),
  );
  if (candidates.length < 4 || candidates.length > 5) {
    throw new Error("KeywordSelector 후보는 4..5개여야 합니다.");
  }
  if (evaluations.length !== candidates.length) {
    throw new Error("후보와 Google evaluation 개수가 다릅니다.");
  }

  const projection = candidates.map((candidate, index) => {
    const evaluation = evaluations[index];
    if (!evaluation || evaluation.candidateId !== candidate.candidateId) {
      throw new Error("Google evaluation 순서가 X 후보 순서와 다릅니다.");
    }
    return {
      candidateId: candidate.candidateId,
      label: candidate.label,
      xRank: index + 1,
      scoreStatus: evaluation.scoreStatus,
      componentBasisPoints: evaluation.calculationReceipt.componentBasisPoints,
      scoreBasisPoints: evaluation.calculationReceipt.scoreBasisPoints,
    };
  });
  const complete = projection.filter(
    (candidate) => candidate.scoreStatus === "complete",
  );
  if (complete.length === 0) {
    const allUnavailable = projection.every(
      (candidate) => candidate.scoreStatus === "unavailable",
    );
    return KeywordSelectorInputSchema.parse({
      candidates: projection,
      selectionMode: "x_fallback_degraded",
      warningCodes: [
        allUnavailable
          ? "google_explore_all_unavailable"
          : "google_explore_no_complete_score",
      ],
    });
  }

  const sortedComplete = [...complete].sort(
    (left, right) =>
      (right.scoreBasisPoints ?? -Infinity) -
        (left.scoreBasisPoints ?? -Infinity) ||
      left.xRank - right.xRank ||
      left.candidateId.localeCompare(right.candidateId, "en"),
  );
  const completeIds = new Set(sortedComplete.map((candidate) => candidate.candidateId));
  const ordered = [
    ...sortedComplete,
    ...projection.filter((candidate) => !completeIds.has(candidate.candidateId)),
  ];
  return KeywordSelectorInputSchema.parse({
    candidates: ordered,
    selectionMode: "google_scored",
    warningCodes: projection.some((candidate) => candidate.scoreStatus === "partial")
      ? ["google_partial_secondary"]
      : [],
  });
}

export function validateKeywordSelection(
  selectionInput: KeywordSelection,
  selectorInput: KeywordSelectorInput,
): KeywordSelection {
  const selection = KeywordSelectionSchema.parse(selectionInput);
  const input = KeywordSelectorInputSchema.parse(selectorInput);
  if (selection.selectionMode !== input.selectionMode) {
    throw new Error("KeywordSelection mode가 selector input과 다릅니다.");
  }
  if (
    selection.warningCodes.length !== input.warningCodes.length ||
    selection.warningCodes.some((code, index) => code !== input.warningCodes[index])
  ) {
    throw new Error("KeywordSelection warningCodes가 selector input과 다릅니다.");
  }

  const candidateIds = new Set(
    input.candidates.map((candidate) => candidate.candidateId),
  );
  const selectedIds = [
    selection.targetCandidateId,
    ...selection.secondaryCandidateIds,
  ];
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((candidateId) => !candidateIds.has(candidateId))
  ) {
    throw new Error("KeywordSelection ID는 distinct eligible 후보여야 합니다.");
  }
  if (input.selectionMode === "google_scored") {
    const target = input.candidates.find(
      (candidate) => candidate.candidateId === selection.targetCandidateId,
    );
    if (target?.scoreStatus !== "complete") {
      throw new Error("Google-scored target은 complete evaluation이어야 합니다.");
    }
  }
  if (
    selection.duplicateIntentCandidateIds.some(
      (candidateId) => !selectedIds.includes(candidateId),
    )
  ) {
    throw new Error("duplicate intent ID는 선택된 후보 안에 있어야 합니다.");
  }
  return selection;
}

export function assembleContentBrief(
  selectionInput: KeywordSelection,
  selectorInput: KeywordSelectorInput,
): ContentBrief {
  const selection = validateKeywordSelection(selectionInput, selectorInput);
  const labels = new Map(
    selectorInput.candidates.map((candidate) => [
      candidate.candidateId,
      candidate.label,
    ]),
  );
  const selectionSha256 = sha256Canonical(selection);
  return ContentBriefSchema.parse({
    schemaVersion: "1.0",
    primaryKeyword: labels.get(selection.targetCandidateId),
    secondaryKeywords: selection.secondaryCandidateIds.map((candidateId) =>
      labels.get(candidateId),
    ),
    articleIntent: selection.articleIntent,
    coverage: selection.coverage,
    keywordSelectionSha256: selectionSha256,
  });
}
