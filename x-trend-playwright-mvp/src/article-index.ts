import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArticleCliArguments } from "./article-cli-options.js";
import { inspectArticlePreflight } from "./article-preflight.js";
import { createArticlePipeline } from "./article-pipeline.js";
import { extractCommercialContext } from "./commercial-context.js";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message: string): never {
  process.stderr.write(
    `${message}\n사용법: npm run article -- [--unverified-preview] ` +
      `"brand_name: 트래블메이트; brand_type: 일본 전문 여행사; ` +
      `target_reader: 일본 여행을 준비하는 가족; offering: 일본 패키지 여행상품; ` +
      `cta_goal: 문의"\n`,
  );
  process.exit(2);
}

let options: ReturnType<typeof parseArticleCliArguments>;
let commercialContext: ReturnType<typeof extractCommercialContext>;
try {
  options = parseArticleCliArguments(process.argv.slice(2));
  commercialContext = extractCommercialContext(options.input);
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
const preflight = await inspectArticlePreflight({ projectDirectory });
if (!preflight.ok) {
  usage(`Preflight 실패:\n- ${preflight.errors.join("\n- ")}`);
}
for (const warning of preflight.warnings) process.stderr.write(`[preflight] ${warning}\n`);

const {
  orchestrator,
  getPreviewDirectory,
  executionMode,
  provenanceMode,
} = await createArticlePipeline({
  commercialContext,
  unverifiedPreview: options.unverifiedPreview,
  projectDirectory,
  rawOutput: process.stderr,
  progressOutput: process.stderr,
});
const outcome = await orchestrator.run();
process.stdout.write(
  `${JSON.stringify(
    {
      ...outcome,
      executionMode,
      provenanceMode,
      commercialContext,
      previewDirectory: getPreviewDirectory(),
    },
    null,
    2,
  )}\n`,
);
process.exitCode =
  outcome.status === "ready_to_publish" ||
  outcome.status === "unverified_preview_ready"
    ? 0
    : 1;
