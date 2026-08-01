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
