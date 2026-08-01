import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function ensureDirectory(target: string): Promise<string> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`preview managed path가 안전한 directory가 아닙니다: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(target, { recursive: false, mode: 0o700 });
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
}

export async function writeNonPublishablePreview(input: {
  outputRoot: string;
  runId: string;
  files: readonly { name: "index.html" | "styles.css" | "article.json" | "evidence.json" | "quality.json" | "PREVIEW_ONLY.txt"; bytes: Uint8Array }[];
}): Promise<string> {
  if (!RUN_ID.test(input.runId)) throw new Error("preview runId 문법이 잘못되었습니다.");
  const outputRoot = path.resolve(input.outputRoot);
  try {
    await ensureDirectory(outputRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw error;
  }
  const previewParent = await ensureDirectory(path.join(outputRoot, "previews"));
  const runDirectory = path.resolve(previewParent, input.runId);
  if (path.dirname(runDirectory) !== previewParent || path.basename(runDirectory) !== input.runId) {
    throw new Error("preview path가 managed parent를 벗어났습니다.");
  }
  await mkdir(runDirectory, { recursive: false, mode: 0o700 });
  const seen = new Set<string>();
  for (const file of input.files) {
    if (seen.has(file.name)) throw new Error(`preview file이 중복됩니다: ${file.name}`);
    seen.add(file.name);
    await writeExclusive(path.join(runDirectory, file.name), file.bytes);
  }
  return runDirectory;
}
