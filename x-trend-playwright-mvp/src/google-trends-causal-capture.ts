import { randomUUID } from "node:crypto";

import {
  GoogleExploreBatchSchema,
  type GoogleExploreBatch,
  type GoogleInterestCapture,
  type GoogleInterestPoint,
  type GoogleRawArtifactRef,
  type GoogleRelatedQueryCapture,
  type GoogleRelatedTopicCapture,
  type GoogleTrendsRawArtifact,
  type GoogleUnavailableCode,
} from "./content-domain.js";
import { type BrowserLeaseSession } from "./browser-runtime.js";
import { sha256Canonical } from "./canonical-json.js";
import {
  snapshotEmptyDownloadDirectory,
  waitForStableCsvDownload,
} from "./google-browser-runtime.js";
import { parseGoogleInterestOverTimeCsv } from "./google-csv-parser-v1.js";
import type { CollectGoogleTrendsInput } from "./google-trends-observation-port.js";
import {
  buildGoogleRenderedScreenFunction,
  extractGoogleRenderedCaptures,
  findGoogleCardModeTargets,
  findInterestDownloadTarget,
  mergeGoogleRenderedScreens,
  missingGoogleCardModes,
  parseGoogleRenderedScreen,
  type GoogleRenderedCandidateCaptures,
  type GoogleRenderedScreen,
} from "./google-trends-screen-extractor-v1.js";

export type CausalGoogleCaptureOptions = {
  outputDirectory: string;
  downloadTimeoutMs?: number;
  downloadPollMs?: number;
  downloadStableSamples?: number;
};

export type CausalGoogleCaptureResult = {
  batch: GoogleExploreBatch;
  downloadReceiptSha256s: string[];
};

type CausalCaptureInput = CollectGoogleTrendsInput & { exploreUrl: string };

function unavailableQuery(
  reasonCode: GoogleUnavailableCode,
): GoogleRelatedQueryCapture {
  return { state: "unavailable", value: null, reasonCode };
}

function unavailableTopic(
  reasonCode: GoogleUnavailableCode,
): GoogleRelatedTopicCapture {
  return { state: "unavailable", value: null, reasonCode };
}

function unavailableInterest(
  reasonCode: GoogleUnavailableCode,
): GoogleInterestCapture {
  return { state: "unavailable", value: null, reasonCode };
}

function allUnavailableCaptures(
  input: CausalCaptureInput,
  reasonCode: GoogleUnavailableCode,
): GoogleRenderedCandidateCaptures[] {
  return input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    relatedQueries: {
      top: unavailableQuery(reasonCode),
      rising: unavailableQuery(reasonCode),
    },
    relatedTopics: {
      top: unavailableTopic(reasonCode),
      rising: unavailableTopic(reasonCode),
    },
  }));
}

function classifyFailure(error: unknown): GoogleUnavailableCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/selector cardinality|schema|card mode|top\/rising/iu.test(message)) {
    return "schema_changed";
  }
  if (/429|rate limit|too many requests/iu.test(message)) {
    return "rate_limited";
  }
  if (/timeout|시간|timed out/iu.test(message)) {
    return "timeout";
  }
  if (/download|csv|파일/iu.test(message)) {
    return "download_failed";
  }
  return "navigation_failed";
}

function deriveStatus(observations: GoogleExploreBatch["observations"]): GoogleExploreBatch["status"] {
  const sections = observations.flatMap((observation) => [
    observation.relatedQueries.top,
    observation.relatedQueries.rising,
    observation.relatedTopics.top,
    observation.relatedTopics.rising,
    observation.interestOverTime,
  ]);
  return sections.every((capture) => capture.state === "available")
    ? "complete"
    : sections.every((capture) => capture.state === "unavailable")
      ? "unavailable"
      : "partial";
}

async function collectExplicitModes(
  session: BrowserLeaseSession,
  initial: GoogleRenderedScreen,
  input: CausalCaptureInput,
): Promise<GoogleRenderedScreen> {
  if (initial.bodyState !== "ready") {
    return initial;
  }
  const screens = [initial];
  const missing = missingGoogleCardModes(initial, input.candidates);
  for (const mode of ["top", "rising"] as const) {
    const expectedCount = missing.filter((item) => item.mode === mode).length;
    if (expectedCount === 0) {
      continue;
    }
    const snapshot = await session.call("browser_snapshot", {});
    const targets = findGoogleCardModeTargets(snapshot.text, mode);
    if (targets.length !== expectedCount) {
      throw new Error(
        `Google selector cardinality drift: ${mode} targets=${targets.length}, expected=${expectedCount}`,
      );
    }
    for (const target of targets) {
      await session.call("browser_click", {
        target: target.ref,
        element: `Google Related card ${mode} mode`,
      });
    }
    await session.call("browser_wait_for", { time: 1 });
    const evaluated = await session.call("browser_evaluate", {
      function: buildGoogleRenderedScreenFunction(input.candidates),
    });
    screens.push(parseGoogleRenderedScreen(evaluated.text));
  }
  return mergeGoogleRenderedScreens(screens, input.candidates);
}

export async function captureGoogleTrendsWithCausalLease(
  session: BrowserLeaseSession,
  input: CausalCaptureInput,
  options: CausalGoogleCaptureOptions,
): Promise<CausalGoogleCaptureResult> {
  const candidateIds = input.candidates.map((candidate) => candidate.candidateId);
  const configSha256 = sha256Canonical(input.config);
  const checkedAt = new Date().toISOString();
  let screen: GoogleRenderedScreen | null = null;
  let screenExtraction: unknown = null;
  let screenCaptures: GoogleRenderedCandidateCaptures[];
  let interest: GoogleInterestCapture = unavailableInterest("navigation_failed");
  let interestSeriesByCandidateId: Record<string, GoogleInterestPoint[]> | null =
    null;
  let csvArtifact: GoogleTrendsRawArtifact | null = null;
  const warningCodes = new Set<string>();
  const downloadReceiptSha256s: string[] = [];

  try {
    await session.call("browser_navigate", { url: input.exploreUrl });
    await session.call("browser_wait_for", { time: 3 });
    const evaluated = await session.call("browser_evaluate", {
      function: buildGoogleRenderedScreenFunction(input.candidates),
    });
    screen = await collectExplicitModes(
      session,
      parseGoogleRenderedScreen(evaluated.text),
      input,
    );
    const extracted = extractGoogleRenderedCaptures(screen, input.candidates);
    screenCaptures = extracted.captures;
    screenExtraction = screen;

    const blockingCode = screen.bodyState === "ready" ? null : screen.bodyState;
    if (blockingCode) {
      interest = unavailableInterest(blockingCode);
      warningCodes.add(`google_${blockingCode}`);
    } else if (extracted.partialBoundary.state === "unavailable") {
      interest = unavailableInterest("schema_changed");
      warningCodes.add("google_partial_boundary_unavailable");
    } else {
      const snapshot = await session.call("browser_snapshot", {});
      screenExtraction = {
        renderedScreen: screen,
        accessibilitySnapshotSha256: sha256Canonical(snapshot.text),
      };
      const downloadTarget = findInterestDownloadTarget(snapshot.text);
      if (!downloadTarget) {
        interest = unavailableInterest("schema_changed");
        warningCodes.add("google_interest_download_target_unavailable");
      } else {
        const preClickEntries = await snapshotEmptyDownloadDirectory(
          options.outputDirectory,
        );
        const rawArtifactId = `google_artifact_${randomUUID()}`;
        const initiatedAt = new Date().toISOString();
        const clicked = await session.call("browser_click", {
          target: downloadTarget,
          element: "Interest over time CSV download",
        });
        const downloaded = await waitForStableCsvDownload({
          runId: input.runId,
          parentToolCallId: input.parentToolCallId,
          clickOperationId: clicked.operationId,
          outputDirectory: options.outputDirectory,
          preClickEntries,
          rawArtifactId,
          initiatedAt,
          timeoutMs: options.downloadTimeoutMs,
          pollMs: options.downloadPollMs,
          stableSamples: options.downloadStableSamples,
          signal: input.signal,
        });
        const { receiptSha256: legacyReceiptSha256, ...legacyReceipt } =
          downloaded.receipt;
        void legacyReceiptSha256;
        const downloadWithoutSelf = {
          ...legacyReceipt,
          leaseId: session.leaseId,
          invocationId: session.invocationId,
          exploreUrl: input.exploreUrl,
          mcpReportedFilename: downloaded.receipt.relativeFilename,
        };
        const causalDownloadReceiptSha256 = sha256Canonical(downloadWithoutSelf);
        downloadReceiptSha256s.push(causalDownloadReceiptSha256);
        const parsed = parseGoogleInterestOverTimeCsv(
          downloaded.bytes,
          input.candidates,
          extracted.partialBoundary,
        );
        csvArtifact = {
          artifactId: rawArtifactId,
          kind: "interest_over_time_csv",
          candidateIds,
          exploreUrl: input.exploreUrl,
          collectedAt: downloaded.receipt.completedAt,
          configSha256,
          mediaType: "text/csv",
          suggestedFilename: downloaded.receipt.relativeFilename,
          rawBytesBase64: Buffer.from(downloaded.bytes).toString("base64"),
          byteLength: downloaded.bytes.byteLength,
          sha256: parsed.csvSha256,
          downloadReceiptSha256: causalDownloadReceiptSha256,
        };
        interestSeriesByCandidateId = parsed.seriesByCandidateId;
        interest = {
          state: "available",
          value:
            parsed.seriesByCandidateId[
              input.candidates[0]?.candidateId ?? ""
            ] ?? [],
        };
      }
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    const reason = classifyFailure(error);
    warningCodes.add(`google_${reason}`);
    // Do not retry the same parser inside its own failure handler. Schema
    // drift must close as unavailable instead of escaping the capture stage.
    screenCaptures = allUnavailableCaptures(input, reason);
    screenExtraction = {
      schemaVersion: "1.0",
      state: "unavailable",
      reasonCode: reason,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    interest = unavailableInterest(reason);
    interestSeriesByCandidateId = null;
    csvArtifact = null;
    downloadReceiptSha256s.splice(0);
  }

  const captures = screenCaptures!;
  const extraction = screenExtraction ?? {
    schemaVersion: "1.0",
    state: "unavailable",
    reasonCode: "navigation_failed",
  };
  const screenArtifactId = `google_artifact_${randomUUID()}`;
  const screenSha256 = sha256Canonical(extraction);
  const extractorReceiptSha256 = sha256Canonical({
    schemaVersion: "1.0",
    extractorId: "google-trends-explore-screen-v1",
    orderedOperationIds: session.operations
      .filter((operation) => operation.operation.phase === "call")
      .map((operation) => operation.operation.operationId),
    operationResultsSha256: sha256Canonical(
      session.operations
        .filter((operation) => operation.operation.phase === "result")
        .map((operation) =>
          operation.operation.phase === "result"
            ? operation.operation.resultSha256
            : "",
        ),
    ),
    outputSha256: screenSha256,
  });
  const screenArtifact: GoogleTrendsRawArtifact = {
    artifactId: screenArtifactId,
    kind: "screen_extraction",
    candidateIds,
    exploreUrl: input.exploreUrl,
    collectedAt: new Date().toISOString(),
    configSha256,
    extraction,
    sha256: screenSha256,
    extractorReceiptSha256,
  };
  const rawArtifacts = csvArtifact
    ? [screenArtifact, csvArtifact]
    : [screenArtifact];
  const rawArtifactRefs: GoogleRawArtifactRef[] = rawArtifacts.map(
    (artifact, index) => ({
      artifactId: artifact.artifactId,
      jsonPointer: `/rawArtifacts/${index}`,
      sha256: artifact.sha256,
    }),
  );
  const observations = input.candidates.map((candidate, index) => {
    const capture = captures[index];
    if (!capture || capture.candidateId !== candidate.candidateId) {
      throw new Error("Google screen capture 후보 순서가 요청과 다릅니다.");
    }
    const candidateInterest: GoogleInterestCapture =
      interest.state === "available" && interestSeriesByCandidateId
        ? {
            state: "available",
            value: interestSeriesByCandidateId[candidate.candidateId] ?? [],
          }
        : interest;
    return {
      candidateId: candidate.candidateId,
      query: candidate.label,
      exploreUrl: input.exploreUrl,
      checkedAt,
      relatedQueries: capture.relatedQueries,
      relatedTopics: capture.relatedTopics,
      interestOverTime: candidateInterest,
      rawArtifactRefs,
      warningCodes: [...warningCodes],
    };
  });
  const batch = GoogleExploreBatchSchema.parse({
    config: input.config,
    requestedCandidates: input.candidates,
    observations,
    rawArtifacts,
    status: deriveStatus(observations),
  });
  return { batch, downloadReceiptSha256s };
}
