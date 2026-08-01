import { parse } from "parse5";

import { sha256Bytes } from "./canonical-json.js";
import {
  ArticleRenderInputV1Schema,
  StaticRenderResultV1Schema,
  type ArticleRenderInputV1,
  type StaticRenderResultV1,
} from "./content-domain.js";
import { loadArticleThemeBytes } from "./static-html-renderer.js";
import {
  collectCanonicalSurfaces,
  validateSurfaceIndex,
} from "./surface-index-validator.js";

type ParsedNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedNode[];
};

const FORBIDDEN_TAGS = new Set([
  "script",
  "style",
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "table",
]);

function walk(node: ParsedNode, output: ParsedNode[] = []): ParsedNode[] {
  output.push(node);
  for (const child of node.childNodes ?? []) {
    walk(child, output);
  }
  return output;
}

function attributes(node: ParsedNode): Map<string, string> {
  return new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
}

function nodeText(node: ParsedNode): string {
  if (node.nodeName === "#text") {
    return node.value ?? "";
  }
  return (node.childNodes ?? []).map(nodeText).join("");
}

function exactTextLeaf(node: ParsedNode): string {
  if (node.childNodes?.length !== 1 || node.childNodes[0]?.nodeName !== "#text") {
    throw new Error("primary surface는 exact text node 하나만 가져야 합니다.");
  }
  return node.childNodes[0].value ?? "";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function decodeExactUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}이(가) 유효한 UTF-8이 아닙니다.`);
  }
}

export async function validateStaticRender(
  inputValue: ArticleRenderInputV1,
  resultValue: StaticRenderResultV1,
): Promise<void> {
  const input = ArticleRenderInputV1Schema.parse(inputValue);
  const result = StaticRenderResultV1Schema.parse(resultValue);
  if (result.contentRevisionSha256 !== input.contentRevisionSha256) {
    throw new Error("render result의 content revision hash가 다릅니다.");
  }
  validateSurfaceIndex(input.content);

  const [htmlFile, cssFile] = result.files;
  if (
    htmlFile.path !== "public/index.html" ||
    htmlFile.contentType !== "text/html; charset=utf-8" ||
    cssFile.path !== "public/styles.css" ||
    cssFile.contentType !== "text/css; charset=utf-8"
  ) {
    throw new Error("render file tuple의 path 또는 content type이 올바르지 않습니다.");
  }
  for (const file of result.files) {
    if (
      file.byteLength !== file.bytes.byteLength ||
      file.sha256 !== sha256Bytes(file.bytes)
    ) {
      throw new Error(`render file byte/hash가 다릅니다: ${file.path}`);
    }
  }

  const html = decodeExactUtf8(htmlFile.bytes, "index.html");
  const css = decodeExactUtf8(cssFile.bytes, "styles.css");
  if (
    !html.startsWith("<!doctype html>\n") ||
    html.includes("\r") ||
    !html.endsWith("\n") ||
    html.endsWith("\n\n") ||
    css.includes("\r") ||
    !css.endsWith("\n") ||
    css.endsWith("\n\n")
  ) {
    throw new Error("HTML/CSS는 LF와 trailing LF 하나를 사용해야 합니다.");
  }
  const expectedCss = await loadArticleThemeBytes();
  if (!equalBytes(cssFile.bytes, expectedCss)) {
    throw new Error("styles.css가 고정 Article theme bytes와 다릅니다.");
  }
  if (/(?:@import|url\s*\(|expression\s*\(|javascript:|<\/?style)/iu.test(css)) {
    throw new Error("styles.css에 외부 resource 또는 실행 가능 표현이 있습니다.");
  }

  const document = parse(html) as unknown as ParsedNode;
  const nodes = walk(document);
  for (const node of nodes) {
    if (node.tagName && FORBIDDEN_TAGS.has(node.tagName)) {
      throw new Error(`금지된 HTML tag가 있습니다: ${node.tagName}`);
    }
    for (const attribute of node.attrs ?? []) {
      if (
        attribute.name === "style" ||
        attribute.name.startsWith("on") ||
        attribute.name === "src" ||
        attribute.name === "srcset"
      ) {
        throw new Error(`금지된 HTML attribute가 있습니다: ${attribute.name}`);
      }
    }
  }

  const stylesheetLinks = nodes.filter((node) => {
    const attrs = attributes(node);
    return node.tagName === "link" && attrs.get("rel") === "stylesheet";
  });
  if (
    stylesheetLinks.length !== 1 ||
    attributes(stylesheetLinks[0]!).get("href") !== "./styles.css"
  ) {
    throw new Error("local stylesheet link가 정확히 하나여야 합니다.");
  }
  for (const node of nodes.filter((candidate) => candidate.tagName === "a")) {
    const href = attributes(node).get("href");
    if (!href || new URL(href).protocol !== "https:") {
      throw new Error("Article anchor는 승인된 absolute HTTPS URL이어야 합니다.");
    }
  }

  const surfaceNodes = nodes.filter((node) => attributes(node).has("data-surface-id"));
  const expectedSurfaces = collectCanonicalSurfaces(input.content);
  if (surfaceNodes.length !== expectedSurfaces.length) {
    throw new Error("HTML surface marker cardinality가 canonical surface와 다릅니다.");
  }
  surfaceNodes.forEach((node, index) => {
    const expected = expectedSurfaces[index]!;
    const marker = attributes(node).get("data-surface-id");
    const visibleText = exactTextLeaf(node);
    if (
      marker !== expected.surfaceId ||
      visibleText !== expected.text ||
      sha256Bytes(new TextEncoder().encode(visibleText)) !== expected.textSha256
    ) {
      throw new Error("HTML surface order, text 또는 hash가 canonical content와 다릅니다.");
    }
  });

  const canonicalLinks = new Map<string, string>();
  for (const block of input.content.blocks) {
    if (block.kind === "related_link" || block.kind === "cta") {
      canonicalLinks.set(block.link.surfaceId, block.link.url);
    }
  }
  for (const node of surfaceNodes) {
    const marker = attributes(node).get("data-surface-id")!;
    const expectedUrl = canonicalLinks.get(marker);
    if (expectedUrl !== undefined) {
      if (node.tagName !== "a" || attributes(node).get("href") !== expectedUrl) {
        throw new Error("system link href가 canonical content와 다릅니다.");
      }
    }
  }

  const sourceItems = nodes.filter((node) => attributes(node).has("data-source-id"));
  if (sourceItems.length !== input.content.sources.length) {
    throw new Error("HTML Source list cardinality가 canonical sources와 다릅니다.");
  }
  sourceItems.forEach((node, index) => {
    const expected = input.content.sources[index]!;
    const children = (node.childNodes ?? []).filter((child) => child.nodeName !== "#text");
    const anchor = children.find((child) => child.tagName === "a");
    const time = children.find((child) => child.tagName === "time");
    if (
      attributes(node).get("data-source-id") !== expected.sourceId ||
      !anchor ||
      attributes(anchor).get("href") !== expected.url ||
      nodeText(anchor) !== expected.title ||
      !time ||
      attributes(time).get("datetime") !== expected.retrievedAt ||
      nodeText(time) !== expected.retrievedAt
    ) {
      throw new Error("HTML Source item이 canonical citation과 다릅니다.");
    }
  });

  if (result.coverage.length !== expectedSurfaces.length) {
    throw new Error("RenderCoverage cardinality가 다릅니다.");
  }
  result.coverage.forEach((coverage, index) => {
    const expected = expectedSurfaces[index]!;
    if (
      coverage.surfaceId !== expected.surfaceId ||
      coverage.domLocator !== `[data-surface-id="${expected.surfaceId}"]` ||
      coverage.renderedTextSha256 !== expected.textSha256
    ) {
      throw new Error("RenderCoverage 순서 또는 hash가 다릅니다.");
    }
  });

  const titleNodes = nodes.filter((node) => node.tagName === "title");
  const descriptionNodes = nodes.filter(
    (node) => node.tagName === "meta" && attributes(node).get("name") === "description",
  );
  if (
    titleNodes.length !== 1 ||
    nodeText(titleNodes[0]!) !== input.content.title.text ||
    descriptionNodes.length !== 1 ||
    attributes(descriptionNodes[0]!).get("content") !== input.content.metaDescription.text
  ) {
    throw new Error("title/meta description mirror가 canonical content와 다릅니다.");
  }
  const disclosures = nodes.filter(
    (node) => attributes(node).get("data-role") === "disclosure",
  );
  const verified = nodes.filter(
    (node) => attributes(node).get("data-role") === "verified-at",
  );
  if (
    disclosures.length !== 1 ||
    nodeText(disclosures[0]!) !== input.content.disclosure ||
    verified.length !== 1 ||
    nodeText(verified[0]!) !== input.content.verifiedAt ||
    attributes(verified[0]!).get("datetime") !== input.content.verifiedAt
  ) {
    throw new Error("disclosure 또는 verifiedAt footer가 canonical content와 다릅니다.");
  }
}

export async function checkStaticRender(
  input: ArticleRenderInputV1,
  result: StaticRenderResultV1,
): Promise<{ passed: boolean; code: string }> {
  try {
    await validateStaticRender(input, result);
    return { passed: true, code: "render_integrity_ok" };
  } catch (error) {
    return {
      passed: false,
      code: error instanceof Error ? `render_integrity_failed:${error.message}` : "render_integrity_failed",
    };
  }
}
