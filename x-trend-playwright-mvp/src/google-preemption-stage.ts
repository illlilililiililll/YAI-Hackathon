import type {
  GoogleExploreBatch,
  GoogleIntentDecision,
  GooglePreemptionEvaluation,
} from "./content-domain.js";
import { scoreGooglePreemption } from "./google-preemption-scorer-v1.js";
import { validateGoogleExploreBatch } from "./google-trends-observation-port.js";
import {
  buildKeywordSelectorInput,
  type KeywordSelectorInput,
} from "./keyword-selector.js";

export type GoogleIntentResolutionInput = {
  candidateId: string;
  ambiguityReasonCode: "non_korean" | "polysemous";
  llmIntentDecision?: GoogleIntentDecision;
};

export type GooglePreemptionStageResult = {
  batchStatus: GoogleExploreBatch["status"];
  evaluations: GooglePreemptionEvaluation[];
  selectorInput: KeywordSelectorInput;
};

export function evaluateGooglePreemptionStage(
  batchInput: GoogleExploreBatch,
  intentInputs: GoogleIntentResolutionInput[] = [],
): GooglePreemptionStageResult {
  const batch = validateGoogleExploreBatch(
    batchInput,
    batchInput.requestedCandidates,
    batchInput.config,
  );
  const candidateIds = new Set(
    batch.requestedCandidates.map((candidate) => candidate.candidateId),
  );
  const resolutionByCandidateId = new Map<string, GoogleIntentResolutionInput>();
  for (const resolution of intentInputs) {
    if (
      !candidateIds.has(resolution.candidateId) ||
      resolutionByCandidateId.has(resolution.candidateId)
    ) {
      throw new Error(
        "Google intent resolution은 현재 Run 후보마다 최대 하나여야 합니다.",
      );
    }
    resolutionByCandidateId.set(resolution.candidateId, resolution);
  }

  const evaluations = batch.observations.map((observation) => {
    const resolution = resolutionByCandidateId.get(observation.candidateId);
    return scoreGooglePreemption({
      observation,
      ambiguityReasonCode: resolution?.ambiguityReasonCode,
      llmIntentDecision: resolution?.llmIntentDecision,
    });
  });
  return {
    batchStatus: batch.status,
    evaluations,
    selectorInput: buildKeywordSelectorInput(
      batch.requestedCandidates,
      evaluations,
    ),
  };
}
