import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export type ArticlePreflightSnapshot = {
  nodeMajor: number;
  hasOpenAiApiKey: boolean;
  chromeAvailable: boolean;
  xProfileAvailable: boolean;
  xProfileLocked: boolean;
  rawOutputAvailable: boolean;
};

export type ArticlePreflightResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  snapshot: ArticlePreflightSnapshot;
};

export function evaluateArticlePreflight(
  snapshot: ArticlePreflightSnapshot,
): ArticlePreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (snapshot.nodeMajor !== 24) errors.push("Node.js 24가 필요합니다.");
  if (!snapshot.hasOpenAiApiKey) errors.push("OPENAI_API_KEY가 필요합니다.");
  if (!snapshot.chromeAvailable) errors.push("Google Chrome 실행 파일을 찾을 수 없습니다.");
  if (!snapshot.xProfileAvailable) errors.push("X 로그인 profile을 찾을 수 없습니다.");
  if (snapshot.xProfileLocked) errors.push("X profile이 다른 프로세스에서 사용 중입니다.");
  if (!snapshot.rawOutputAvailable) errors.push("SDK raw event 출력 채널을 사용할 수 없습니다.");
  if (snapshot.xProfileAvailable && !snapshot.xProfileLocked) {
    warnings.push("X 로그인 만료·challenge 여부는 첫 live 수집에서 최종 확인됩니다.");
  }
  return { ok: errors.length === 0, errors, warnings, snapshot };
}

async function isExecutableFile(target: string): Promise<boolean> {
  try {
    const value = await stat(target);
    await access(target, constants.X_OK);
    return value.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function inspectArticlePreflight(options: {
  projectDirectory: string;
  rawOutputAvailable?: boolean;
  rawOutput?: NodeJS.WritableStream;
  chromeExecutable?: string;
}): Promise<ArticlePreflightResult> {
  const projectDirectory = path.resolve(options.projectDirectory);
  const xProfileDirectory = path.join(projectDirectory, ".browser-profile");
  const chromeExecutable =
    options.chromeExecutable ??
    process.env.CHROME_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const rawOutput = options.rawOutput ?? process.stderr;
  const snapshot: ArticlePreflightSnapshot = {
    nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
    hasOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
    chromeAvailable: await isExecutableFile(chromeExecutable),
    xProfileAvailable: await isDirectory(xProfileDirectory),
    xProfileLocked: await exists(`${xProfileDirectory}.yai-browser.lock`),
    rawOutputAvailable:
      options.rawOutputAvailable ??
      Boolean(
        rawOutput.writable &&
          (!("destroyed" in rawOutput) || rawOutput.destroyed !== true),
      ),
  };
  return evaluateArticlePreflight(snapshot);
}
