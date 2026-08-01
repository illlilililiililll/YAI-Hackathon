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
import { sha256Canonical } from "./canonical-json.js";
import {
  GoogleBrowserRuntime,
  snapshotEmptyDownloadDirectory,
  waitForStableCsvDownload,
  type GoogleBrowserOperation,
  type GoogleCsvDownloadReceipt,
  type McpToolCaller,
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

export interface GoogleMcpServer extends McpToolCaller {
  connect(): Promise<void>;
  close(): Promise<void>;
}

export type GoogleTrendsMcpCaptureOptions = {
  outputDirectory: string;
  createServer: () => GoogleMcpServer;
  onOperation?: (operation: GoogleBrowserOperation) => void;
  onDownloadReceipt?: (receipt: GoogleCsvDownloadReceipt) => void;
  downloadTimeoutMs?: number;
  downloadPollMs?: number;
  downloadStableSamples?: number;
};

type CaptureInput = CollectGoogleTrendsInput & { exploreUrl: string };

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
  input: CaptureInput,
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

function batchStatus(
  captures: GoogleRenderedCandidateCaptures[],
  interest: GoogleInterestCapture,
): GoogleExploreBatch["status"] {
  const sections = captures.flatMap((capture) => [
    capture.relatedQueries.top,
    capture.relatedQueries.rising,
    capture.relatedTopics.top,
    capture.relatedTopics.rising,
    interest,
  ]);
  return sections.every((capture) => capture.state === "available")
    ? "complete"
    : sections.every((capture) => capture.state === "unavailable")
      ? "unavailable"
      : "partial";
}

export function createGoogleTrendsMcpCapture(
  options: GoogleTrendsMcpCaptureOptions,
): (input: CaptureInput) => Promise<GoogleExploreBatch> {
  return async (input) => {
    const server = options.createServer();
    const runtime = new GoogleBrowserRuntime(
      server,
      input.parentToolCallId,
      options.onOperation,
    );
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

    await server.connect();
    try {
      try {
        await runtime.call("browser_navigate", { url: input.exploreUrl }, input.signal);
        await runtime.call("browser_wait_for", { time: 3 }, input.signal);
        const evaluated = await runtime.call(
          "browser_evaluate",
          { function: buildGoogleRenderedScreenFunction(input.candidates) },
          input.signal,
        );
        screen = parseGoogleRenderedScreen(evaluated.text);
        if (screen.bodyState === "ready") {
          const screens = [screen];
          const initialMissing = missingGoogleCardModes(screen, input.candidates);
          for (const mode of ["top", "rising"] as const) {
            const expectedCount = initialMissing.filter(
              (missing) => missing.mode === mode,
            ).length;
            if (expectedCount === 0) {
              continue;
            }
            const modeSnapshot = await runtime.call(
              "browser_snapshot",
              {},
              input.signal,
            );
            const targets = findGoogleCardModeTargets(modeSnapshot.text, mode);
            if (targets.length !== expectedCount) {
              throw new Error(
                `Google selector cardinality drift: ${mode} targets=${targets.length}, expected=${expectedCount}`,
              );
            }
            for (const target of targets) {
              await runtime.call(
                "browser_click",
                {
                  target: target.ref,
                  element: `Google Related card ${mode} mode`,
                },
                input.signal,
              );
            }
            await runtime.call("browser_wait_for", { time: 1 }, input.signal);
            const modeEvaluation = await runtime.call(
              "browser_evaluate",
              { function: buildGoogleRenderedScreenFunction(input.candidates) },
              input.signal,
            );
            screens.push(parseGoogleRenderedScreen(modeEvaluation.text));
          }
          screen = mergeGoogleRenderedScreens(screens, input.candidates);
        }
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
          const snapshot = await runtime.call("browser_snapshot", {}, input.signal);
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
            const rawArtifactId = `google_csv_${randomUUID()}`;
            const initiatedAt = new Date().toISOString();
            const clicked = await runtime.call(
              "browser_click",
              {
                target: downloadTarget,
                element: "Interest over time CSV download",
              },
              input.signal,
            );
            const downloaded = await waitForStableCsvDownload({
              runId: input.runId,
              parentToolCallId: input.parentToolCallId,
              clickOperationId: clicked.operation.operationId,
              outputDirectory: options.outputDirectory,
              preClickEntries,
              rawArtifactId,
              initiatedAt,
              timeoutMs: options.downloadTimeoutMs,
              pollMs: options.downloadPollMs,
              stableSamples: options.downloadStableSamples,
              signal: input.signal,
            });
            options.onDownloadReceipt?.(downloaded.receipt);
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
              downloadReceiptSha256: downloaded.receipt.receiptSha256,
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
        const reason = classifyFailure(error);
        warningCodes.add(`google_${reason}`);
        if (!screen) {
          screenCaptures = allUnavailableCaptures(input, reason);
          screenExtraction = {
            schemaVersion: "1.0",
            state: "unavailable",
            reasonCode: reason,
            errorMessage: error instanceof Error ? error.message : String(error),
          };
        } else {
          screenCaptures = extractGoogleRenderedCaptures(
            screen,
            input.candidates,
          ).captures;
        }
        interest = unavailableInterest(reason);
        interestSeriesByCandidateId = null;
        csvArtifact = null;
      }
    } finally {
      await server.close();
    }

    const captures = screenCaptures!;
    const extraction = screenExtraction ?? {
      schemaVersion: "1.0",
      state: "unavailable",
      reasonCode: "navigation_failed",
    };
    const screenArtifactId = `google_screen_${randomUUID()}`;
    const screenSha256 = sha256Canonical(extraction);
    const extractorReceiptSha256 = sha256Canonical({
      schemaVersion: "1.0",
      extractorId: "google-trends-explore-extractor-v1",
      orderedOperationIds: runtime.operationLog.map(
        (operation) => operation.operationId,
      ),
      operationResultsSha256: sha256Canonical(
        runtime.operationLog.map((operation) => operation.resultSha256),
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

    return GoogleExploreBatchSchema.parse({
      config: input.config,
      requestedCandidates: input.candidates,
      observations,
      rawArtifacts,
      status: batchStatus(captures, observations[0]?.interestOverTime ?? interest),
    });
  };
}
