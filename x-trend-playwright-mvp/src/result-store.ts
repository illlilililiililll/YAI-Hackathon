import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { XSearchResult } from "./domain.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");

function keywordSlug(keyword: string): string {
  const slug = keyword
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return slug || "search";
}

export function buildResultFileName(keyword: string, date: Date): string {
  const timestamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replace(/[-:]/gu, "");
  return `${timestamp}-${keywordSlug(keyword)}.json`;
}

export async function saveSearchResult(result: XSearchResult): Promise<string> {
  const outputDirectory = path.join(projectDirectory, "output");
  const filename = buildResultFileName(result.keyword, new Date(result.collectedAt));
  const finalPath = path.join(outputDirectory, filename);
  const temporaryPath = `${finalPath}.tmp`;

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, finalPath);
  return finalPath;
}
