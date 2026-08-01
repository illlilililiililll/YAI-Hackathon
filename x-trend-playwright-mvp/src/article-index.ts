import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectArticlePreflight } from "./article-preflight.js";
import { createArticlePipeline } from "./article-pipeline.js";
import { normalizeSeedKeyword } from "./topic-discovery.js";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message: string): never {
  process.stderr.write(`${message}\n사용법: npm run article -- "여행"\n`);
  process.exit(2);
}

const rawKeyword = process.argv.slice(2).join(" ");
if (!rawKeyword.trim()) usage("키워드 1개가 필요합니다.");
const seedKeyword = normalizeSeedKeyword(rawKeyword);
const preflight = await inspectArticlePreflight({ projectDirectory });
if (!preflight.ok) {
  usage(`Preflight 실패:\n- ${preflight.errors.join("\n- ")}`);
}
for (const warning of preflight.warnings) process.stderr.write(`[preflight] ${warning}\n`);

const { orchestrator, getPreviewDirectory } = await createArticlePipeline({ seedKeyword, projectDirectory });
const outcome = await orchestrator.run();
process.stdout.write(
  `${JSON.stringify({ ...outcome, previewDirectory: getPreviewDirectory() }, null, 2)}\n`,
);
process.exitCode = outcome.status === "ready_to_publish" ? 0 : 1;
