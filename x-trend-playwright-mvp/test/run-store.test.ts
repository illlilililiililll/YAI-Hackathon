import { lstat, mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RunStore,
  SUCCESS_ARTIFACT_PATHS,
  type RunStoreCommitInput,
} from "../src/run-store.js";
import { sha256Bytes } from "../src/canonical-json.js";

function commitInput(runId: string): RunStoreCommitInput {
  const artifacts = SUCCESS_ARTIFACT_PATHS.map((artifactPath) => ({
    path: artifactPath,
    bytes:
      artifactPath === "private/events.jsonl"
        ? new Uint8Array()
        : new TextEncoder().encode(`${artifactPath}\n`),
  }));
  const emptyHash = sha256Bytes(new Uint8Array());
  return {
    runId,
    generatedAt: "2026-08-02T00:00:00.000Z",
    contentRevisionSha256: "a".repeat(64),
    personaSnapshotSha256: "b".repeat(64),
    executionTrustPolicySha256: "c".repeat(64),
    provenanceMode: "live",
    artifacts,
    rawJournalReceipt: {
      schemaVersion: "1.0",
      runId,
      firstSeq: null,
      lastSeq: 0,
      eventCount: 0,
      orderedEventSha256: emptyHash,
      fileByteLength: 0,
      fileSha256: emptyHash,
      sealedAt: "2026-08-02T00:00:00.000Z",
    },
  };
}

describe("RunStore", () => {
  it("writes manifest last, atomically renames, and rehashes the final tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yai-run-store-"));
    const store = new RunStore({
      outputRoot: root,
      validateLiveProvenance: async () => true,
    });
    const input = commitInput("run_00000000-0000-4000-8000-000000000001");
    const outcome = await store.commit(input);

    expect(outcome.status).toBe("ready_to_publish");
    const finalRoot = path.join(root, "runs", input.runId);
    expect((await lstat(finalRoot)).isDirectory()).toBe(true);
    const manifest = JSON.parse(
      await readFile(path.join(finalRoot, "private", "manifest.json"), "utf8"),
    );
    expect(manifest.terminalIntent).toBe("ready_to_publish");
    expect(manifest.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(
      SUCCESS_ARTIFACT_PATHS,
    );
  });

  it("rejects non-live commits before creating a success tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yai-run-store-"));
    const store = new RunStore({
      outputRoot: root,
      validateLiveProvenance: async () => true,
    });
    const input = {
      ...commitInput("run_00000000-0000-4000-8000-000000000002"),
      provenanceMode: "mock" as const,
    };
    await expect(store.commit(input)).rejects.toThrow(/non-live/u);
  });

  it("rejects a symlinked managed directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yai-run-store-"));
    const target = await mkdtemp(path.join(tmpdir(), "yai-run-store-target-"));
    await mkdir(path.join(root, ".staging"), { mode: 0o700 });
    await symlink(target, path.join(root, "runs"));
    const store = new RunStore({
      outputRoot: root,
      validateLiveProvenance: async () => true,
    });
    await expect(
      store.commit(commitInput("run_00000000-0000-4000-8000-000000000003")),
    ).rejects.toThrow(/symbolic link|symlink/u);
  });
});
