export type ArticleCliOptions = Readonly<{
  unverifiedPreview: boolean;
  input: string;
}>;

export function parseArticleCliArguments(argv: readonly string[]): ArticleCliOptions {
  let unverifiedPreview = false;
  const inputParts: string[] = [];
  let positionalOnly = false;

  for (const argument of argv) {
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument === "--unverified-preview") {
      if (unverifiedPreview) {
        throw new Error("--unverified-preview 옵션은 한 번만 사용할 수 있습니다.");
      }
      unverifiedPreview = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--")) {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
    inputParts.push(argument);
  }

  const input = inputParts.join(" ").normalize("NFC").trim();
  if (!input) {
    throw new Error(
      "brand_name, brand_type, target_reader, offering, cta_goal 입력이 필요합니다.",
    );
  }
  return Object.freeze({ unverifiedPreview, input });
}
