import { describe, expect, it } from "vitest";

import { extractSourceText } from "../src/source-text-extractor.js";

describe("SourceTextExtractorV1", () => {
  it("extracts allowed visible blocks in document order", () => {
    const extraction = extractSourceText(
      `<!doctype html>
      <html><head><title> 공식\r\n 안내 </title><style>hidden css</style></head>
      <body><h1>여행&nbsp;안내</h1><script>fake evidence</script>
      <p>첫째 <strong>문장</strong></p><ul><li>둘째\t문장</li></ul>
      <p hidden>hidden attribute evidence</p>
      <div aria-hidden="true"><p>aria hidden evidence</p></div>
      <section inert><p>inert evidence</p></section>
      <svg><title>hidden svg</title></svg></body></html>`,
      "https://official.example/guide",
    );

    expect(extraction.blocks.map((block) => [block.tag, block.text])).toEqual([
      ["title", "공식 안내"],
      ["h1", "여행 안내"],
      ["p", "첫째 문장"],
      ["li", "둘째 문장"],
    ]);
    expect(JSON.stringify(extraction.blocks)).not.toMatch(
      /fake evidence|hidden svg|hidden attribute|aria hidden|inert evidence/u,
    );
    expect(extraction.blocks.every((block) => /^[0-9a-f]{64}$/u.test(block.textSha256))).toBe(
      true,
    );
    expect(extraction.truncated).toBe(false);
  });

  it("stops at a deterministic whole-block UTF-8 prefix", () => {
    const extraction = extractSourceText(
      "<html><body><p>가나다</p><p>라마바</p></body></html>",
      "https://official.example/",
      { maxExtractedUtf8Bytes: 9 },
    );
    expect(extraction.blocks.map((block) => block.text)).toEqual(["가나다"]);
    expect(extraction.extractedUtf8Bytes).toBe(9);
    expect(extraction.truncated).toBe(true);
  });
});
