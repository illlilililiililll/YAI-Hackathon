import {
  GoogleExploreObservationSchema,
  GooglePreemptionEvaluationSchema,
  type GoogleExploreObservation,
  type GoogleIntentDecision,
  type GooglePreemptionEvaluation,
  type GoogleRelatedQueryRow,
  type GoogleScoreReasonCode,
} from "./content-domain.js";
import { sha256Canonical } from "./canonical-json.js";

const INTENT_PATTERNS = [
  "추천",
  "비교",
  "방법",
  "가는 법",
  "일정",
  "코스",
  "비용",
  "가격",
  "예산",
  "준비물",
  "체크리스트",
  "숙소",
  "호텔",
  "교통",
  "이동",
  "예약",
  "맛집",
] as const;

const GOOGLE_PREEMPTION_POLICY_V1 = {
  calculationVersion: "google-preemption-v1",
  componentScale: 10_000,
  weights: { rising: 4_000, trend: -2_500, cluster: -2_000, intent: -1_500 },
  risingPercentCapBasisPoints: 50_000,
  trendWindowSeconds: 86_400,
  trendMinimumPoints: 6,
  trendMinimumSpanSeconds: 21_600,
  trendNormalization: "clamp((delta24+100)/200,0,1)",
  clusterDivisor: 5,
  intentExplicitBasisPoints: 10_000,
  intentAbsentBasisPoints: 4_000,
  rounding: "half-away-from-zero",
} as const;

type ScoreComponent = GooglePreemptionEvaluation[
  "rising" | "trend" | "cluster" | "intent"
];

export type ScoreGooglePreemptionInput = {
  observation: GoogleExploreObservation;
  ambiguityReasonCode?: "non_korean" | "polysemous";
  llmIntentDecision?: GoogleIntentDecision;
};

function roundRationalHalfAwayFromZero(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n) {
    throw new Error("분모는 양수여야 합니다.");
  }

  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return sign * rounded;
}

function component(
  basisPoints: number | null,
  reasonCode: GoogleScoreReasonCode,
): ScoreComponent {
  return {
    basisPoints,
    value: basisPoints === null ? null : basisPoints / 10_000,
    reasonCode,
  };
}

function unavailableReasons(
  observation: GoogleExploreObservation,
): GooglePreemptionEvaluation["risingRaw"] {
  const reasons = [
    observation.relatedQueries.rising,
    observation.relatedQueries.top,
  ]
    .filter((capture) => capture.state === "unavailable")
    .map((capture) => capture.reasonCode);

  return { source: "unavailable", reasonCodes: reasons };
}

function scoreRising(observation: GoogleExploreObservation): {
  score: ScoreComponent;
  raw: GooglePreemptionEvaluation["risingRaw"];
} {
  const { rising, top } = observation.relatedQueries;
  if (rising.state === "unavailable" || top.state === "unavailable") {
    return {
      score: component(null, "rising_unavailable"),
      raw: unavailableReasons(observation),
    };
  }

  const breakout = rising.value.find(
    (row) => row.risingValue?.kind === "breakout",
  );
  if (breakout) {
    return {
      score: component(10_000, "rising_breakout"),
      raw: { source: "rising", row: breakout },
    };
  }

  let best: GoogleRelatedQueryRow | undefined;
  let bestPercent = -1;
  for (const row of rising.value) {
    if (row.risingValue?.kind !== "percent") {
      continue;
    }
    if (row.risingValue.percentBasisPoints > bestPercent) {
      best = row;
      bestPercent = row.risingValue.percentBasisPoints;
    }
  }

  if (best) {
    const score = Number(
      roundRationalHalfAwayFromZero(
        BigInt(Math.min(bestPercent, 50_000)) * 10_000n,
        50_000n,
      ),
    );
    return {
      score: component(score, "rising_percent"),
      raw: { source: "rising", row: best },
    };
  }

  if (rising.value.length > 0) {
    return {
      score: component(null, "rising_unavailable"),
      raw: {
        source: "unavailable",
        reasonCodes: ["schema_changed"],
      },
    };
  }

  if (top.value.length > 0) {
    return {
      score: component(3_000, "rising_top_only"),
      raw: { source: "top_only", topDisplayedCount: top.value.length },
    };
  }

  return {
    score: component(0, "rising_observed_empty"),
    raw: { source: "observed_empty" },
  };
}

function scoreTrend(observation: GoogleExploreObservation): ScoreComponent {
  if (observation.interestOverTime.state === "unavailable") {
    return component(null, "trend_unavailable");
  }

  const points = observation.interestOverTime.value;
  const firstPartial = points.findIndex((point) => point.isPartial);
  if (
    firstPartial >= 0 &&
    points.slice(firstPartial).some((point) => !point.isPartial)
  ) {
    return component(null, "trend_invalid_csv");
  }

  const complete = firstPartial < 0 ? points : points.slice(0, firstPartial);
  const parsed = complete.map((point) => ({
    seconds: Date.parse(point.observedAt) / 1_000,
    value: point.value,
  }));

  if (
    parsed.some(
      (point, index) =>
        !Number.isSafeInteger(point.seconds) ||
        (index > 0 && point.seconds <= (parsed[index - 1]?.seconds ?? 0)),
    )
  ) {
    return component(null, "trend_invalid_csv");
  }

  const last = parsed.at(-1);
  if (!last) {
    return component(null, "trend_insufficient_points");
  }

  const window = parsed.filter(
    (point) =>
      point.seconds > last.seconds - 86_400 && point.seconds <= last.seconds,
  );
  const first = window[0];
  if (
    !first ||
    window.length < 6 ||
    last.seconds - first.seconds < 21_600
  ) {
    return component(null, "trend_insufficient_points");
  }

  if (window.every((point) => point.value === 0)) {
    return component(0, "trend_all_zero");
  }

  const x = window.map((point) => BigInt(point.seconds - first.seconds));
  const y = window.map((point) => BigInt(point.value));
  const n = BigInt(window.length);
  const sumX = x.reduce((sum, value) => sum + value, 0n);
  const sumY = y.reduce((sum, value) => sum + value, 0n);
  const sumXY = x.reduce((sum, value, index) => sum + value * (y[index] ?? 0n), 0n);
  const sumXX = x.reduce((sum, value) => sum + value * value, 0n);
  const slopeNumerator = n * sumXY - sumX * sumY;
  const slopeDenominator = n * sumXX - sumX * sumX;
  if (slopeDenominator <= 0n) {
    return component(null, "trend_insufficient_points");
  }

  const deltaNumerator = slopeNumerator * 86_400n;
  const normalizedNumerator = deltaNumerator + 100n * slopeDenominator;
  const normalizedDenominator = 200n * slopeDenominator;
  if (normalizedNumerator <= 0n) {
    return component(0, "trend_ols_24h");
  }
  if (normalizedNumerator >= normalizedDenominator) {
    return component(10_000, "trend_ols_24h");
  }

  return component(
    Number(
      roundRationalHalfAwayFromZero(
        normalizedNumerator * 10_000n,
        normalizedDenominator,
      ),
    ),
    "trend_ols_24h",
  );
}

function scoreCluster(observation: GoogleExploreObservation): ScoreComponent {
  const { top, rising } = observation.relatedTopics;
  if (top.state === "unavailable" || rising.state === "unavailable") {
    return component(null, "cluster_unavailable");
  }

  const labels = new Set<string>();
  for (const row of [...top.value, ...rising.value]) {
    labels.add(
      row.label.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " "),
    );
  }

  if (labels.size === 0) {
    return component(0, "cluster_observed_empty");
  }

  return component(Math.min(labels.size * 2_000, 10_000), "cluster_topics");
}

function intentDecisionHash(
  decision: Omit<GoogleIntentDecision, "outputSha256">,
): string {
  return sha256Canonical(decision);
}

function scoreIntent(
  label: string,
  ambiguityReasonCode: ScoreGooglePreemptionInput["ambiguityReasonCode"],
  llmDecision: GoogleIntentDecision | undefined,
): { score: ScoreComponent; decision: GoogleIntentDecision | null } {
  const normalized = label
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, " ");
  const matchedPattern = INTENT_PATTERNS.find((pattern) =>
    normalized.includes(pattern),
  );
  if (matchedPattern) {
    const base = {
      mode: "deterministic" as const,
      classification: "explicit" as const,
      matchedPattern,
      ambiguityReasonCode: null,
      openAiResponseId: null,
    };
    return {
      score: component(10_000, "intent_pattern_explicit"),
      decision: { ...base, outputSha256: intentDecisionHash(base) },
    };
  }

  const ambiguity =
    ambiguityReasonCode ?? (/\p{Script=Hangul}/u.test(normalized) ? undefined : "non_korean");
  if (!ambiguity) {
    const base = {
      mode: "deterministic" as const,
      classification: "absent" as const,
      matchedPattern: null,
      ambiguityReasonCode: null,
      openAiResponseId: null,
    };
    return {
      score: component(4_000, "intent_pattern_absent"),
      decision: { ...base, outputSha256: intentDecisionHash(base) },
    };
  }

  if (
    !llmDecision ||
    llmDecision.mode !== "llm_ambiguous" ||
    llmDecision.ambiguityReasonCode !== ambiguity
  ) {
    return { score: component(null, "intent_llm_required"), decision: null };
  }

  return {
    score: component(
      llmDecision.classification === "explicit" ? 10_000 : 4_000,
      llmDecision.classification === "explicit"
        ? "intent_llm_explicit"
        : "intent_llm_absent",
    ),
    decision: llmDecision,
  };
}

export function scoreGooglePreemption(
  input: ScoreGooglePreemptionInput,
): GooglePreemptionEvaluation {
  const observation = GoogleExploreObservationSchema.parse(input.observation);
  const risingResult = scoreRising(observation);
  const trend = scoreTrend(observation);
  const cluster = scoreCluster(observation);
  const intentResult = scoreIntent(
    observation.query,
    input.ambiguityReasonCode,
    input.llmIntentDecision,
  );

  const basisPoints = {
    rising: risingResult.score.basisPoints,
    trend: trend.basisPoints,
    cluster: cluster.basisPoints,
    intent: intentResult.score.basisPoints,
  };
  const reasonCodes = {
    rising: risingResult.score.reasonCode,
    trend: trend.reasonCode,
    cluster: cluster.reasonCode,
    intent: intentResult.score.reasonCode,
  };

  const googleUnavailable =
    basisPoints.rising === null &&
    basisPoints.trend === null &&
    basisPoints.cluster === null;
  const allNumeric = Object.values(basisPoints).every((value) => value !== null);
  const scoreStatus = googleUnavailable
    ? "unavailable"
    : allNumeric
      ? "complete"
      : "partial";

  let scoreBasisPoints: number | null = null;
  if (allNumeric) {
    const weighted =
      4_000 * (basisPoints.rising ?? 0) -
      2_500 * (basisPoints.trend ?? 0) -
      2_000 * (basisPoints.cluster ?? 0) -
      1_500 * (basisPoints.intent ?? 0);
    scoreBasisPoints = Number(
      roundRationalHalfAwayFromZero(BigInt(weighted), 10_000n),
    );
  }

  const receiptInput = {
    candidateId: observation.candidateId,
    query: observation.query,
    relatedQueries: observation.relatedQueries,
    relatedTopics: observation.relatedTopics,
    interestOverTime: observation.interestOverTime,
    rawArtifactRefs: observation.rawArtifactRefs,
    intentDecision: intentResult.decision,
  };
  const receiptOutput = { componentBasisPoints: basisPoints, scoreBasisPoints, reasonCodes };
  const receiptWithoutSelf = {
    calculationVersion: "google-preemption-v1" as const,
    inputSha256: sha256Canonical(receiptInput),
    policySha256: sha256Canonical(GOOGLE_PREEMPTION_POLICY_V1),
    componentBasisPoints: basisPoints,
    reasonCodes,
    scoreBasisPoints,
    outputSha256: sha256Canonical(receiptOutput),
  };

  return GooglePreemptionEvaluationSchema.parse({
    candidateId: observation.candidateId,
    rising: risingResult.score,
    trend,
    cluster,
    intent: intentResult.score,
    preemptionScore:
      scoreBasisPoints === null ? null : scoreBasisPoints / 10_000,
    risingRaw: risingResult.raw,
    interestOverTime:
      observation.interestOverTime.state === "available"
        ? observation.interestOverTime.value
        : null,
    relatedQueries: observation.relatedQueries,
    relatedTopics: observation.relatedTopics,
    scoreStatus,
    calculationVersion: "google-preemption-v1",
    rawArtifactRefs: observation.rawArtifactRefs,
    intentDecision: intentResult.decision,
    calculationReceipt: {
      ...receiptWithoutSelf,
      receiptSha256: sha256Canonical(receiptWithoutSelf),
    },
  });
}

export const GOOGLE_PREEMPTION_POLICY_SHA256 = sha256Canonical(
  GOOGLE_PREEMPTION_POLICY_V1,
);
