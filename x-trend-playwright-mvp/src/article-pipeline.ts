import { randomUUID } from "node:crypto";
import path from "node:path";

import { Agent, run } from "@openai/agents";
import { z } from "zod";

import {
  AcquisitionReceiptStore,
  createSignalAgentTools,
} from "./agent-signal-tools.js";
import {
  assembleArticleDraft,
  type AssembleArticleDraftInput,
} from "./draft-assembler.js";
import {
  CommercialContextV1Schema,
  type CommercialContextV1,
} from "./commercial-context.js";
import { researchEvidence } from "./evidence-agent.js";
import { fetchSourcePage } from "./source-fetch.js";
import {
  DEFAULT_GOOGLE_EXPLORE_CONFIG,
  GoogleExploreBatchSchema,
  XSignalBatchSchema,
  type ArticleDraftV1,
  type ArticleRenderInputV1,
  type EvidenceResearchResultV1,
  type GoogleExploreBatch,
  type GooglePreemptionEvaluation,
  type ProviderMode,
  type QualityReportV1,
  type StaticRenderResultV1,
  type TopicCandidateV1,
  type XSignalBatch,
} from "./content-domain.js";
import {
  ContentOrchestrator,
  type ContentPipelinePorts,
  type PipelineArtifactMap,
  type UnverifiedPreviewArtifactMap,
} from "./content-orchestrator.js";
import { evaluateGooglePreemptionStage } from "./google-preemption-stage.js";
import {
  assembleContentBrief,
  type ContentBrief,
  type KeywordSelection,
} from "./keyword-selector.js";
import {
  OpenAiArticleDraftProvider,
  OpenAiClaimExtractionPort,
  OpenAiWebDiscoveryPort,
  selectKeywordsWithOpenAi,
} from "./openai-content-providers.js";
import { writeNonPublishablePreview } from "./preview-store.js";
import { evaluateArticleQuality, attachRenderIntegrity, decideWriterRepair } from "./quality-gates.js";
import { WritableRawEventPort } from "./raw-event-port.js";
import { RawEventIngress } from "./raw-event-ingress.js";
import { checkStaticRender } from "./render-integrity-v1.js";
import { RunStore, SUCCESS_ARTIFACT_PATHS } from "./run-store.js";
import { createSiteLinkRegistry } from "./site-link-registry.js";
import { loadSourceHostPolicy } from "./source-policy-gate.js";
import { renderStaticArticle } from "./static-html-renderer.js";
import { clusterTopicCandidates, expandTravelQueries, requireViableCandidates } from "./topic-discovery.js";
import { UndiciPinnedSourceTransport } from "./undici-pinned-source-transport.js";
import { loadWriterPersona } from "./writer-persona.js";
import { createDefaultPlaywrightSignalRuntime } from "./playwright-signal-runtime.js";
import {
  projectBrowserOperationLog,
  writeArticleProgress,
} from "./article-progress.js";
import { canonicalJson, sha256Canonical } from "./canonical-json.js";
import { createArticleWriterInput, writeArticleDraft } from "./article-agent.js";
import {
  OpenAiUnverifiedPreviewDraftProvider,
  writeUnverifiedPreviewDraft,
  type UnverifiedPreviewDraftV1,
} from "./unverified-preview-agent.js";
import {
  renderUnverifiedPreview,
  type UnverifiedPreviewRenderResult,
} from "./unverified-preview-renderer.js";
import { UnverifiedPreviewStore } from "./unverified-preview-store.js";

type SelectionArtifact = {
  keywordSelection: KeywordSelection;
  brief: ContentBrief;
};

type GoogleArtifact = {
  batch: GoogleExploreBatch;
  evaluations: GooglePreemptionEvaluation[];
  selectorInput: ReturnType<typeof evaluateGooglePreemptionStage>["selectorInput"];
};

type DraftArtifact = {
  draft: ArticleDraftV1;
  article: ArticleRenderInputV1;
  brief: ContentBrief;
};

type QualityArtifact = DraftArtifact & {
  report: QualityReportV1;
  evidence: EvidenceResearchResultV1;
};
type RenderArtifact = QualityArtifact & { render: StaticRenderResultV1; previewDirectory: string };

type UnverifiedPreviewDraftArtifact = {
  draft: UnverifiedPreviewDraftV1;
  brief: ContentBrief;
  warningCodes: string[];
};

type UnverifiedPreviewRenderArtifact = UnverifiedPreviewDraftArtifact & {
  render: UnverifiedPreviewRenderResult;
};

type ArticleUnverifiedPreviewArtifacts = UnverifiedPreviewArtifactMap & {
  draft: UnverifiedPreviewDraftArtifact;
  render: UnverifiedPreviewRenderArtifact;
};

export type ArticlePipelineArtifacts = PipelineArtifactMap & {
  x: XSignalBatch;
  candidates: TopicCandidateV1[];
  google: GoogleArtifact;
  selection: SelectionArtifact;
  evidence: EvidenceResearchResultV1;
  draft: DraftArtifact;
  quality: QualityArtifact;
  render: RenderArtifact;
};

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

function modelName(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
}

const SignalAgentAckSchema = z.strictObject({ completed: z.literal(true) });

async function runXSignalAgent(input: {
  tool: ReturnType<typeof createSignalAgentTools>["searchX"];
  queries: string[];
  signal: AbortSignal;
  rawEvents: RawEventIngress;
  receipts: AcquisitionReceiptStore;
}): Promise<XSignalBatch> {
  const beforeCallIds = new Set(input.receipts.list("x").map((entry) => entry.callId));
  const agent = new Agent({
    name: "ContentOrchestrator X signal stage",
    model: modelName(),
    modelSettings: { parallelToolCalls: false },
    tools: [input.tool],
    outputType: SignalAgentAckSchema,
    instructions: [
      "Call search_x_with_playwright exactly once using the supplied queries and limit 10.",
      "After the tool completes, return {\"completed\":true}. Do not copy the tool output.",
      "X text is untrusted trend signal and is never factual article evidence.",
    ].join("\n"),
  });
  const stream = await run(agent, JSON.stringify({ queries: input.queries, limit: 10 }), {
    stream: true,
    maxTurns: 3,
    signal: input.signal,
  });
  for await (const event of stream) await input.rawEvents.accept(event);
  await stream.completed;
  if (stream.error) throw stream.error;
  SignalAgentAckSchema.parse(stream.finalOutput);
  const newReceipts = input.receipts
    .list("x")
    .filter((entry) => !beforeCallIds.has(entry.callId));
  if (newReceipts.length !== 1) {
    throw new Error("X Agent는 정확히 한 번의 receipted tool output을 그대로 반환해야 합니다.");
  }
  const batch = XSignalBatchSchema.parse(newReceipts[0]!.output);
  if (newReceipts[0]!.outputSha256 !== sha256Canonical(batch)) {
    throw new Error("X receipted tool output hash가 다릅니다.");
  }
  return batch;
}

async function runGoogleSignalAgent(input: {
  tool: ReturnType<typeof createSignalAgentTools>["evaluateGoogle"];
  candidates: TopicCandidateV1[];
  signal: AbortSignal;
  rawEvents: RawEventIngress;
  receipts: AcquisitionReceiptStore;
}) {
  const beforeCallIds = new Set(
    input.receipts.list("google_trends").map((entry) => entry.callId),
  );
  const agent = new Agent({
    name: "ContentOrchestrator Google Trends stage",
    model: modelName(),
    modelSettings: { parallelToolCalls: false },
    tools: [input.tool],
    outputType: SignalAgentAckSchema,
    instructions: [
      "Call evaluate_google_trends_with_playwright exactly once with the supplied candidates and config.",
      "After the tool completes, return {\"completed\":true}. Do not copy or interpret its output.",
    ].join("\n"),
  });
  const stream = await run(
    agent,
    JSON.stringify({
      candidates: input.candidates.map(({ candidateId, label }) => ({ candidateId, label })),
      config: DEFAULT_GOOGLE_EXPLORE_CONFIG,
    }),
    { stream: true, maxTurns: 3, signal: input.signal },
  );
  for await (const event of stream) await input.rawEvents.accept(event);
  await stream.completed;
  if (stream.error) throw stream.error;
  SignalAgentAckSchema.parse(stream.finalOutput);
  const newReceipts = input.receipts
    .list("google_trends")
    .filter((entry) => !beforeCallIds.has(entry.callId));
  if (newReceipts.length !== 1) {
    throw new Error(
      "Google Agent는 정확히 한 번의 receipted tool output을 그대로 반환해야 합니다.",
    );
  }
  const batch = GoogleExploreBatchSchema.parse(newReceipts[0]!.output);
  if (newReceipts[0]!.outputSha256 !== sha256Canonical(batch)) {
    throw new Error("Google receipted tool output hash가 다릅니다.");
  }
  return batch;
}

export async function createArticlePipeline(input: {
  seedKeyword: string;
  commercialContext: CommercialContextV1;
  unverifiedPreview?: boolean;
  projectDirectory: string;
  rawOutput?: NodeJS.WritableStream;
  progressOutput?: NodeJS.WritableStream;
}) {
  const projectDirectory = path.resolve(input.projectDirectory);
  const runId = `run_${randomUUID()}`;
  const generatedAt = new Date().toISOString();
  const commercialContext = CommercialContextV1Schema.parse(input.commercialContext);
  const executionMode = "live" as const;
  const stageProvenanceMode: ProviderMode = "replay";
  const progressOutput = input.progressOutput ?? process.stderr;
  const request = {
    schemaVersion: "1.0" as const,
    domain: "travel" as const,
    locale: "ko-KR" as const,
    seedKeyword: input.seedKeyword,
  };
  const rawEvents = new RawEventIngress({
    runId,
    secrets: process.env.OPENAI_API_KEY ? [process.env.OPENAI_API_KEY] : [],
    port: new WritableRawEventPort((input.rawOutput ?? process.stderr) as NodeJS.WritableStream as import("node:stream").Writable),
  });
  writeArticleProgress(progressOutput, {
    type: "commercial_context",
    runId,
    executionMode,
    provenanceMode: stageProvenanceMode,
    searchTopic: commercialContext.search_topic.value,
    fields: {
      brand_name: commercialContext.brand_name,
      brand_type: commercialContext.brand_type,
      target_reader: commercialContext.target_reader,
      offering: commercialContext.offering,
      cta_goal: commercialContext.cta_goal,
    },
    at: generatedAt,
  });
  writeArticleProgress(progressOutput, {
    type: "pipeline_stage",
    runId,
    stage: "validating_input",
    executionMode,
    provenanceMode: stageProvenanceMode,
    at: generatedAt,
  });
  const signalRuntime = createDefaultPlaywrightSignalRuntime({
    onOperation: (operation) =>
      writeArticleProgress(progressOutput, projectBrowserOperationLog(operation)),
  });
  const receipts = new AcquisitionReceiptStore();
  const sourcePolicy = await loadSourceHostPolicy();
  const persona = await loadWriterPersona({
    brandName: commercialContext.brand_name.value,
    brandType: commercialContext.brand_type.value,
    targetReader: commercialContext.target_reader.value,
    tone: "명확하고 친절하며 과장하지 않는 실용적 문체",
    voiceTags: ["answer-first", "grounded", "practical", "conversion-aware"],
  });
  const siteLinks = createSiteLinkRegistry({
    siteOrigin: "https://example.com/",
    allowedHosts: ["example.com"],
    candidates: [],
  });
  const transport = new UndiciPinnedSourceTransport();
  // Actual browser/network calls are executed, but the full current-run causal
  // registry is not complete yet. Keep the whole derived graph non-live until
  // a separately reviewed validator is wired; flipping one boolean must never
  // be enough to issue ready_to_publish.
  let latestPreviewDirectory: string | undefined;
  let pendingRepair:
    | { originalDraft: ArticleDraftV1; editableUnitIds: string[]; failureCodes: string[] }
    | undefined;
  let repairCount: 0 | 1 = 0;

  const toolsFor = (signal: AbortSignal) =>
    createSignalAgentTools({
      runId,
      x: signalRuntime.providers.x,
      googleTrends: signalRuntime.providers.googleTrends,
      receipts,
      signal,
    });

  const previewWarnings = (
    google: GoogleArtifact,
    selection: SelectionArtifact,
  ): string[] => [
    ...new Set([
      "external_evidence_verification_skipped",
      "publish_provenance_unverified",
      ...(google.batch.status === "complete"
        ? []
        : [`google_trends_${google.batch.status}`]),
      ...selection.keywordSelection.warningCodes,
    ]),
  ];

  const assemble = (
    draft: ArticleDraftV1,
    selection: SelectionArtifact,
    evidence: EvidenceResearchResultV1,
  ): ArticleRenderInputV1 =>
    assembleArticleDraft({
      runId,
      generatedAt,
      verifiedAt: new Date().toISOString(),
      provenanceMode: stageProvenanceMode,
      draft,
      brief: selection.brief,
      persona,
      claims: evidence.claims,
      sources: evidence.sources,
      siteLinks,
    } satisfies AssembleArticleDraftInput);

  const ports: ContentPipelinePorts<
    ArticlePipelineArtifacts,
    ArticleUnverifiedPreviewArtifacts
  > = {
    signals: {
      collectX: async (context) => {
        const tools = toolsFor(context.signal);
        const batch = await runXSignalAgent({
          tool: tools.searchX,
          queries: expandTravelQueries(context.request.seedKeyword, 2),
          signal: context.signal,
          rawEvents,
          receipts,
        });
        if (batch.dedupedSignals.length === 0) {
          const blockedOnly =
            batch.observations.length > 0 &&
            batch.observations.every(
              (observation) =>
                observation.status === "login_required" ||
                observation.status === "blocked",
            );
          if (blockedOnly) {
            return { outcome: "source_blocked", code: "x_access_blocked" };
          }
          if (batch.observations.some((observation) => observation.status !== "ok")) {
            return { outcome: "failed", code: "x_collection_failed" };
          }
          return { outcome: "no_viable_topic", code: "x_no_signals" };
        }
        const independentKeys = new Set(
          batch.dedupedSignals.map(
            (signal) => signal.authorKey ?? signal.canonicalUrl ?? signal.signalId,
          ),
        );
        if (batch.dedupedSignals.length < 5 || independentKeys.size < 2) {
          const hasAccessFailure = batch.observations.some(
            (observation) =>
              observation.status === "login_required" ||
              observation.status === "blocked",
          );
          const hasCollectionError = batch.observations.some(
            (observation) => observation.status === "error",
          );
          if (hasAccessFailure && !hasCollectionError) {
            return { outcome: "source_blocked", code: "x_access_blocked" };
          }
          if (hasCollectionError) {
            return { outcome: "failed", code: "x_incomplete_sample" };
          }
          return { outcome: "no_viable_topic", code: "x_sample_below_minimum" };
        }
        return { outcome: "ok", value: batch, provenanceMode: stageProvenanceMode };
      },
      clusterTopics: async (context) => {
        const candidates = clusterTopicCandidates(
          context.x,
          context.request.seedKeyword,
          stageProvenanceMode,
        );
        try {
          requireViableCandidates(candidates);
        } catch {
          return { outcome: "no_viable_topic", code: "x_candidate_count_below_four" };
        }
        return { outcome: "ok", value: candidates, provenanceMode: stageProvenanceMode };
      },
      evaluateGoogle: async (context) => {
        const tools = toolsFor(context.signal);
        const batch = await runGoogleSignalAgent({
          tool: tools.evaluateGoogle,
          candidates: context.candidates,
          signal: context.signal,
          rawEvents,
          receipts,
        });
        const evaluated = evaluateGooglePreemptionStage(batch);
        return {
          outcome: "ok",
          value: { batch, evaluations: evaluated.evaluations, selectorInput: evaluated.selectorInput },
          provenanceMode: stageProvenanceMode,
        };
      },
      selectTopic: async (context) => {
        const keywordSelection = await selectKeywordsWithOpenAi(
          context.google.selectorInput,
          { signal: context.signal, onRawEvent: (event) => rawEvents.accept(event) },
        );
        return {
          outcome: "ok",
          value: {
            keywordSelection,
            brief: assembleContentBrief(keywordSelection, context.google.selectorInput),
          },
          provenanceMode: stageProvenanceMode,
        };
      },
    },
    evidence: {
      research: async (context) => {
        const result = await researchEvidence(context.selection.brief, {
          discovery: new OpenAiWebDiscoveryPort({
            allowedDomains: sourcePolicy.rules.map((rule) => rule.hostname),
            signal: context.signal,
            onRawEvent: (event) => rawEvents.accept(event),
          }),
          fetcher: {
            fetch: (discovery) =>
              fetchSourcePage({
                discovery,
                fetchToolCallId: `fetch_${randomUUID()}`,
                transport,
                provenanceMode: stageProvenanceMode,
                forbiddenSecretValues: process.env.OPENAI_API_KEY ? [process.env.OPENAI_API_KEY] : [],
                isAllowedRedirectHost: (hostname) =>
                  sourcePolicy.rules.some((rule) => rule.hostname === hostname),
                signal: context.signal,
              }),
          },
          claimExtractor: new OpenAiClaimExtractionPort({
            signal: context.signal,
            onRawEvent: (event) => rawEvents.accept(event),
          }),
          sourceHostPolicy: sourcePolicy,
        });
        if (result.status === "source_blocked") {
          return { outcome: "source_blocked", code: result.status };
        }
        return { outcome: "ok", value: result, provenanceMode: stageProvenanceMode };
      },
      verify: async (context) => {
        if (context.evidence.status !== "sufficient") {
          return { outcome: "needs_evidence", code: "evidence_not_sufficient" };
        }
        return { outcome: "ok", value: context.evidence, provenanceMode: stageProvenanceMode };
      },
    },
    writer: {
      draft: async (context) => {
        const writerInput = createArticleWriterInput({
          brief: context.selection.brief,
          persona,
          claims: context.evidence.claims.filter(
            (claim) => claim.status === "accepted" || claim.status === "qualified",
          ),
          sources: context.evidence.sources.flatMap((entry) =>
            entry.status === "admitted"
              ? [{
                  sourceId: entry.snapshot.sourceId,
                  publisher: entry.snapshot.publisher,
                  title: entry.snapshot.title,
                  checkedAt: entry.snapshot.retrievedAt,
                }]
              : [],
          ),
          links: [],
        });
        const provider = new OpenAiArticleDraftProvider();
        const draft = await writeArticleDraft(
          provider,
          context.repairAttempt === 0
            ? { mode: "initial", input: writerInput }
            : {
                mode: "repair",
                input: writerInput,
                originalDraft: pendingRepair!.originalDraft,
                editableUnitIds: pendingRepair!.editableUnitIds,
                failureCodes: pendingRepair!.failureCodes,
              },
          { signal: context.signal, onRawEvent: (event) => rawEvents.accept(event) },
        );
        repairCount = context.repairAttempt;
        pendingRepair = undefined;
        return {
          outcome: "ok",
          value: {
            draft,
            article: assemble(draft, context.selection, context.evidence),
            brief: context.selection.brief,
          },
          provenanceMode: stageProvenanceMode,
        };
      },
      qualityCheck: async (context) => {
        const report = evaluateArticleQuality({
          article: context.draft.article,
          brief: context.draft.brief,
          persona,
          claims: context.evidence.claims,
          sources: context.evidence.sources,
          repairAttempts: repairCount,
        });
        const decision = decideWriterRepair(report, context.draft.article);
        if (decision.status === "repair_required") {
          pendingRepair = {
            originalDraft: context.draft.draft,
            editableUnitIds: decision.editableUnitIds,
            failureCodes: decision.failureCodes,
          };
          return { outcome: "repair", code: decision.failureCodes.join(",") };
        }
        if (decision.status === "failed") {
          return { outcome: "failed", code: decision.failureCodes.join(",") };
        }
        return {
          outcome: "ok",
          value: { ...context.draft, report, evidence: context.evidence },
          provenanceMode: stageProvenanceMode,
        };
      },
      render: async (context) => {
        const result = await renderStaticArticle(context.quality.article);
        const integrity = await checkStaticRender(context.quality.article, result);
        const report = attachRenderIntegrity(context.quality.report, integrity);
        if (!report.passed) return { outcome: "failed", code: integrity.code };
        const previewDirectory = await writeNonPublishablePreview({
          outputRoot: path.join(projectDirectory, "output"),
          runId,
          files: [
            { name: "index.html", bytes: result.files[0].bytes },
            { name: "styles.css", bytes: result.files[1].bytes },
            { name: "article.json", bytes: jsonBytes(context.quality.article) },
            { name: "evidence.json", bytes: jsonBytes(context.quality.evidence) },
            { name: "quality.json", bytes: jsonBytes(report) },
            { name: "PREVIEW_ONLY.txt", bytes: new TextEncoder().encode("NON-PUBLISHABLE PREVIEW: live provenance gate is not ready.\n") },
          ],
        });
        latestPreviewDirectory = previewDirectory;
        return {
          outcome: "ok",
          value: { ...context.quality, report, render: result, previewDirectory },
          provenanceMode: stageProvenanceMode,
        };
      },
    },
    ...(input.unverifiedPreview
      ? {
          unverifiedPreview: {
            draft: async (context) => {
              try {
                const warningCodes = previewWarnings(
                  context.google,
                  context.selection,
                );
                const draft = await writeUnverifiedPreviewDraft(
                  new OpenAiUnverifiedPreviewDraftProvider(),
                  {
                    brief: context.selection.brief,
                    commercialContext,
                    persona,
                  },
                  {
                    signal: context.signal,
                    onRawEvent: async (event) => {
                      await rawEvents.accept(event);
                    },
                  },
                );
                return {
                  outcome: "ok" as const,
                  value: {
                    draft,
                    brief: context.selection.brief,
                    warningCodes,
                  },
                  provenanceMode: stageProvenanceMode,
                };
              } catch {
                return {
                  outcome: "failed" as const,
                  code: "unverified_preview_writer_failed",
                  message: "미검증 프리뷰 초안 생성에 실패했습니다.",
                };
              }
            },
            render: async (context) => {
              try {
                const render = await renderUnverifiedPreview({
                  draft: context.draft.draft,
                  commercialContext,
                  warningCodes: context.draft.warningCodes,
                });
                return {
                  outcome: "ok" as const,
                  value: { ...context.draft, render },
                  provenanceMode: stageProvenanceMode,
                };
              } catch {
                return {
                  outcome: "failed" as const,
                  code: "unverified_preview_render_failed",
                  message: "미검증 프리뷰 렌더링에 실패했습니다.",
                };
              }
            },
            persist: async (context) => {
              try {
                const preview = context.render;
                const store = new UnverifiedPreviewStore({
                  outputRoot: path.join(projectDirectory, "output"),
                });
                const previewJson = jsonBytes({
                  schemaVersion: "1.0",
                  runId,
                  generatedAt,
                  executionMode,
                  provenanceMode: stageProvenanceMode,
                  publishable: false,
                  verification: "skipped",
                  personaPolicy: {
                    snapshotId: persona.snapshotId,
                    personaVersion: persona.personaVersion,
                    personaDocumentSha256: persona.personaDocumentSha256,
                    personaSnapshotSha256: persona.personaSnapshotSha256,
                    claimRuleException: "user_authorized_preview_only",
                  },
                  warningCodes: preview.warningCodes,
                  commercialContext,
                  brief: preview.brief,
                  draft: preview.draft,
                  previewRevisionSha256:
                    preview.render.previewRevisionSha256,
                  rawJournalReceipt: context.rawJournal.receipt,
                });
                const signalsJson = jsonBytes({
                  schemaVersion: "1.0",
                  runId,
                  generatedAt,
                  executionMode,
                  provenanceMode: stageProvenanceMode,
                  x: context.artifacts.x,
                  candidates: context.artifacts.candidates,
                  google: context.artifacts.google,
                  selection: context.artifacts.selection,
                });
                const outcome = await store.commit({
                  runId,
                  files: [
                    {
                      name: "index.html",
                      bytes: preview.render.files[0].bytes,
                    },
                    {
                      name: "styles.css",
                      bytes: preview.render.files[1].bytes,
                    },
                    {
                      name: "hero.png",
                      bytes: preview.render.files[2].bytes,
                    },
                    { name: "preview.json", bytes: previewJson },
                    { name: "signals.json", bytes: signalsJson },
                    {
                      name: "events.jsonl",
                      bytes: context.rawJournal.fileBytes,
                    },
                    {
                      name: "PREVIEW_ONLY.txt",
                      bytes: new TextEncoder().encode(
                        "PREVIEW_ONLY\n외부 근거 미검증 · 테스트 프리뷰 · 발행 금지\n외부 근거 검증을 생략했으므로 정식 발행할 수 없습니다.\n",
                      ),
                    },
                  ],
                });
                latestPreviewDirectory = outcome.runDirectory;
                return {
                  outcome: "unverified_preview_ready" as const,
                  previewDirectory: outcome.runDirectory,
                  executionMode,
                  provenanceMode: stageProvenanceMode,
                  warningCodes: [...preview.warningCodes],
                  publishable: false as const,
                };
              } catch {
                return {
                  outcome: "failed" as const,
                  code: "unverified_preview_persist_failed",
                  message: "미검증 프리뷰 저장에 실패했습니다.",
                };
              }
            },
          },
        }
      : {}),
    output: {
      persist: async (context) => {
        const render = context.artifacts.render;
        const operations = new Uint8Array();
        const artifacts = SUCCESS_ARTIFACT_PATHS.map((artifactPath) => {
          const bytes =
            artifactPath === "public/index.html"
              ? render.render.files[0].bytes
              : artifactPath === "public/styles.css"
                ? render.render.files[1].bytes
                : artifactPath === "private/run.json"
                  ? jsonBytes({ schemaVersion: "1.0", runId, generatedAt, request, executionMode, provenanceMode: stageProvenanceMode })
                  : artifactPath === "private/signals.json"
                    ? jsonBytes({ x: context.artifacts.x, candidates: context.artifacts.candidates, google: context.artifacts.google, selection: context.artifacts.selection })
                    : artifactPath === "private/evidence.json"
                      ? jsonBytes(context.artifacts.evidence)
                      : artifactPath === "private/quality.json"
                        ? jsonBytes(render.report)
                        : artifactPath === "private/article.json"
                          ? jsonBytes(render.article)
                          : artifactPath === "private/events.jsonl"
                            ? context.rawJournal.fileBytes
                            : operations;
          return { path: artifactPath, bytes };
        });
        const store = new RunStore({
          outputRoot: path.join(projectDirectory, "output"),
          validateLiveProvenance: async () => false,
        });
        const outcome = await store.commit({
          runId,
          generatedAt,
          contentRevisionSha256: render.article.contentRevisionSha256,
          personaSnapshotSha256: persona.personaSnapshotSha256,
          executionTrustPolicySha256: sha256Canonical({ policy: "hackathon-e2e-v1" }),
          provenanceMode: render.article.content.provenanceMode,
          rawJournalReceipt: context.rawJournal.receipt,
          artifacts,
        });
        return { ...outcome, outcome: "ready_to_publish", provenanceMode: "live" };
      },
    },
  };

  const orchestrator = new ContentOrchestrator<
    ArticlePipelineArtifacts,
    ArticleUnverifiedPreviewArtifacts
  >({
    runId,
    request,
    ports,
    rawEvents,
    wallClockMs: 240_000,
    stageRetryMax: 1,
    onTransition: (stage) =>
      writeArticleProgress(progressOutput, {
        type: "pipeline_stage",
        runId,
        stage,
        executionMode,
        provenanceMode: stageProvenanceMode,
        at: new Date().toISOString(),
      }),
  });
  return {
    orchestrator,
    runId,
    request,
    getPreviewDirectory: () => latestPreviewDirectory,
    executionMode,
    provenanceMode: stageProvenanceMode,
  };
}
