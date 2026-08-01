import {
  GoogleCandidateSchema,
  GoogleExploreBatchSchema,
  GoogleExploreConfigSchema,
  type GoogleCandidate,
  type GoogleExploreBatch,
  type GoogleExploreConfig,
} from "./content-domain.js";

export type CollectGoogleTrendsInput = {
  runId: string;
  parentToolCallId: string;
  candidates: GoogleCandidate[];
  config: GoogleExploreConfig;
  signal?: AbortSignal;
};

export interface GoogleTrendsObservationPort {
  readonly adapter: "playwright" | "official_api_mcp";
  collect(input: CollectGoogleTrendsInput): Promise<GoogleExploreBatch>;
}

export function buildGoogleExploreUrl(
  candidatesInput: GoogleCandidate[],
  configInput: GoogleExploreConfig,
): string {
  const config = GoogleExploreConfigSchema.parse(configInput);
  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  if (candidates.length < 4 || candidates.length > config.candidateMax) {
    throw new Error("Google Trends Explore 후보는 4..5개여야 합니다.");
  }
  if (
    new Set(candidates.map((candidate) => candidate.candidateId)).size !==
      candidates.length ||
    new Set(candidates.map((candidate) => candidate.label)).size !==
      candidates.length
  ) {
    throw new Error("Google Trends 후보 ID와 label은 각각 고유해야 합니다.");
  }

  const url = new URL("https://trends.google.com/trends/explore");
  url.searchParams.set("hl", config.uiLanguage);
  url.searchParams.set("date", config.timeRange);
  url.searchParams.set("geo", config.geo);
  url.searchParams.set("cat", String(config.category));
  url.searchParams.set(
    "q",
    candidates.map((candidate) => candidate.label).join(","),
  );
  return url.toString();
}

function sameCandidate(
  left: GoogleCandidate | undefined,
  right: GoogleCandidate | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.candidateId === right.candidateId &&
    left.label === right.label
  );
}

export function validateGoogleExploreBatch(
  batchInput: GoogleExploreBatch,
  requestedCandidatesInput: GoogleCandidate[],
  configInput: GoogleExploreConfig,
): GoogleExploreBatch {
  const batch = GoogleExploreBatchSchema.parse(batchInput);
  const requestedCandidates = requestedCandidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  const config = GoogleExploreConfigSchema.parse(configInput);

  if (JSON.stringify(batch.config) !== JSON.stringify(config)) {
    throw new Error("Google Explore batch config가 ConfigSnapshot과 다릅니다.");
  }
  if (
    batch.requestedCandidates.length !== requestedCandidates.length ||
    batch.requestedCandidates.some(
      (candidate, index) =>
        !sameCandidate(candidate, requestedCandidates[index]),
    )
  ) {
    throw new Error("Google Explore requestedCandidates 순서가 호출 인자와 다릅니다.");
  }
  if (
    batch.observations.length !== requestedCandidates.length ||
    batch.observations.some((observation, index) => {
      const candidate = requestedCandidates[index];
      return (
        candidate === undefined ||
        observation.candidateId !== candidate.candidateId ||
        observation.query !== candidate.label
      );
    })
  ) {
    throw new Error("Google Explore observation 순서가 요청 후보와 다릅니다.");
  }

  const interestStates = new Set(
    batch.observations.map((observation) => observation.interestOverTime.state),
  );
  if (interestStates.size !== 1) {
    throw new Error("Shared Interest CSV 상태는 모든 후보에서 같아야 합니다.");
  }
  const interestAvailable = interestStates.has("available");
  const expectedArtifactKinds = interestAvailable
    ? ["screen_extraction", "interest_over_time_csv"]
    : ["screen_extraction"];
  if (
    batch.rawArtifacts.length !== expectedArtifactKinds.length ||
    batch.rawArtifacts.some(
      (artifact, index) => artifact.kind !== expectedArtifactKinds[index],
    )
  ) {
    throw new Error("Google raw artifact cardinality/order가 계약과 다릅니다.");
  }

  for (const artifact of batch.rawArtifacts) {
    if (
      artifact.candidateIds.length !== requestedCandidates.length ||
      artifact.candidateIds.some(
        (candidateId, index) =>
          candidateId !== requestedCandidates[index]?.candidateId,
      )
    ) {
      throw new Error("Google raw artifact candidateIds 순서가 다릅니다.");
    }
  }

  const expectedRefs = batch.rawArtifacts.map((artifact, index) => ({
    artifactId: artifact.artifactId,
    jsonPointer: `/rawArtifacts/${index}`,
    sha256: artifact.sha256,
  }));
  for (const observation of batch.observations) {
    if (
      observation.rawArtifactRefs.length !== expectedRefs.length ||
      observation.rawArtifactRefs.some((reference, index) => {
        const expected = expectedRefs[index];
        return (
          expected === undefined ||
          reference.artifactId !== expected.artifactId ||
          reference.jsonPointer !== expected.jsonPointer ||
          reference.sha256 !== expected.sha256
        );
      })
    ) {
      throw new Error("Google observation raw artifact ref가 닫힌 순서와 다릅니다.");
    }
  }

  const captures = batch.observations.flatMap((observation) => [
    observation.relatedQueries.top,
    observation.relatedQueries.rising,
    observation.relatedTopics.top,
    observation.relatedTopics.rising,
    observation.interestOverTime,
  ]);
  const derivedStatus = captures.every((capture) => capture.state === "available")
    ? "complete"
    : captures.every((capture) => capture.state === "unavailable")
      ? "unavailable"
      : "partial";
  if (batch.status !== derivedStatus) {
    throw new Error("Google Explore batch status가 capture 상태와 다릅니다.");
  }

  return batch;
}
