import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";

import {
  FrozenRawJournalReceiptV1Schema,
  type FrozenRawJournalReceiptV1,
  type ProviderMode,
} from "./content-domain.js";
import { canonicalJson, sha256Bytes } from "./canonical-json.js";

export const SUCCESS_ARTIFACT_PATHS = [
  "public/index.html",
  "public/styles.css",
  "private/run.json",
  "private/signals.json",
  "private/evidence.json",
  "private/quality.json",
  "private/article.json",
  "private/events.jsonl",
  "private/operations.jsonl",
] as const;

export type SuccessArtifactPath = (typeof SUCCESS_ARTIFACT_PATHS)[number];

export type RunStoreArtifactInput = {
  path: SuccessArtifactPath;
  bytes: Uint8Array;
};

export type RunStoreCommitInput = {
  runId: string;
  generatedAt: string;
  contentRevisionSha256: string;
  personaSnapshotSha256: string;
  executionTrustPolicySha256: string;
  provenanceMode: ProviderMode;
  rawJournalReceipt: FrozenRawJournalReceiptV1;
  artifacts: readonly RunStoreArtifactInput[];
};

export type RunStoreOutcome = {
  runId: string;
  status: "ready_to_publish";
  manifestPath: "private/manifest.json";
  contentRevisionSha256: string;
  runDirectory: string;
};

export type RunStoreOptions = {
  outputRoot: string;
  validateLiveProvenance(input: RunStoreCommitInput): Promise<boolean>;
};

const RUN_ID_PATTERN =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type ManifestArtifact = {
  path: SuccessArtifactPath;
  byteLength: number;
  sha256: string;
};

type MinimalSuccessManifest = {
  schemaVersion: "1.0";
  runId: string;
  generatedAt: string;
  terminalIntent: "ready_to_publish";
  executionMode: "live";
  contentRevisionSha256: string;
  personaSnapshotSha256: string;
  executionTrustPolicySha256: string;
  rawJournal: FrozenRawJournalReceiptV1;
  artifacts: ManifestArtifact[];
};

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertDirectoryNoSymlink(target: string): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`RunStore managed directory cannot be a symbolic link: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`RunStore managed path is not a directory: ${target}`);
  }
}

async function ensureManagedDirectory(target: string): Promise<string> {
  if (!(await lstatOrNull(target))) {
    await mkdir(target, { recursive: false, mode: 0o700 });
  }
  await assertDirectoryNoSymlink(target);
  return realpath(target);
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await open(target, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveDirectChild(parentRealPath: string, childName: string): string {
  const target = path.resolve(parentRealPath, childName);
  if (
    path.dirname(target) !== parentRealPath ||
    path.basename(target) !== childName
  ) {
    throw new Error("RunStore target is not a direct child of its managed parent.");
  }
  return target;
}

async function writeExclusive(target: string, bytes: Uint8Array): Promise<void> {
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    constants.O_NOFOLLOW;
  const handle = await open(target, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`RunStore artifact is not a regular file: ${target}`);
  }
  const readBack = await readFile(target);
  if (
    readBack.byteLength !== bytes.byteLength ||
    sha256Bytes(readBack) !== sha256Bytes(bytes)
  ) {
    throw new Error(`RunStore artifact read-back hash mismatch: ${target}`);
  }
}

function validateInput(input: RunStoreCommitInput): void {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error("RunStore runId가 lower UUIDv4 grammar와 다릅니다.");
  }
  if (input.provenanceMode !== "live") {
    throw new Error("RunStore는 non-live Run을 ready_to_publish로 commit하지 않습니다.");
  }
  for (const hash of [
    input.contentRevisionSha256,
    input.personaSnapshotSha256,
    input.executionTrustPolicySha256,
  ]) {
    if (!SHA256_PATTERN.test(hash)) throw new Error("RunStore metadata hash가 잘못되었습니다.");
  }
  if (
    input.artifacts.length !== SUCCESS_ARTIFACT_PATHS.length ||
    input.artifacts.some(
      (artifact, index) => artifact.path !== SUCCESS_ARTIFACT_PATHS[index],
    )
  ) {
    throw new Error("RunStore artifacts는 closed required path order와 같아야 합니다.");
  }
  const rawReceipt = FrozenRawJournalReceiptV1Schema.parse(
    input.rawJournalReceipt,
  );
  if (rawReceipt.runId !== input.runId) {
    throw new Error("Raw journal receipt runId가 commit runId와 다릅니다.");
  }
  const events = input.artifacts.find(
    (artifact) => artifact.path === "private/events.jsonl",
  );
  if (
    !events ||
    events.bytes.byteLength !== rawReceipt.fileByteLength ||
    sha256Bytes(events.bytes) !== rawReceipt.fileSha256
  ) {
    throw new Error("events.jsonl exact bytes가 sealed raw receipt와 다릅니다.");
  }
}

async function assertExactEntries(
  directory: string,
  expected: readonly string[],
): Promise<void> {
  const entries = (await readdir(directory)).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(entries) !== JSON.stringify(sortedExpected)) {
    throw new Error(`RunStore closed tree entry mismatch: ${directory}`);
  }
  for (const entry of entries) {
    const stat = await lstat(path.join(directory, entry));
    if (stat.isSymbolicLink()) {
      throw new Error(`RunStore closed tree contains symlink: ${entry}`);
    }
  }
}

export class RunStore {
  private readonly outputRoot: string;
  private readonly validateLiveProvenance: RunStoreOptions["validateLiveProvenance"];

  constructor(options: RunStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot);
    this.validateLiveProvenance = options.validateLiveProvenance;
  }

  async commit(input: RunStoreCommitInput): Promise<RunStoreOutcome> {
    validateInput(input);
    if (!(await this.validateLiveProvenance(input))) {
      throw new Error("RunStore live provenance validator가 commit을 거절했습니다.");
    }
    if (!(await lstatOrNull(this.outputRoot))) {
      await mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
    }
    await assertDirectoryNoSymlink(this.outputRoot);
    const rootRealPath = await realpath(this.outputRoot);
    const stagingParent = await ensureManagedDirectory(
      path.join(rootRealPath, ".staging"),
    );
    const runsParent = await ensureManagedDirectory(path.join(rootRealPath, "runs"));
    if (
      path.dirname(stagingParent) !== rootRealPath ||
      path.dirname(runsParent) !== rootRealPath
    ) {
      throw new Error("RunStore managed parents escaped the trusted output root.");
    }

    const stagingRoot = resolveDirectChild(stagingParent, input.runId);
    const finalRoot = resolveDirectChild(runsParent, input.runId);
    if ((await lstatOrNull(stagingRoot)) || (await lstatOrNull(finalRoot))) {
      throw new Error("RunStore runId target already exists.");
    }
    await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    const publicDirectory = path.join(stagingRoot, "public");
    const privateDirectory = path.join(stagingRoot, "private");
    await mkdir(publicDirectory, { recursive: false, mode: 0o700 });
    await mkdir(privateDirectory, { recursive: false, mode: 0o700 });

    const manifestArtifacts: ManifestArtifact[] = [];
    for (const artifact of input.artifacts) {
      const bytes = Uint8Array.from(artifact.bytes);
      const target = path.join(stagingRoot, artifact.path);
      const expectedParent = artifact.path.startsWith("public/")
        ? publicDirectory
        : privateDirectory;
      if (path.dirname(target) !== expectedParent) {
        throw new Error("RunStore artifact path escaped its expected parent.");
      }
      await writeExclusive(target, bytes);
      manifestArtifacts.push({
        path: artifact.path,
        byteLength: bytes.byteLength,
        sha256: sha256Bytes(bytes),
      });
    }

    await syncDirectory(publicDirectory);
    await syncDirectory(privateDirectory);
    await syncDirectory(stagingRoot);

    const manifest: MinimalSuccessManifest = {
      schemaVersion: "1.0",
      runId: input.runId,
      generatedAt: input.generatedAt,
      terminalIntent: "ready_to_publish",
      executionMode: "live",
      contentRevisionSha256: input.contentRevisionSha256,
      personaSnapshotSha256: input.personaSnapshotSha256,
      executionTrustPolicySha256: input.executionTrustPolicySha256,
      rawJournal: FrozenRawJournalReceiptV1Schema.parse(input.rawJournalReceipt),
      artifacts: manifestArtifacts,
    };
    const manifestBytes = new TextEncoder().encode(`${canonicalJson(manifest)}\n`);
    await writeExclusive(path.join(privateDirectory, "manifest.json"), manifestBytes);
    await syncDirectory(privateDirectory);
    await syncDirectory(stagingRoot);

    if (await lstatOrNull(finalRoot)) {
      throw new Error("RunStore final target appeared before atomic rename.");
    }
    await rename(stagingRoot, finalRoot);
    await syncDirectory(runsParent);

    await assertExactEntries(finalRoot, ["public", "private"]);
    await assertExactEntries(path.join(finalRoot, "public"), [
      "index.html",
      "styles.css",
    ]);
    await assertExactEntries(path.join(finalRoot, "private"), [
      "manifest.json",
      "run.json",
      "signals.json",
      "evidence.json",
      "quality.json",
      "article.json",
      "events.jsonl",
      "operations.jsonl",
    ]);
    for (const artifact of manifestArtifacts) {
      const bytes = await readFile(path.join(finalRoot, artifact.path));
      if (
        bytes.byteLength !== artifact.byteLength ||
        sha256Bytes(bytes) !== artifact.sha256
      ) {
        throw new Error(`RunStore final artifact hash mismatch: ${artifact.path}`);
      }
    }
    const finalManifestBytes = await readFile(
      path.join(finalRoot, "private", "manifest.json"),
    );
    if (sha256Bytes(finalManifestBytes) !== sha256Bytes(manifestBytes)) {
      throw new Error("RunStore final manifest hash mismatch.");
    }

    return {
      runId: input.runId,
      status: "ready_to_publish",
      manifestPath: "private/manifest.json",
      contentRevisionSha256: input.contentRevisionSha256,
      runDirectory: finalRoot,
    };
  }
}
