import {
  XSearchResultSchema,
  buildXSearchUrl,
  type XSearchResult,
} from "./domain.js";
import { createPlaywrightMcpServer } from "./x-search-agent.js";

export type PageExtraction = {
  pageUrl: string;
  pageTitle: string;
  isLogin: boolean;
  isBlocked: boolean;
  posts: Array<{ author: string; text: string; url: string | null }>;
};

export const X_PAGE_EXTRACTION_FUNCTION = `() => {
  const bodyText = document.body?.innerText ?? '';
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const posts = articles.slice(0, 10).map((article) => {
    const author = article.querySelector('[data-testid="User-Name"]')?.textContent?.trim() || '작성자 미표시';
    const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
    const statusLink = Array.from(article.querySelectorAll('a[href*="/status/"]'))
      .map((link) => link.getAttribute('href'))
      .find(Boolean);
    return {
      author,
      text,
      url: statusLink ? new URL(statusLink, location.origin).href : null,
    };
  }).filter((post) => post.text.length > 0);

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    isLogin: location.pathname.includes('/i/flow/login') ||
      location.pathname.includes('/i/jf/onboarding') ||
      Boolean(document.querySelector('input[autocomplete="username"]')),
    isBlocked: /captcha|verify you are human|자동화된 요청|문제가 발생했습니다|something went wrong/i.test(bodyText),
    posts,
  };
}`;

function textContent(content: Array<{ type: string; text?: unknown }>): string {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

export function parseExtraction(text: string): PageExtraction {
  const resultMarker = "### Result\n";
  const start = text.indexOf(resultMarker);

  if (start < 0) {
    throw new Error("Playwright MCP 결과에서 JSON 데이터를 찾지 못했습니다.");
  }

  const payloadStart = start + resultMarker.length;
  const nextSection = text.indexOf("\n### ", payloadStart);
  const payload = text.slice(
    payloadStart,
    nextSection < 0 ? undefined : nextSection,
  );
  return JSON.parse(payload) as PageExtraction;
}

export async function searchXWithoutOpenAi(keyword: string): Promise<XSearchResult> {
  const searchUrl = buildXSearchUrl(keyword);
  const server = createPlaywrightMcpServer();

  await server.connect();

  try {
    const navigation = await server.callToolResult("browser_navigate", {
      url: searchUrl,
    });
    if (navigation.isError) {
      throw new Error(textContent(navigation.content) || "X 페이지 이동 실패");
    }

    await server.callToolResult("browser_wait_for", { time: 3 });
    const evaluation = await server.callToolResult("browser_evaluate", {
      function: X_PAGE_EXTRACTION_FUNCTION,
    });
    if (evaluation.isError) {
      throw new Error(textContent(evaluation.content) || "X 화면 분석 실패");
    }

    const extracted = parseExtraction(textContent(evaluation.content));
    const status = extracted.isLogin
      ? "login_required"
      : extracted.isBlocked
        ? "blocked"
        : "ok";

    return XSearchResultSchema.parse({
      keyword,
      status,
      searchUrl,
      collectedAt: new Date().toISOString(),
      posts: status === "ok" ? extracted.posts : [],
      message:
        status === "login_required"
          ? "X 로그인이 필요합니다. npm run profile:login을 실행하세요."
          : status === "blocked"
            ? "X가 자동화 접근을 차단했거나 오류 화면을 표시했습니다."
            : `첫 화면에서 게시물 ${extracted.posts.length}개를 수집했습니다.`,
    });
  } finally {
    await server.close();
  }
}
