import { createInterface } from "node:readline/promises";

import { createPlaywrightMcpServer } from "./x-search-agent.js";

const server = createPlaywrightMcpServer();
const terminal = createInterface({ input: process.stdin, output: process.stdout });

try {
  await server.connect();
  const result = await server.callTool("browser_navigate", {
    url: "https://x.com/i/flow/login",
  });
  const failed = result.some(
    (item) =>
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.includes("### Error"),
  );

  if (failed) {
    throw new Error("Chrome에서 X 로그인 페이지를 열지 못했습니다.");
  }

  process.stdout.write(
    "열린 Chrome에서 직접 로그인하세요. 로그인 완료 후 이 터미널에서 Enter를 누르세요.\n",
  );
  await terminal.question("");
  process.stdout.write("로그인 프로필을 .browser-profile/에 보존했습니다.\n");
} finally {
  terminal.close();
  await server.close();
}
