import { randomUUID } from "node:crypto";

import {
  TopicCandidateV1Schema,
  XSignalBatchSchema,
  type ProviderMode,
  type TopicCandidateV1,
  type XSignal,
  type XSignalBatch,
} from "./content-domain.js";

const GENERIC_TERMS = new Set([
  "여행",
  "추천",
  "정보",
  "후기",
  "오늘",
  "진짜",
  "이번",
  "관련",
  "travel",
  "trip",
  "the",
  "and",
  "with",
]);

export function normalizeSeedKeyword(input: string): string {
  const normalized = input.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized) {
    throw new Error("키워드는 비어 있을 수 없습니다.");
  }
  return normalized;
}

export function expandTravelQueries(seedInput: string, max = 2): string[] {
  const seed = normalizeSeedKeyword(seedInput);
  const planned = [seed, `${seed} 추천`, `${seed} 일정`];
  return [...new Set(planned)].slice(0, Math.max(1, Math.min(max, 3)));
}

function normalizedCandidate(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^#+/u, "")
    .replace(/[_-]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function candidateLabels(signal: XSignal): string[] {
  const labels: string[] = [];
  for (const match of signal.text.matchAll(/#([\p{L}\p{N}_-]{2,30})/gu)) {
    const label = normalizedCandidate(match[1] ?? "");
    if (label) labels.push(label);
  }
  const withoutUrls = signal.text.replace(/https?:\/\/\S+/giu, " ");
  for (const match of withoutUrls.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,19}/gu)) {
    const label = normalizedCandidate(match[0]);
    if (
      label.length >= 2 &&
      label.length <= 20 &&
      !GENERIC_TERMS.has(label.toLocaleLowerCase("en-US"))
    ) {
      labels.push(label);
    }
  }
  return [...new Set(labels)];
}

function recencyScore(signals: XSignal[]): number {
  const now = Date.now();
  const observed = signals
    .map((signal) => Date.parse(signal.visibleTimestamp ?? ""))
    .filter(Number.isFinite);
  if (observed.length === 0) return 0.5;
  const newest = Math.max(...observed);
  const ageHours = Math.max(0, (now - newest) / 3_600_000);
  return Math.max(0, Math.min(1, 1 - ageHours / (24 * 7)));
}

export function clusterTopicCandidates(
  batchInput: XSignalBatch,
  seedInput: string,
  provenanceMode: ProviderMode,
  maxCandidates = 5,
): TopicCandidateV1[] {
  const batch = XSignalBatchSchema.parse(batchInput);
  const seed = normalizeSeedKeyword(seedInput).toLocaleLowerCase("en-US");
  const byLabel = new Map<string, XSignal[]>();
  for (const signal of batch.dedupedSignals) {
    for (const label of candidateLabels(signal)) {
      const key = label.toLocaleLowerCase("en-US");
      const current = byLabel.get(key) ?? [];
      current.push(signal);
      byLabel.set(key, current);
    }
  }

  return [...byLabel.entries()]
    .map(([key, signals]) => {
      const uniqueSignals = [...new Map(signals.map((signal) => [signal.signalId, signal])).values()];
      const independentKeys = new Set(
        uniqueSignals.map((signal) => signal.authorKey ?? signal.canonicalUrl ?? signal.signalId),
      );
      const matchedQueries = new Set(uniqueSignals.flatMap((signal) => signal.matchedQueries));
      const seedRelevance = key.includes(seed) || seed.includes(key) ? 1 : 0.65;
      const independentRecurrence = Math.min(1, independentKeys.size / 3);
      const recency = recencyScore(uniqueSignals);
      const querySpread = Math.min(1, matchedQueries.size / batch.plannedQueries.length);
      const xSignalScore =
        seedRelevance * 0.35 +
        independentRecurrence * 0.3 +
        recency * 0.15 +
        querySpread * 0.2;
      return TopicCandidateV1Schema.parse({
        candidateId: `candidate_${randomUUID()}`,
        label: normalizedCandidate(uniqueSignals[0]?.text.match(new RegExp(`(?:#)?${key}`, "iu"))?.[0] ?? key),
        aliases: [],
        signalIds: uniqueSignals.map((signal) => signal.signalId),
        score: {
          seedRelevance,
          independentRecurrence,
          recency,
          querySpread,
          xSignalScore,
        },
        eligibility: "eligible",
        reasonCode: null,
        provenanceMode,
      });
    })
    .sort(
      (left, right) =>
        right.score.xSignalScore - left.score.xSignalScore ||
        right.signalIds.length - left.signalIds.length ||
        left.label.localeCompare(right.label, "ko"),
    )
    .slice(0, Math.max(1, Math.min(maxCandidates, 5)));
}

export function requireViableCandidates(
  candidates: TopicCandidateV1[],
): [TopicCandidateV1, TopicCandidateV1, TopicCandidateV1, TopicCandidateV1, ...TopicCandidateV1[]] {
  if (candidates.length < 4) {
    throw new Error("no_viable_topic: 근거가 있는 후보가 4개 미만입니다.");
  }
  return candidates as [TopicCandidateV1, TopicCandidateV1, TopicCandidateV1, TopicCandidateV1, ...TopicCandidateV1[]];
}
