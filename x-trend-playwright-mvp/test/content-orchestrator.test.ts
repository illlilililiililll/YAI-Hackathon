import { describe, expect, it, vi } from "vitest";

import {
  ContentOrchestrator,
  consumeSdkStream,
  type ContentPipelinePorts,
  type PipelineArtifactMap,
} from "../src/content-orchestrator.js";
import { InMemoryRawEventPort } from "../src/raw-event-port.js";
import { RawEventIngress } from "../src/raw-event-ingress.js";

type Artifacts = PipelineArtifactMap & {
  x: string;
  candidates: string;
  google: string;
  selection: string;
  evidence: string;
  draft: string;
  quality: string;
  render: string;
};

type PreviewArtifacts = {
  draft: string;
  render: string;
};

function livePorts(): ContentPipelinePorts<Artifacts> {
  return {
    signals: {
      collectX: async () => ({ outcome: "ok", value: "x", provenanceMode: "live" }),
      clusterTopics: async () => ({ outcome: "ok", value: "candidates", provenanceMode: "live" }),
      evaluateGoogle: async () => ({ outcome: "ok", value: "google", provenanceMode: "live" }),
      selectTopic: async () => ({ outcome: "ok", value: "selection", provenanceMode: "live" }),
    },
    evidence: {
      research: async () => ({ outcome: "ok", value: "evidence", provenanceMode: "live" }),
      verify: async () => ({ outcome: "ok", value: "evidence", provenanceMode: "live" }),
    },
    writer: {
      draft: async () => ({ outcome: "ok", value: "draft", provenanceMode: "live" }),
      qualityCheck: async () => ({ outcome: "ok", value: "quality", provenanceMode: "live" }),
      render: async () => ({ outcome: "ok", value: "render", provenanceMode: "live" }),
    },
    output: {
      persist: async () => ({
        outcome: "ready_to_publish",
        manifestPath: "private/manifest.json",
        contentRevisionSha256: "a".repeat(64),
        provenanceMode: "live",
      }),
    },
  };
}

describe("ContentOrchestrator", () => {
  it("owns the complete state sequence and reaches ready only for live stages", async () => {
    const ingress = new RawEventIngress({
      runId: "run_00000000-0000-4000-8000-000000000001",
      secrets: ["secret"],
      port: new InMemoryRawEventPort(),
    });
    const orchestrator = new ContentOrchestrator({
      runId: "run_00000000-0000-4000-8000-000000000001",
      request: {
        schemaVersion: "1.0",
        domain: "travel",
        locale: "ko-KR",
        seedKeyword: "여행",
      },
      ports: livePorts(),
      rawEvents: ingress,
      wallClockMs: 5_000,
    });

    const result = await orchestrator.run();
    expect(result.status).toBe("ready_to_publish");
    expect(result.stageHistory).toEqual([
      "validating_input",
      "collecting_x",
      "clustering_topics",
      "evaluating_google",
      "selecting_topic",
      "researching",
      "verifying",
      "drafting",
      "quality_checking",
      "rendering",
      "persisting",
      "ready_to_publish",
    ]);
  });

  it("never calls persistence when any required stage is non-live", async () => {
    const ports = livePorts();
    ports.signals.collectX = async () => ({
      outcome: "ok",
      value: "x",
      provenanceMode: "mock",
    });
    const persist = vi.fn(ports.output.persist);
    ports.output.persist = persist;
    const orchestrator = new ContentOrchestrator({
      runId: "run_00000000-0000-4000-8000-000000000001",
      request: {
        schemaVersion: "1.0",
        domain: "travel",
        locale: "ko-KR",
        seedKeyword: "여행",
      },
      ports,
      rawEvents: new RawEventIngress({
        runId: "run_00000000-0000-4000-8000-000000000001",
        secrets: ["secret"],
        port: new InMemoryRawEventPort(),
      }),
      wallClockMs: 5_000,
    });

    const result = await orchestrator.run();
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("non_live_publish_forbidden");
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the normal verified path fail-closed when evidence is insufficient", async () => {
    const ports = livePorts();
    const draft = vi.fn(ports.writer.draft);
    const persist = vi.fn(ports.output.persist);
    ports.evidence.verify = async () => ({
      outcome: "needs_evidence",
      code: "evidence_not_sufficient",
    });
    ports.writer.draft = draft;
    ports.output.persist = persist;
    const orchestrator = new ContentOrchestrator({
      runId: "run_00000000-0000-4000-8000-000000000001",
      request: {
        schemaVersion: "1.0",
        domain: "travel",
        locale: "ko-KR",
        seedKeyword: "여행",
      },
      ports,
      rawEvents: new RawEventIngress({
        runId: "run_00000000-0000-4000-8000-000000000001",
        secrets: ["secret"],
        port: new InMemoryRawEventPort(),
      }),
      wallClockMs: 5_000,
    });

    const result = await orchestrator.run();
    expect(result.status).toBe("needs_evidence");
    expect(result.errorCode).toBe("evidence_not_sufficient");
    expect(draft).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("runs the live signal path and commits an isolated unverified preview without RunStore", async () => {
    const base = livePorts();
    const publishPersist = vi.fn(base.output.persist);
    const previewPersist = vi.fn(async () => ({
      outcome: "unverified_preview_ready" as const,
      previewDirectory: "/tmp/preview-run",
      executionMode: "live" as const,
      provenanceMode: "replay" as const,
      warningCodes: ["external_evidence_verification_skipped"],
      publishable: false as const,
    }));
    const ports: ContentPipelinePorts<Artifacts, PreviewArtifacts> = {
      ...base,
      output: { persist: publishPersist },
      unverifiedPreview: {
        draft: async () => ({ outcome: "ok", value: "preview-draft", provenanceMode: "replay" }),
        render: async ({ draft }) => ({
          outcome: "ok",
          value: `${draft}-rendered`,
          provenanceMode: "replay",
        }),
        persist: previewPersist,
      },
    };
    const orchestrator = new ContentOrchestrator<Artifacts, PreviewArtifacts>({
      runId: "run_00000000-0000-4000-8000-000000000001",
      request: {
        schemaVersion: "1.0",
        domain: "travel",
        locale: "ko-KR",
        seedKeyword: "유럽 패키지 여행",
      },
      ports,
      rawEvents: new RawEventIngress({
        runId: "run_00000000-0000-4000-8000-000000000001",
        secrets: ["secret"],
        port: new InMemoryRawEventPort(),
      }),
      wallClockMs: 5_000,
    });

    const result = await orchestrator.run();
    expect(result).toMatchObject({
      status: "unverified_preview_ready",
      previewDirectory: "/tmp/preview-run",
      executionMode: "live",
      provenanceMode: "replay",
      publishable: false,
    });
    expect(result.stageHistory).toEqual([
      "validating_input",
      "collecting_x",
      "clustering_topics",
      "evaluating_google",
      "selecting_topic",
      "drafting_unverified_preview",
      "rendering_unverified_preview",
      "persisting_unverified_preview",
      "unverified_preview_ready",
    ]);
    expect(previewPersist).toHaveBeenCalledOnce();
    expect(publishPersist).not.toHaveBeenCalled();
  });

  it("consumes a fake SDK stream through the same raw ingress", async () => {
    const ingress = new RawEventIngress({
      runId: "run_00000000-0000-4000-8000-000000000001",
      secrets: ["secret"],
      port: new InMemoryRawEventPort(),
    });
    const stream = {
      finalOutput: { ok: true },
      error: undefined,
      completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: "raw_model_stream_event",
          source: "openai-responses",
          data: { type: "model", value: "safe" },
        };
      },
    };

    await expect(consumeSdkStream(stream, ingress)).resolves.toEqual({ ok: true });
    expect((await ingress.seal()).receipt.eventCount).toBe(1);
  });

  it("enforces the global deadline even when a stage ignores AbortSignal", async () => {
    const ports = livePorts();
    ports.signals.collectX = async () => new Promise(() => {});
    const orchestrator = new ContentOrchestrator({
      runId: "run_00000000-0000-4000-8000-000000000001",
      request: {
        schemaVersion: "1.0",
        domain: "travel",
        locale: "ko-KR",
        seedKeyword: "여행",
      },
      ports,
      rawEvents: new RawEventIngress({
        runId: "run_00000000-0000-4000-8000-000000000001",
        secrets: ["secret"],
        port: new InMemoryRawEventPort(),
      }),
      wallClockMs: 10,
    });

    const result = await orchestrator.run();
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("deadline_exceeded");
  });
});
