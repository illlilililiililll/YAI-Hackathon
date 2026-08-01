import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
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

import { sha256Bytes } from "./canonical-json.js";

export const UNVERIFIED_PREVIEW_FILE_NAMES = [
  "index.html",
  "styles.css",
  "hero.png",
  "preview.json",
  "signals.json",
  "events.jsonl",
  "PREVIEW_ONLY.txt",
] as const;
export type UnverifiedPreviewFileName =
  (typeof UNVERIFIED_PREVIEW_FILE_NAMES)[number];

export type UnverifiedPreviewFile = Readonly<{
  name: UnverifiedPreviewFileName;
  bytes: Uint8Array;
}>;

const RUN_ID =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(target: string, recursive: boolean): Promise<string> {
  if (!(await lstatOrNull(target))) {
    await mkdir(target, { recursive, mode: 0o700 });
  }
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unverified preview managed path가 안전한 directory가 아닙니다: ${target}`);
  }
  return realpath(target);
}

async function writeExclusive(target: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unverified preview artifact가 regular file이 아닙니다: ${target}`);
  }
  const readBack = await readFile(target);
  if (
    readBack.byteLength !== bytes.byteLength ||
    sha256Bytes(readBack) !== sha256Bytes(bytes)
  ) {
    throw new Error(`Unverified preview artifact read-back hash가 다릅니다: ${target}`);
  }
}

export class UnverifiedPreviewStore {
  private readonly outputRoot: string;

  constructor(options: { outputRoot: string }) {
    this.outputRoot = path.resolve(options.outputRoot);
  }

  async commit(input: {
    runId: string;
    files: readonly UnverifiedPreviewFile[];
  }): Promise<{ runDirectory: string }> {
    if (!RUN_ID.test(input.runId)) {
      throw new Error("Unverified preview runId 문법이 잘못되었습니다.");
    }
    if (
      input.files.length !== UNVERIFIED_PREVIEW_FILE_NAMES.length ||
      input.files.some((file, index) => file.name !== UNVERIFIED_PREVIEW_FILE_NAMES[index])
    ) {
      throw new Error("Unverified preview file tuple의 path 또는 순서가 잘못되었습니다.");
    }

    const outputRoot = await ensureDirectory(this.outputRoot, true);
    const previewParentTarget = path.join(outputRoot, "previews");
    if (path.dirname(previewParentTarget) !== outputRoot) {
      throw new Error("Unverified preview parent가 output root를 벗어났습니다.");
    }
    const previewParent = await ensureDirectory(previewParentTarget, false);
    const runDirectory = path.resolve(previewParent, input.runId);
    if (
      path.dirname(runDirectory) !== previewParent ||
      path.basename(runDirectory) !== input.runId ||
      (await lstatOrNull(runDirectory))
    ) {
      throw new Error("Unverified preview run target이 안전하지 않거나 이미 존재합니다.");
    }
    const stagingDirectory = path.resolve(
      previewParent,
      `.${input.runId}.staging-${randomUUID()}`,
    );
    if (path.dirname(stagingDirectory) !== previewParent) {
      throw new Error("Unverified preview staging path가 managed parent를 벗어났습니다.");
    }
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });

    for (const file of input.files) {
      const target = path.join(stagingDirectory, file.name);
      if (path.dirname(target) !== stagingDirectory) {
        throw new Error("Unverified preview artifact path가 run directory를 벗어났습니다.");
      }
      await writeExclusive(target, Uint8Array.from(file.bytes));
    }

    const entries = (await readdir(stagingDirectory)).sort();
    const expected = [...UNVERIFIED_PREVIEW_FILE_NAMES].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) {
      throw new Error("Unverified preview final tree entry가 exact tuple과 다릅니다.");
    }
    if (await lstatOrNull(runDirectory)) {
      throw new Error("Unverified preview final run target이 이미 존재합니다.");
    }
    await rename(stagingDirectory, runDirectory);
    return { runDirectory };
  }
}
