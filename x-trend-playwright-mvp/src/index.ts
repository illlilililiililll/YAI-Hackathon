import "dotenv/config";

import { normalizeKeyword, type XSearchResult } from "./domain.js";
import { saveSearchResult } from "./result-store.js";
import { searchXWithPlaywrightMcp } from "./x-search-agent.js";

const EXIT_USAGE = 2;
const EXIT_REMOTE_FAILURE = 3;

function printUsageError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write("사용법: npm run search -- <키워드>\n");
  process.exit(EXIT_USAGE);
}

function resultExitCode(result: XSearchResult): number {
  return result.status === "ok" ? 0 : EXIT_REMOTE_FAILURE;
}

async function main(): Promise<void> {
  let keyword: string;

  try {
    keyword = normalizeKeyword(process.argv.slice(2).join(" "));
  } catch (error) {
    printUsageError(error instanceof Error ? error.message : "잘못된 키워드입니다.");
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    printUsageError("OPENAI_API_KEY 환경변수가 필요합니다.");
  }

  try {
    const result = await searchXWithPlaywrightMcp(keyword, {
      onEvent: (event) => {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      },
    });

    const savedPath = await saveSearchResult(result);
    process.stderr.write(`저장: ${savedPath}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = resultExitCode(result);
  } catch (error) {
    const result: XSearchResult = {
      keyword,
      status: "error",
      searchUrl: new URL(
        `/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`,
        "https://x.com",
      ).toString(),
      collectedAt: new Date().toISOString(),
      posts: [],
      message: error instanceof Error ? error.message : "알 수 없는 실행 오류",
    };

    const savedPath = await saveSearchResult(result);
    process.stderr.write(`저장: ${savedPath}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = EXIT_REMOTE_FAILURE;
  }
}

await main();
