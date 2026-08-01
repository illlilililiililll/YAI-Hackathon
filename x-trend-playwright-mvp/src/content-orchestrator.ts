import {
  ALLOWED_TRANSITIONS,
  NormalizedRequestV1Schema,
  type NormalizedRequestV1,
  type ProviderMode,
  type RunStatus,
  type TerminalStatus,
} from "./content-domain.js";
import {
  RawEventIngress,
  type SealedRawJournal,
} from "./raw-event-ingress.js";

export interface PipelineArtifactMap {
  x: unknown;
  candidates: unknown;
  google: unknown;
  selection: unknown;
  evidence: unknown;
  draft: unknown;
  quality: unknown;
  render: unknown;
}

export type StageSuccess<T> = {
  outcome: "ok";
  value: T;
  provenanceMode: ProviderMode;
};

export type StageTerminal = {
  outcome: "needs_evidence" | "no_viable_topic" | "source_blocked" | "failed";
  code: string;
  message?: string;
};

export type VerificationResult<T> =
  | StageSuccess<T>
  | StageTerminal
  | { outcome: "retry"; code: string };

export type QualityResult<T> =
  | StageSuccess<T>
  | StageTerminal
  | { outcome: "repair"; code: string };

export type StageContext = {
  runId: string;
  request: NormalizedRequestV1;
  signal: AbortSignal;
  rawEvents: RawEventIngress;
  attempt: number;
};

export type ContentPipelinePorts<T extends PipelineArtifactMap> = {
  signals: {
    collectX(context: StageContext): Promise<StageSuccess<T["x"]> | StageTerminal>;
    clusterTopics(
      context: StageContext & { x: T["x"] },
    ): Promise<StageSuccess<T["candidates"]> | StageTerminal>;
    evaluateGoogle(
      context: StageContext & { candidates: T["candidates"] },
    ): Promise<StageSuccess<T["google"]> | StageTerminal>;
    selectTopic(
      context: StageContext & {
        candidates: T["candidates"];
        google: T["google"];
      },
    ): Promise<StageSuccess<T["selection"]> | StageTerminal>;
  };
  evidence: {
    research(
      context: StageContext & { selection: T["selection"] },
    ): Promise<StageSuccess<T["evidence"]> | StageTerminal>;
    verify(
      context: StageContext & {
        selection: T["selection"];
        evidence: T["evidence"];
      },
    ): Promise<VerificationResult<T["evidence"]>>;
  };
  writer: {
    draft(
      context: StageContext & {
        selection: T["selection"];
        evidence: T["evidence"];
        repairAttempt: 0 | 1;
      },
    ): Promise<StageSuccess<T["draft"]> | StageTerminal>;
    qualityCheck(
      context: StageContext & {
        evidence: T["evidence"];
        draft: T["draft"];
      },
    ): Promise<QualityResult<T["quality"]>>;
    render(
      context: StageContext & {
        draft: T["draft"];
        quality: T["quality"];
      },
    ): Promise<StageSuccess<T["render"]> | StageTerminal>;
  };
  output: {
    persist(
      context: StageContext & {
        artifacts: T;
        rawJournal: SealedRawJournal;
      },
    ): Promise<
      | {
          outcome: "ready_to_publish";
          manifestPath: "private/manifest.json";
          contentRevisionSha256: string;
          provenanceMode: ProviderMode;
        }
      | StageTerminal
    >;
  };
};

export type OrchestratorOutcome = {
  runId: string;
  status: TerminalStatus;
  stageHistory: RunStatus[];
  manifestPath?: "private/manifest.json";
  contentRevisionSha256?: string;
  errorCode?: string;
  message?: string;
};

export type ContentOrchestratorOptions<T extends PipelineArtifactMap> = {
  runId: string;
  request: NormalizedRequestV1;
  ports: ContentPipelinePorts<T>;
  rawEvents: RawEventIngress;
  wallClockMs: number;
  stageRetryMax?: 0 | 1;
  signal?: AbortSignal;
  onTransition?: (status: RunStatus) => void;
};

export type SdkStreamLike<T> = AsyncIterable<unknown> & {
  completed: Promise<unknown>;
  finalOutput?: T;
  error?: unknown;
};

export async function consumeSdkStream<T>(
  stream: SdkStreamLike<T>,
  ingress: RawEventIngress,
): Promise<T> {
  for await (const event of stream) {
    await ingress.accept(event);
  }
  await stream.completed;
  if (stream.error) throw stream.error;
  if (stream.finalOutput === undefined) {
    throw new Error("Agents SDK stream finalOutput이 없습니다.");
  }
  return stream.finalOutput;
}

class OrchestratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

async function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Run이 중단되었습니다."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isTerminalResult(value: { outcome: string }): value is StageTerminal {
  return ["needs_evidence", "no_viable_topic", "source_blocked", "failed"].includes(
    value.outcome,
  );
}

export class ContentOrchestrator<T extends PipelineArtifactMap> {
  private current: RunStatus = "validating_input";
  private readonly history: RunStatus[] = ["validating_input"];
  private readonly provenanceModes: ProviderMode[] = [];
  private sealedRawJournal: SealedRawJournal | undefined;

  constructor(private readonly options: ContentOrchestratorOptions<T>) {
    if (!Number.isInteger(options.wallClockMs) || options.wallClockMs < 1) {
      throw new Error("wallClockMs는 양의 정수여야 합니다.");
    }
  }

  private transition(next: RunStatus): void {
    if (!ALLOWED_TRANSITIONS[this.current].includes(next)) {
      throw new OrchestratorError(
        "invalid_state_transition",
        `${this.current} -> ${next} 전이는 허용되지 않습니다.`,
      );
    }
    this.current = next;
    this.history.push(next);
    this.options.onTransition?.(next);
  }

  private context(signal: AbortSignal, attempt: number): StageContext {
    return {
      runId: this.options.runId,
      request: this.options.request,
      signal,
      rawEvents: this.options.rawEvents,
      attempt,
    };
  }

  private async invokeWithRetry<R>(
    signal: AbortSignal,
    invoke: (attempt: number) => Promise<R>,
  ): Promise<R> {
    const retryMax = this.options.stageRetryMax ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryMax; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await awaitAbortable(invoke(attempt), signal);
      } catch (error) {
        lastError = error;
        if (attempt === retryMax) break;
      }
    }
    throw lastError;
  }

  private remember(mode: ProviderMode): void {
    this.provenanceModes.push(mode);
  }

  private async sealRaw(): Promise<SealedRawJournal> {
    if (!this.sealedRawJournal) {
      this.sealedRawJournal = await this.options.rawEvents.seal();
    }
    return this.sealedRawJournal;
  }

  private terminal(
    status: TerminalStatus,
    code?: string,
    message?: string,
  ): OrchestratorOutcome {
    return {
      runId: this.options.runId,
      status,
      stageHistory: [...this.history],
      ...(code ? { errorCode: code } : {}),
      ...(message ? { message } : {}),
    };
  }

  private async finishStageTerminal(result: StageTerminal): Promise<OrchestratorOutcome> {
    await this.sealRaw();
    this.transition(result.outcome);
    return this.terminal(result.outcome, result.code, result.message);
  }

  async run(): Promise<OrchestratorOutcome> {
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () =>
        deadlineController.abort(
          new OrchestratorError("deadline_exceeded", "Run wall-clock deadline을 초과했습니다."),
        ),
      this.options.wallClockMs,
    );
    deadlineTimer.unref();
    const signal = this.options.signal
      ? AbortSignal.any([deadlineController.signal, this.options.signal])
      : deadlineController.signal;

    try {
      NormalizedRequestV1Schema.parse(this.options.request);
      this.transition("collecting_x");
      const xResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.signals.collectX(this.context(signal, attempt)),
      );
      if (isTerminalResult(xResult)) return await this.finishStageTerminal(xResult);
      this.remember(xResult.provenanceMode);

      this.transition("clustering_topics");
      const candidatesResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.signals.clusterTopics({
          ...this.context(signal, attempt),
          x: xResult.value,
        }),
      );
      if (isTerminalResult(candidatesResult)) {
        return await this.finishStageTerminal(candidatesResult);
      }
      this.remember(candidatesResult.provenanceMode);

      this.transition("evaluating_google");
      const googleResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.signals.evaluateGoogle({
          ...this.context(signal, attempt),
          candidates: candidatesResult.value,
        }),
      );
      if (isTerminalResult(googleResult)) {
        return await this.finishStageTerminal(googleResult);
      }
      this.remember(googleResult.provenanceMode);

      this.transition("selecting_topic");
      const selectionResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.signals.selectTopic({
          ...this.context(signal, attempt),
          candidates: candidatesResult.value,
          google: googleResult.value,
        }),
      );
      if (isTerminalResult(selectionResult)) {
        return await this.finishStageTerminal(selectionResult);
      }
      this.remember(selectionResult.provenanceMode);

      this.transition("researching");
      let evidenceResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.evidence.research({
          ...this.context(signal, attempt),
          selection: selectionResult.value,
        }),
      );
      if (isTerminalResult(evidenceResult)) {
        return await this.finishStageTerminal(evidenceResult);
      }
      this.remember(evidenceResult.provenanceMode);
      let evidenceValue = evidenceResult.value;

      this.transition("verifying");
      let verification = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.evidence.verify({
          ...this.context(signal, attempt),
          selection: selectionResult.value,
          evidence: evidenceValue,
        }),
      );
      if (verification.outcome === "retry") {
        this.transition("researching");
        evidenceResult = await this.invokeWithRetry(signal, (attempt) =>
          this.options.ports.evidence.research({
            ...this.context(signal, attempt),
            selection: selectionResult.value,
          }),
        );
        if (isTerminalResult(evidenceResult)) {
          return await this.finishStageTerminal(evidenceResult);
        }
        this.remember(evidenceResult.provenanceMode);
        evidenceValue = evidenceResult.value;
        this.transition("verifying");
        verification = await this.invokeWithRetry(signal, (attempt) =>
          this.options.ports.evidence.verify({
            ...this.context(signal, attempt),
            selection: selectionResult.value,
            evidence: evidenceValue,
          }),
        );
        if (verification.outcome === "retry") {
          return await this.finishStageTerminal({
            outcome: "needs_evidence",
            code: verification.code,
          });
        }
      }
      if (isTerminalResult(verification)) {
        return await this.finishStageTerminal(verification);
      }
      this.remember(verification.provenanceMode);
      const verifiedEvidence = verification.value;

      this.transition("drafting");
      let draftResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.writer.draft({
          ...this.context(signal, attempt),
          selection: selectionResult.value,
          evidence: verifiedEvidence,
          repairAttempt: 0,
        }),
      );
      if (isTerminalResult(draftResult)) {
        return await this.finishStageTerminal(draftResult);
      }
      this.remember(draftResult.provenanceMode);
      let draftValue = draftResult.value;

      this.transition("quality_checking");
      let qualityResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.writer.qualityCheck({
          ...this.context(signal, attempt),
          evidence: verifiedEvidence,
          draft: draftValue,
        }),
      );
      if (qualityResult.outcome === "repair") {
        this.transition("drafting");
        draftResult = await this.invokeWithRetry(signal, (attempt) =>
          this.options.ports.writer.draft({
            ...this.context(signal, attempt),
            selection: selectionResult.value,
            evidence: verifiedEvidence,
            repairAttempt: 1,
          }),
        );
        if (isTerminalResult(draftResult)) {
          return await this.finishStageTerminal(draftResult);
        }
        this.remember(draftResult.provenanceMode);
        draftValue = draftResult.value;
        this.transition("quality_checking");
        qualityResult = await this.invokeWithRetry(signal, (attempt) =>
          this.options.ports.writer.qualityCheck({
            ...this.context(signal, attempt),
            evidence: verifiedEvidence,
            draft: draftValue,
          }),
        );
        if (qualityResult.outcome === "repair") {
          throw new OrchestratorError(
            "repair_exhausted",
            "Writer repair 1회 뒤에도 품질 Gate가 실패했습니다.",
          );
        }
      }
      if (isTerminalResult(qualityResult)) {
        return await this.finishStageTerminal(qualityResult);
      }
      this.remember(qualityResult.provenanceMode);

      const rawJournal = await this.sealRaw();
      this.transition("rendering");
      const renderResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.writer.render({
          ...this.context(signal, attempt),
          draft: draftValue,
          quality: qualityResult.value,
        }),
      );
      if (isTerminalResult(renderResult)) {
        this.transition(renderResult.outcome);
        return this.terminal(
          renderResult.outcome,
          renderResult.code,
          renderResult.message,
        );
      }
      this.remember(renderResult.provenanceMode);

      const artifacts = {
        x: xResult.value,
        candidates: candidatesResult.value,
        google: googleResult.value,
        selection: selectionResult.value,
        evidence: verifiedEvidence,
        draft: draftValue,
        quality: qualityResult.value,
        render: renderResult.value,
      } as T;

      this.transition("persisting");
      if (this.provenanceModes.some((mode) => mode !== "live")) {
        throw new OrchestratorError(
          "non_live_publish_forbidden",
          "non-live stage가 포함된 Run은 ready_to_publish로 저장할 수 없습니다.",
        );
      }
      const persistResult = await this.invokeWithRetry(signal, (attempt) =>
        this.options.ports.output.persist({
          ...this.context(signal, attempt),
          artifacts,
          rawJournal,
        }),
      );
      if (isTerminalResult(persistResult)) {
        this.transition(persistResult.outcome);
        return this.terminal(
          persistResult.outcome,
          persistResult.code,
          persistResult.message,
        );
      }
      if (persistResult.provenanceMode !== "live") {
        throw new OrchestratorError(
          "non_live_publish_forbidden",
          "RunStore가 non-live 결과를 ready로 반환했습니다.",
        );
      }
      this.transition("ready_to_publish");
      return {
        runId: this.options.runId,
        status: "ready_to_publish",
        stageHistory: [...this.history],
        manifestPath: persistResult.manifestPath,
        contentRevisionSha256: persistResult.contentRevisionSha256,
      };
    } catch (error) {
      try {
        await this.sealRaw();
      } catch (sealError) {
        error = new OrchestratorError(
          "raw_journal_seal_failed",
          sealError instanceof Error ? sealError.message : String(sealError),
        );
      }
      if (![
        "ready_to_publish",
        "needs_evidence",
        "no_viable_topic",
        "source_blocked",
        "failed",
      ].includes(this.current)) {
        this.transition("failed");
      }
      const code = error instanceof OrchestratorError ? error.code : "stage_failed";
      const message = error instanceof Error ? error.message : String(error);
      return this.terminal("failed", code, message);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
