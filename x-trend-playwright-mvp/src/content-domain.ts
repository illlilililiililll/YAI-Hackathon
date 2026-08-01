import { z } from "zod";

export const GoogleExploreConfigSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  geo: z.literal("KR"),
  timeRange: z.literal("now 7-d"),
  searchType: z.literal("web"),
  category: z.literal(0),
  browserTimeZone: z.literal("Asia/Seoul"),
  uiLanguage: z.literal("en"),
  comparisonType: z.literal("search_terms"),
  candidateMax: z.literal(5),
  calculationVersion: z.literal("google-preemption-v1"),
});

export type GoogleExploreConfig = z.infer<typeof GoogleExploreConfigSchema>;

export const DEFAULT_GOOGLE_EXPLORE_CONFIG: GoogleExploreConfig = {
  schemaVersion: "1.0",
  geo: "KR",
  timeRange: "now 7-d",
  searchType: "web",
  category: 0,
  browserTimeZone: "Asia/Seoul",
  uiLanguage: "en",
  comparisonType: "search_terms",
  candidateMax: 5,
  calculationVersion: "google-preemption-v1",
};

export const GoogleCandidateSchema = z.strictObject({
  candidateId: z.string().trim().min(1),
  label: z.string().trim().min(1),
});

export type GoogleCandidate = z.infer<typeof GoogleCandidateSchema>;

export const GoogleUnavailableCodeSchema = z.enum([
  "consent_required",
  "auth_required",
  "challenge_or_blocked",
  "rate_limited",
  "timeout",
  "navigation_failed",
  "download_failed",
  "schema_changed",
]);

export type GoogleUnavailableCode = z.infer<
  typeof GoogleUnavailableCodeSchema
>;

export const GoogleRisingValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("breakout"),
    lowerBoundExclusivePercent: z.literal(5000),
    rawText: z.literal("Breakout"),
  }),
  z.strictObject({
    kind: z.literal("percent"),
    percentBasisPoints: z.number().int().nonnegative(),
    rawText: z.string().trim().min(1),
  }),
]);

export const GoogleRelatedQueryRowSchema = z.strictObject({
  label: z.string().trim().min(1),
  rank: z.number().int().positive(),
  displayedValue: z.string(),
  risingValue: GoogleRisingValueSchema.nullable(),
});

export type GoogleRelatedQueryRow = z.infer<
  typeof GoogleRelatedQueryRowSchema
>;

export const GoogleRelatedTopicRowSchema = z.strictObject({
  label: z.string().trim().min(1),
  topicType: z.string().trim().min(1).nullable(),
  rank: z.number().int().positive(),
  displayedValue: z.string(),
});

export type GoogleRelatedTopicRow = z.infer<
  typeof GoogleRelatedTopicRowSchema
>;

export const GoogleInterestPointSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  value: z.number().int().min(0).max(100),
  isPartial: z.boolean(),
});

export type GoogleInterestPoint = z.infer<typeof GoogleInterestPointSchema>;

const unavailableCaptureSchema = z.strictObject({
  state: z.literal("unavailable"),
  value: z.null(),
  reasonCode: GoogleUnavailableCodeSchema,
});

export const GoogleRelatedQueryCaptureSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    value: z.array(GoogleRelatedQueryRowSchema),
  }),
  unavailableCaptureSchema,
]);

export const GoogleRelatedTopicCaptureSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    value: z.array(GoogleRelatedTopicRowSchema),
  }),
  unavailableCaptureSchema,
]);

export const GoogleInterestCaptureSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    value: z.array(GoogleInterestPointSchema),
  }),
  unavailableCaptureSchema,
]);

export type GoogleRelatedQueryCapture = z.infer<
  typeof GoogleRelatedQueryCaptureSchema
>;
export type GoogleRelatedTopicCapture = z.infer<
  typeof GoogleRelatedTopicCaptureSchema
>;
export type GoogleInterestCapture = z.infer<
  typeof GoogleInterestCaptureSchema
>;

export const GoogleRawArtifactRefSchema = z.strictObject({
  artifactId: z.string().trim().min(1),
  jsonPointer: z.string().startsWith("/"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type GoogleRawArtifactRef = z.infer<typeof GoogleRawArtifactRefSchema>;

export const GoogleExploreObservationSchema = z.strictObject({
  candidateId: z.string().trim().min(1),
  query: z.string().trim().min(1),
  exploreUrl: z.url(),
  checkedAt: z.iso.datetime(),
  relatedQueries: z.strictObject({
    top: GoogleRelatedQueryCaptureSchema,
    rising: GoogleRelatedQueryCaptureSchema,
  }),
  relatedTopics: z.strictObject({
    top: GoogleRelatedTopicCaptureSchema,
    rising: GoogleRelatedTopicCaptureSchema,
  }),
  interestOverTime: GoogleInterestCaptureSchema,
  rawArtifactRefs: z.array(GoogleRawArtifactRefSchema),
  warningCodes: z.array(z.string().trim().min(1)),
});

export type GoogleExploreObservation = z.infer<
  typeof GoogleExploreObservationSchema
>;

export const GoogleTrendsRawArtifactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    artifactId: z.string().trim().min(1),
    kind: z.literal("interest_over_time_csv"),
    candidateIds: z.array(z.string().trim().min(1)).min(1),
    exploreUrl: z.url(),
    collectedAt: z.iso.datetime(),
    configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mediaType: z.literal("text/csv"),
    suggestedFilename: z.string().trim().min(1),
    rawBytesBase64: z.base64(),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    downloadReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    artifactId: z.string().trim().min(1),
    kind: z.literal("screen_extraction"),
    candidateIds: z.array(z.string().trim().min(1)).min(1),
    exploreUrl: z.url(),
    collectedAt: z.iso.datetime(),
    configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    extraction: z.unknown(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    extractorReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

export type GoogleTrendsRawArtifact = z.infer<
  typeof GoogleTrendsRawArtifactSchema
>;

export const GoogleExploreBatchSchema = z.strictObject({
  config: GoogleExploreConfigSchema,
  requestedCandidates: z.array(GoogleCandidateSchema).min(1).max(5),
  observations: z.array(GoogleExploreObservationSchema).min(1).max(5),
  rawArtifacts: z.array(GoogleTrendsRawArtifactSchema),
  status: z.enum(["complete", "partial", "unavailable"]),
});

export type GoogleExploreBatch = z.infer<typeof GoogleExploreBatchSchema>;

export const GoogleIntentDecisionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("deterministic"),
    classification: z.enum(["explicit", "absent"]),
    matchedPattern: z.string().min(1).nullable(),
    ambiguityReasonCode: z.null(),
    openAiResponseId: z.null(),
    outputSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    mode: z.literal("llm_ambiguous"),
    classification: z.enum(["explicit", "absent"]),
    matchedPattern: z.null(),
    ambiguityReasonCode: z.enum(["non_korean", "polysemous"]),
    openAiResponseId: z.string().trim().min(1),
    outputSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    decisionReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

export type GoogleIntentDecision = z.infer<typeof GoogleIntentDecisionSchema>;

export const GoogleScoreReasonCodeSchema = z.enum([
  "rising_breakout",
  "rising_percent",
  "rising_top_only",
  "rising_observed_empty",
  "rising_unavailable",
  "trend_ols_24h",
  "trend_all_zero",
  "trend_insufficient_points",
  "trend_invalid_csv",
  "trend_unavailable",
  "cluster_topics",
  "cluster_observed_empty",
  "cluster_unavailable",
  "intent_pattern_explicit",
  "intent_pattern_absent",
  "intent_llm_explicit",
  "intent_llm_absent",
  "intent_llm_required",
  "intent_llm_failed",
]);

export type GoogleScoreReasonCode = z.infer<
  typeof GoogleScoreReasonCodeSchema
>;

export const GoogleScoreComponentSchema = z.strictObject({
  basisPoints: z.number().int().min(0).max(10_000).nullable(),
  value: z.number().min(0).max(1).nullable(),
  reasonCode: GoogleScoreReasonCodeSchema,
});

export const GoogleRisingRawSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("rising"),
    row: GoogleRelatedQueryRowSchema,
  }),
  z.strictObject({
    source: z.literal("top_only"),
    topDisplayedCount: z.number().int().nonnegative(),
  }),
  z.strictObject({ source: z.literal("observed_empty") }),
  z.strictObject({
    source: z.literal("unavailable"),
    reasonCodes: z.array(GoogleUnavailableCodeSchema).min(1),
  }),
]);

export const GooglePreemptionEvaluationSchema = z.strictObject({
  candidateId: z.string().trim().min(1),
  rising: GoogleScoreComponentSchema,
  trend: GoogleScoreComponentSchema,
  cluster: GoogleScoreComponentSchema,
  intent: GoogleScoreComponentSchema,
  preemptionScore: z.number().min(-0.6).max(0.4).nullable(),
  risingRaw: GoogleRisingRawSchema,
  interestOverTime: z.array(GoogleInterestPointSchema).nullable(),
  relatedQueries: GoogleExploreObservationSchema.shape.relatedQueries,
  relatedTopics: GoogleExploreObservationSchema.shape.relatedTopics,
  scoreStatus: z.enum(["complete", "partial", "unavailable"]),
  calculationVersion: z.literal("google-preemption-v1"),
  rawArtifactRefs: z.array(GoogleRawArtifactRefSchema),
  intentDecision: GoogleIntentDecisionSchema.nullable(),
  calculationReceipt: z.strictObject({
    calculationVersion: z.literal("google-preemption-v1"),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    policySha256: z.string().regex(/^[0-9a-f]{64}$/u),
    componentBasisPoints: z.strictObject({
      rising: z.number().int().min(0).max(10_000).nullable(),
      trend: z.number().int().min(0).max(10_000).nullable(),
      cluster: z.number().int().min(0).max(10_000).nullable(),
      intent: z.number().int().min(0).max(10_000).nullable(),
    }),
    reasonCodes: z.strictObject({
      rising: GoogleScoreReasonCodeSchema,
      trend: GoogleScoreReasonCodeSchema,
      cluster: GoogleScoreReasonCodeSchema,
      intent: GoogleScoreReasonCodeSchema,
    }),
    scoreBasisPoints: z.number().int().min(-6_000).max(4_000).nullable(),
    outputSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    receiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});

export type GooglePreemptionEvaluation = z.infer<
  typeof GooglePreemptionEvaluationSchema
>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const NonEmptyIdSchema = z.string().min(1);
const DownloadReceiptHashesSchema = z
  .array(Sha256Schema)
  .max(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "download receipt hash는 고유해야 합니다.",
  });

/**
 * Provider selection is deliberately closed. A selected provider must be
 * registered; callers must never silently fall back to Playwright.
 */
export const SignalProviderSchema = z.enum(["playwright", "official_api_mcp"]);
export type SignalProvider = z.infer<typeof SignalProviderSchema>;

export const SignalProviderErrorSchema = z.strictObject({
  code: z.enum([
    "unsupported_provider",
    "invalid_input",
    "profile_in_use",
    "adapter_start_failed",
    "contract_violation",
    "aborted",
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type SignalProviderError = z.infer<typeof SignalProviderErrorSchema>;

export const XSignalSchema = z.strictObject({
  signalId: NonEmptyIdSchema,
  authorLabel: z.string().min(1).nullable(),
  authorKey: z.string().min(1).nullable(),
  text: z.string().min(1),
  canonicalUrl: z.url().nullable(),
  visibleTimestamp: z.string().min(1).nullable(),
  matchedQueries: z.array(z.string().min(1)).min(1).max(3),
  collectedAt: z.iso.datetime(),
});
export type XSignal = z.infer<typeof XSignalSchema>;

export const XQueryObservationSchema = z.strictObject({
  query: z.string().min(1),
  status: z.enum(["ok", "login_required", "blocked", "error"]),
  signals: z.array(XSignalSchema),
  attemptedAt: z.iso.datetime(),
  warningCode: z.string().min(1).nullable(),
});
export type XQueryObservation = z.infer<typeof XQueryObservationSchema>;

export const XSignalBatchSchema = z
  .strictObject({
    plannedQueries: z.array(z.string().min(1)).min(1).max(3),
    observations: z.array(XQueryObservationSchema).min(1).max(3),
    dedupedSignals: z.array(XSignalSchema),
    coverageRatio: z.number().min(0).max(1),
  })
  .superRefine((batch, context) => {
    if (
      batch.observations.length !== batch.plannedQueries.length ||
      batch.observations.some(
        (observation, index) => observation.query !== batch.plannedQueries[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["observations"],
        message: "X observations는 plannedQueries와 같은 순서여야 합니다.",
      });
    }
    const expectedCoverage =
      batch.observations.filter((observation) => observation.status === "ok")
        .length / batch.plannedQueries.length;
    if (Math.abs(batch.coverageRatio - expectedCoverage) > Number.EPSILON) {
      context.addIssue({
        code: "custom",
        path: ["coverageRatio"],
        message: "X coverageRatio는 ok observation 비율이어야 합니다.",
      });
    }
    batch.observations.forEach((observation, index) => {
      if (observation.status !== "ok" && observation.signals.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["observations", index, "signals"],
          message: "X non-ok observation은 signals를 포함할 수 없습니다.",
        });
      }
    });
    const signalIds = batch.dedupedSignals.map((signal) => signal.signalId);
    if (new Set(signalIds).size !== signalIds.length) {
      context.addIssue({
        code: "custom",
        path: ["dedupedSignals"],
        message: "X dedupedSignals의 signalId는 고유해야 합니다.",
      });
    }
  });
export type XSignalBatch = z.infer<typeof XSignalBatchSchema>;

export const BrowserSiteSchema = z.enum(["x", "google_trends"]);
export type BrowserSite = z.infer<typeof BrowserSiteSchema>;

export const BrowserMcpToolNameSchema = z.enum([
  "browser_navigate",
  "browser_wait_for",
  "browser_snapshot",
  "browser_click",
  "browser_evaluate",
  "browser_close",
]);
export type BrowserMcpToolName = z.infer<typeof BrowserMcpToolNameSchema>;

export const BrowserMcpArgumentsSchema = z.discriminatedUnion("toolName", [
  z.strictObject({
    toolName: z.literal("browser_navigate"),
    args: z.strictObject({ url: z.url() }),
  }),
  z.strictObject({
    toolName: z.literal("browser_wait_for"),
    args: z.strictObject({ time: z.number().nonnegative().max(30) }),
  }),
  z.strictObject({
    toolName: z.literal("browser_snapshot"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    toolName: z.literal("browser_click"),
    args: z.strictObject({
      target: z.string().min(1),
      element: z.string().min(1).optional(),
    }),
  }),
  z.strictObject({
    toolName: z.literal("browser_evaluate"),
    args: z.strictObject({ function: z.string().min(1) }),
  }),
  z.strictObject({
    toolName: z.literal("browser_close"),
    args: z.strictObject({}),
  }),
]);
export type BrowserMcpArguments = z.infer<typeof BrowserMcpArgumentsSchema>;

export const McpCallToolResultProjectionSchema = z.strictObject({
  isError: z.boolean(),
  content: z.array(
    z.strictObject({ type: z.literal("text"), text: z.string() }),
  ),
  structuredContent: z.unknown().nullable(),
});
export type McpCallToolResultProjection = z.infer<
  typeof McpCallToolResultProjectionSchema
>;

const BrowserOperationBaseSchema = z.strictObject({
  operationId: NonEmptyIdSchema,
  invocationId: NonEmptyIdSchema,
  parentToolCallId: NonEmptyIdSchema,
  leaseId: NonEmptyIdSchema,
  site: BrowserSiteSchema,
});

export const BrowserOperationSchema = z.discriminatedUnion("phase", [
  BrowserOperationBaseSchema.extend({
    phase: z.literal("call"),
    request: BrowserMcpArgumentsSchema,
    argsSha256: Sha256Schema,
  }),
  BrowserOperationBaseSchema.extend({
    phase: z.literal("result"),
    toolName: BrowserMcpToolNameSchema,
    result: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("mcp_result"),
        value: McpCallToolResultProjectionSchema,
      }),
      z.strictObject({
        kind: z.literal("runtime_error"),
        code: z.literal("mcp_call_failed"),
        message: z.string().min(1),
      }),
    ]),
    resultSha256: Sha256Schema,
  }),
]);
export type BrowserOperation = z.infer<typeof BrowserOperationSchema>;

export const BrowserOperationEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  runId: NonEmptyIdSchema,
  seq: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  provider: z.literal("playwright_mcp"),
  operation: BrowserOperationSchema,
});
export type BrowserOperationEnvelope = z.infer<
  typeof BrowserOperationEnvelopeSchema
>;

export const BrowserLeaseReceiptSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  leaseId: NonEmptyIdSchema,
  runId: NonEmptyIdSchema,
  mode: z.literal("live"),
  profile: BrowserSiteSchema,
  connectedAt: z.iso.datetime(),
  serverInfoSha256: Sha256Schema,
  nonceSha256: Sha256Schema,
});
export type BrowserLeaseReceipt = z.infer<typeof BrowserLeaseReceiptSchema>;

export const BrowserInvocationReceiptSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  runId: NonEmptyIdSchema,
  invocationId: NonEmptyIdSchema,
  parentToolCallId: NonEmptyIdSchema,
  leaseId: NonEmptyIdSchema,
  stage: z.enum(["collecting_x", "evaluating_google"]),
  requestSha256: Sha256Schema,
  resultSha256: Sha256Schema,
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
  operationCount: z.number().int().positive(),
  status: z.literal("completed"),
});
export type BrowserInvocationReceipt = z.infer<
  typeof BrowserInvocationReceiptSchema
>;

export const ExtractorReceiptSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  extractorId: z.enum([
    "x-signal-extractor-v1",
    "google-trends-explore-extractor-v1",
  ]),
  extractorBuildSha256: Sha256Schema,
  orderedOperationIds: z.array(NonEmptyIdSchema).min(1),
  operationResultsSha256: Sha256Schema,
  output: z.unknown(),
  outputSha256: Sha256Schema,
});
export type ExtractorReceipt = z.infer<typeof ExtractorReceiptSchema>;

export const WrapperCausalReceiptSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  parentToolCallId: NonEmptyIdSchema,
  leaseId: NonEmptyIdSchema,
  leaseReceiptSha256: Sha256Schema,
  invocationReceiptSha256: Sha256Schema,
  downloadReceiptSha256s: DownloadReceiptHashesSchema,
  extractorReceiptSha256: Sha256Schema,
  outputSha256: Sha256Schema,
  receiptSha256: Sha256Schema,
});
export type WrapperCausalReceipt = z.infer<typeof WrapperCausalReceiptSchema>;

export const ObservationAcquisitionReceiptSchema = z.discriminatedUnion(
  "adapter",
  [
    z.strictObject({
      adapter: z.literal("playwright"),
      wrapperCausalReceiptSha256: Sha256Schema,
      downloadReceiptSha256s: DownloadReceiptHashesSchema,
      receiptSha256: Sha256Schema,
    }),
    z.strictObject({
      adapter: z.literal("official_api_mcp"),
      providerContractVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
      providerReceiptSha256: Sha256Schema,
      receiptSha256: Sha256Schema,
    }),
  ],
);
export type ObservationAcquisitionReceipt = z.infer<
  typeof ObservationAcquisitionReceiptSchema
>;

export const XSignalCollectionResultSchema = z.strictObject({
  batch: XSignalBatchSchema,
  acquisition: ObservationAcquisitionReceiptSchema,
});
export type XSignalCollectionResult = z.infer<
  typeof XSignalCollectionResultSchema
>;

export const GoogleSignalCollectionResultSchema = z.strictObject({
  batch: GoogleExploreBatchSchema,
  acquisition: ObservationAcquisitionReceiptSchema,
});
export type GoogleSignalCollectionResult = z.infer<
  typeof GoogleSignalCollectionResultSchema
>;

// Article pipeline contracts. These schemas intentionally live beside the
// existing signal contracts so every stage validates the same wire shape.
export const ProviderModeSchema = z.enum(["live", "fixture", "replay", "mock"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const NormalizedRequestV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  domain: z.literal("travel"),
  locale: z.literal("ko-KR"),
  seedKeyword: z.string().min(1),
});
export type NormalizedRequestV1 = z.infer<typeof NormalizedRequestV1Schema>;

export const TopicCandidateV1Schema = z.strictObject({
  candidateId: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  signalIds: z.array(z.string().min(1)).min(1),
  score: z.strictObject({
    seedRelevance: z.number().min(0).max(1),
    independentRecurrence: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
    querySpread: z.number().min(0).max(1),
    xSignalScore: z.number().min(0).max(1),
  }),
  eligibility: z.enum(["eligible", "rejected"]),
  reasonCode: z.string().min(1).nullable(),
  provenanceMode: ProviderModeSchema,
});
export type TopicCandidateV1 = z.infer<typeof TopicCandidateV1Schema>;

export const ArticleIntentSchema = z.enum([
  "recommendation",
  "comparison",
  "how_to",
  "itinerary",
  "cost",
  "preparation",
  "lodging",
  "transport",
  "coherent_mixed",
]);

export const ContentBriefV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  primaryKeyword: z.string().trim().min(1),
  secondaryKeywords: z.array(z.string().trim().min(1)).min(3).max(5),
  articleIntent: ArticleIntentSchema,
  coverage: z.enum(["focused", "broad"]),
  keywordSelectionSha256: Sha256Schema,
});
export type ContentBriefV1 = z.infer<typeof ContentBriefV1Schema>;

export const SourceDiscoveryRefV1Schema = z.strictObject({
  webSearchCallId: NonEmptyIdSchema,
  rawEventSeq: z.number().int().positive(),
  semanticPayloadSha256: Sha256Schema,
  candidateUrl: z.url(),
});
export type SourceDiscoveryRefV1 = z.infer<
  typeof SourceDiscoveryRefV1Schema
>;

export const ExtractedBlockV1Schema = z.strictObject({
  blockId: z.string().min(1),
  domPath: z.string().min(1),
  tag: z.enum(["title", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd"]),
  text: z.string().min(1),
  textSha256: Sha256Schema,
});
export type ExtractedBlockV1 = z.infer<typeof ExtractedBlockV1Schema>;

export const EvidenceSpanV1Schema = z.strictObject({
  evidenceSpanId: z.string().min(1),
  fetchToolCallId: NonEmptyIdSchema,
  fetchResultSha256: Sha256Schema,
  blockId: z.string().min(1),
  startUtf8Byte: z.number().int().nonnegative(),
  endUtf8Byte: z.number().int().positive(),
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  retrievedAt: z.iso.datetime(),
  payloadSha256: Sha256Schema,
});
export type EvidenceSpanV1 = z.infer<typeof EvidenceSpanV1Schema>;

export const SourceSnapshotV1Schema = z.strictObject({
  sourceId: z.string().min(1),
  canonicalUrl: z.url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  tier: z.enum(["A", "B", "C"]),
  publishedAt: z.iso.datetime().nullable(),
  retrievedAt: z.iso.datetime(),
  spans: z.array(EvidenceSpanV1Schema).min(1),
  snapshotSha256: Sha256Schema,
  provenanceMode: ProviderModeSchema,
});
export type SourceSnapshotV1 = z.infer<typeof SourceSnapshotV1Schema>;

export const EvidenceLinkV1Schema = z.strictObject({
  sourceId: z.string().min(1),
  evidenceSpanId: z.string().min(1),
});
export type EvidenceLinkV1 = z.infer<typeof EvidenceLinkV1Schema>;

export const ClaimRecordV1Schema = z.strictObject({
  claimId: z.string().min(1),
  text: z.string().min(1),
  importance: z.enum(["core", "supporting"]),
  volatility: z.enum(["stable", "high"]),
  status: z.enum(["accepted", "qualified", "conflicted", "unsupported", "stale"]),
  qualification: z.string().min(1).nullable(),
  validAt: z.string().min(1).nullable(),
  riskDomain: z.enum(["none", "entry", "safety", "health"]),
  evidence: z.array(EvidenceLinkV1Schema),
  provenanceMode: ProviderModeSchema,
});
export type ClaimRecordV1 = z.infer<typeof ClaimRecordV1Schema>;

export const SourceLedgerEntryV1Schema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("admitted"), snapshot: SourceSnapshotV1Schema }),
  z.strictObject({
    status: z.literal("excluded"),
    candidateUrl: z.string().min(1),
    reasonCode: z.string().min(1),
    webSearchCallId: z.string().min(1).nullable(),
  }),
]);
export type SourceLedgerEntryV1 = z.infer<typeof SourceLedgerEntryV1Schema>;

export const EvidenceResearchResultV1Schema = z.strictObject({
  status: z.enum(["sufficient", "needs_evidence", "source_blocked"]),
  sources: z.array(SourceLedgerEntryV1Schema),
  claims: z.array(ClaimRecordV1Schema),
  attempts: z.number().int().min(1).max(2),
  warningCodes: z.array(z.string().min(1)),
});
export type EvidenceResearchResultV1 = z.infer<
  typeof EvidenceResearchResultV1Schema
>;

export const WriterSourceProjectionV1Schema = z.strictObject({
  sourceId: z.string().min(1),
  publisher: z.string().min(1),
  title: z.string().min(1),
  checkedAt: z.iso.datetime(),
});
export type WriterSourceProjectionV1 = z.infer<
  typeof WriterSourceProjectionV1Schema
>;

export const PersonaSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  snapshotId: z.string().min(1),
  personaVersion: z.string().min(1),
  personaDocumentSha256: Sha256Schema,
  personaSnapshotSha256: Sha256Schema,
  brandName: z.string().min(1),
  brandType: z.string().min(1),
  targetReader: z.string().min(1),
  tone: z.string().min(1),
  voiceTags: z.array(z.string().min(1)).min(1),
});
export type PersonaSnapshotV1 = z.infer<typeof PersonaSnapshotV1Schema>;

export const WriterLinkChoiceV1Schema = z.strictObject({
  linkCandidateId: z.string().min(1),
  kind: z.enum(["internal", "cta"]),
  displayLabel: z.string().min(1),
});
export type WriterLinkChoiceV1 = z.infer<typeof WriterLinkChoiceV1Schema>;

export const SiteLinkCandidateV1Schema = WriterLinkChoiceV1Schema.extend({
  url: z.url(),
});
export type SiteLinkCandidateV1 = z.infer<typeof SiteLinkCandidateV1Schema>;

const WriterIdSchema = z.string().regex(/^[a-z]+_[a-z0-9][a-z0-9_-]{0,47}$/u);
export const DraftTextUnitV1Schema = z.strictObject({
  unitId: WriterIdSchema,
  text: z.string().trim().min(1),
  assertion: z.literal("fact"),
  claimId: z.string().min(1),
});
export type DraftTextUnitV1 = z.infer<typeof DraftTextUnitV1Schema>;

export const DraftHeadingV1Schema = z.strictObject({
  level: z.union([z.literal(2), z.literal(3)]),
  text: DraftTextUnitV1Schema,
});

export const DraftBlockV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ blockId: WriterIdSchema, kind: z.literal("intro"), paragraphs: z.array(DraftTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: WriterIdSchema, kind: z.literal("summary"), heading: DraftHeadingV1Schema, items: z.array(DraftTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: WriterIdSchema, kind: z.literal("section"), heading: DraftHeadingV1Schema, paragraphs: z.array(DraftTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: WriterIdSchema, kind: z.literal("checklist"), heading: DraftHeadingV1Schema, items: z.array(DraftTextUnitV1Schema).min(1) }),
  z.strictObject({
    blockId: WriterIdSchema,
    kind: z.literal("faq"),
    heading: DraftHeadingV1Schema,
    pairs: z.array(z.strictObject({
      pairId: WriterIdSchema,
      question: DraftTextUnitV1Schema,
      answers: z.array(DraftTextUnitV1Schema).min(1),
    })).min(1).max(4),
  }),
  z.strictObject({ blockId: WriterIdSchema, kind: z.literal("related_link"), supportingCopy: DraftTextUnitV1Schema.nullable(), linkCandidateId: z.string().min(1) }),
  z.strictObject({ blockId: WriterIdSchema, kind: z.literal("cta"), supportingCopy: DraftTextUnitV1Schema.nullable(), linkCandidateId: z.string().min(1) }),
]);
export type DraftBlockV1 = z.infer<typeof DraftBlockV1Schema>;

export const ArticleDraftV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  articleId: z.string().regex(/^article_[0-9a-f-]{36}$/u),
  personaSnapshotId: z.string().min(1),
  title: DraftTextUnitV1Schema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  metaDescription: DraftTextUnitV1Schema,
  primaryKeyword: z.string().min(1),
  secondaryKeywords: z.array(z.string().min(1)).min(1),
  searchIntent: z.string().min(1),
  blocks: z.array(DraftBlockV1Schema).min(2),
});
export type ArticleDraftV1 = z.infer<typeof ArticleDraftV1Schema>;

export const ArticleSurfaceV1Schema = z.strictObject({
  surfaceId: z.string().min(1),
  unitId: z.string().min(1),
  jsonPointer: z.string().startsWith("/"),
  textSha256: Sha256Schema,
  origin: z.enum(["writer", "system_link"]),
  declaredAssertion: z.enum(["fact", "instruction"]),
});
export type ArticleSurfaceV1 = z.infer<typeof ArticleSurfaceV1Schema>;

export const CanonicalTextUnitV1Schema = z.strictObject({
  unitId: z.string().min(1),
  surfaceId: z.string().min(1),
  text: z.string().min(1),
  assertion: z.literal("fact"),
});
export const ResolvedLinkV1Schema = z.strictObject({
  unitId: z.string().min(1),
  surfaceId: z.string().min(1),
  linkCandidateId: z.string().min(1),
  kind: z.enum(["internal", "cta"]),
  displayLabel: z.string().min(1),
  url: z.url(),
  assertion: z.literal("instruction"),
  claimId: z.null(),
});

const CanonicalHeadingV1Schema = z.strictObject({
  level: z.union([z.literal(2), z.literal(3)]),
  text: CanonicalTextUnitV1Schema,
});
export const CanonicalBlockV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("intro"), paragraphs: z.array(CanonicalTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("summary"), heading: CanonicalHeadingV1Schema, items: z.array(CanonicalTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("section"), heading: CanonicalHeadingV1Schema, paragraphs: z.array(CanonicalTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("checklist"), heading: CanonicalHeadingV1Schema, items: z.array(CanonicalTextUnitV1Schema).min(1) }),
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("faq"), heading: CanonicalHeadingV1Schema, pairs: z.array(z.strictObject({ pairId: z.string().min(1), question: CanonicalTextUnitV1Schema, answers: z.array(CanonicalTextUnitV1Schema).min(1) })).min(1).max(4) }),
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("related_link"), supportingCopy: CanonicalTextUnitV1Schema.nullable(), link: ResolvedLinkV1Schema }),
  z.strictObject({ blockId: z.string().min(1), kind: z.literal("cta"), supportingCopy: CanonicalTextUnitV1Schema.nullable(), link: ResolvedLinkV1Schema }),
]);
export type CanonicalBlockV1 = z.infer<typeof CanonicalBlockV1Schema>;

export const SourceCitationV1Schema = z.strictObject({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  retrievedAt: z.iso.datetime(),
});
export const ClaimUsageV1Schema = z.strictObject({
  claimId: z.string().min(1),
  surfaceId: z.string().min(1),
});
export const DISCLOSURE_LITERAL_V1 = "이 글은 AI의 도움을 받아 작성되었습니다." as const;

export const CanonicalArticleContentV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  articleId: z.string().min(1),
  generatedAt: z.iso.datetime(),
  title: CanonicalTextUnitV1Schema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  metaDescription: CanonicalTextUnitV1Schema,
  primaryKeyword: z.string().min(1),
  secondaryKeywords: z.array(z.string().min(1)).min(1),
  searchIntent: z.string().min(1),
  personaSnapshotId: z.string().min(1),
  personaSnapshotSha256: Sha256Schema,
  blocks: z.array(CanonicalBlockV1Schema).min(2),
  surfaceIndex: z.array(ArticleSurfaceV1Schema).min(1),
  claimUsages: z.array(ClaimUsageV1Schema).min(1),
  sources: z.array(SourceCitationV1Schema).min(1),
  disclosure: z.literal(DISCLOSURE_LITERAL_V1),
  verifiedAt: z.iso.datetime(),
  provenanceMode: ProviderModeSchema,
});
export type CanonicalArticleContentV1 = z.infer<
  typeof CanonicalArticleContentV1Schema
>;

export const ArticleRenderInputV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  contentRevisionSha256: Sha256Schema,
  content: CanonicalArticleContentV1Schema,
});
export type ArticleRenderInputV1 = z.infer<typeof ArticleRenderInputV1Schema>;

export const RenderedFileV1Schema = z.strictObject({
  path: z.enum(["public/index.html", "public/styles.css"]),
  contentType: z.enum(["text/html; charset=utf-8", "text/css; charset=utf-8"]),
  bytes: z.instanceof(Uint8Array),
  byteLength: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});
export const StaticRenderResultV1Schema = z.strictObject({
  contentRevisionSha256: Sha256Schema,
  files: z.tuple([RenderedFileV1Schema, RenderedFileV1Schema]),
  coverage: z.array(z.strictObject({
    surfaceId: z.string().min(1),
    domLocator: z.string().min(1),
    renderedTextSha256: Sha256Schema,
  })),
});
export type StaticRenderResultV1 = z.infer<
  typeof StaticRenderResultV1Schema
>;

export const RunStageSchema = z.enum([
  "validating_input",
  "collecting_x",
  "clustering_topics",
  "evaluating_google",
  "selecting_topic",
  "drafting_unverified_preview",
  "rendering_unverified_preview",
  "persisting_unverified_preview",
  "researching",
  "verifying",
  "drafting",
  "quality_checking",
  "rendering",
  "persisting",
]);
export type RunStage = z.infer<typeof RunStageSchema>;
export const TerminalStatusSchema = z.enum([
  "ready_to_publish",
  "unverified_preview_ready",
  "needs_evidence",
  "no_viable_topic",
  "source_blocked",
  "failed",
]);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;
export type RunStatus = RunStage | TerminalStatus;

export const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  validating_input: ["collecting_x", "failed"],
  collecting_x: ["clustering_topics", "source_blocked", "no_viable_topic", "failed"],
  clustering_topics: ["evaluating_google", "no_viable_topic", "failed"],
  evaluating_google: ["selecting_topic", "failed"],
  selecting_topic: ["researching", "drafting_unverified_preview", "no_viable_topic", "failed"],
  drafting_unverified_preview: ["rendering_unverified_preview", "failed"],
  rendering_unverified_preview: ["persisting_unverified_preview", "failed"],
  persisting_unverified_preview: ["unverified_preview_ready", "failed"],
  researching: ["verifying", "source_blocked", "failed"],
  verifying: ["researching", "drafting", "needs_evidence", "failed"],
  drafting: ["quality_checking", "failed"],
  quality_checking: ["drafting", "rendering", "failed"],
  rendering: ["persisting", "failed"],
  persisting: ["ready_to_publish", "failed"],
  ready_to_publish: [],
  unverified_preview_ready: [],
  needs_evidence: [],
  no_viable_topic: [],
  source_blocked: [],
  failed: [],
};

export const RawEventEnvelopeV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  seq: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  event: z.unknown(),
});
export type RawEventEnvelopeV1 = z.infer<typeof RawEventEnvelopeV1Schema>;

export const FrozenRawJournalReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  firstSeq: z.number().int().positive().nullable(),
  lastSeq: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  orderedEventSha256: Sha256Schema,
  fileByteLength: z.number().int().nonnegative(),
  fileSha256: Sha256Schema,
  sealedAt: z.iso.datetime(),
});
export type FrozenRawJournalReceiptV1 = z.infer<
  typeof FrozenRawJournalReceiptV1Schema
>;

export const QualityReportV1Schema = z.strictObject({
  passed: z.boolean(),
  repairAttempts: z.number().int().min(0).max(1),
  gates: z.array(z.strictObject({
    gate: z.enum(["evidence", "freshness", "integrity", "persona", "seo", "geo", "safety", "render_integrity"]),
    passed: z.boolean(),
    code: z.string().min(1),
  })).min(1),
});
export type QualityReportV1 = z.infer<typeof QualityReportV1Schema>;
