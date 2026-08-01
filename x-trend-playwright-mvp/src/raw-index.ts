import { buildXSearchUrl, normalizeKeyword, type XSearchResult } from "./domain.js";
import { searchXWithoutOpenAi } from "./raw-x-search.js";
import { saveSearchResult } from "./result-store.js";

const EXIT_USAGE = 2;
const EXIT_REMOTE_FAILURE = 3;

function usageError(message: string): never {
  process.stderr.write(`${message}\n사용법: npm run search:raw -- <키워드>\n`);
  process.exit(EXIT_USAGE);
}

let keyword: string;
try {
  keyword = normalizeKeyword(process.argv.slice(2).join(" "));
} catch (error) {
  usageError(error instanceof Error ? error.message : "잘못된 키워드입니다.");
}

let result: XSearchResult;
try {
  result = await searchXWithoutOpenAi(keyword);
} catch (error) {
  result = {
    keyword,
    status: "error",
    searchUrl: buildXSearchUrl(keyword),
    collectedAt: new Date().toISOString(),
    posts: [],
    message: error instanceof Error ? error.message : "알 수 없는 실행 오류",
  };
}

const savedPath = await saveSearchResult(result);
process.stderr.write(`저장: ${savedPath}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.status === "ok" ? 0 : EXIT_REMOTE_FAILURE;
