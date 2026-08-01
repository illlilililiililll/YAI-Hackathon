import type {
  BrowserOperationEnvelope,
  ProviderMode,
  RunStatus,
} from "./content-domain.js";

export type ArticleProgressEvent =
  | Readonly<{
      type: "commercial_context";
      runId: string;
      executionMode: "live";
      provenanceMode: ProviderMode;
      searchTopic: string;
      fields: Readonly<
        Record<string, Readonly<{ value: string; source: "explicit" | "inferred" | "default" }>>
      >;
      at: string;
    }>
  | Readonly<{
      type: "pipeline_stage";
      runId: string;
      stage: RunStatus;
      executionMode: "live";
      provenanceMode: ProviderMode;
      at: string;
    }>
  | Readonly<{
      type: "browser_operation";
      runId: string;
      site: "x" | "google_trends";
      seq: number;
      phase: "call" | "result";
      toolName: string;
      operationId: string;
      at: string;
    }>;

export function projectBrowserOperationLog(
  envelope: BrowserOperationEnvelope,
): ArticleProgressEvent {
  return {
    type: "browser_operation",
    runId: envelope.runId,
    site: envelope.operation.site,
    seq: envelope.seq,
    phase: envelope.operation.phase,
    toolName:
      envelope.operation.phase === "call"
        ? envelope.operation.request.toolName
        : envelope.operation.toolName,
    operationId: envelope.operation.operationId,
    at: envelope.observedAt,
  };
}

export function writeArticleProgress(
  output: NodeJS.WritableStream,
  event: ArticleProgressEvent,
): void {
  const line = `${JSON.stringify(event)}\n`;
  output.write(line);
}
