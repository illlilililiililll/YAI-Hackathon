export type HtmlTextNodeV1 = Readonly<{ kind: "text"; value: string }>;
export type HtmlElementNodeV1 = Readonly<{
  kind: "element";
  tag: string;
  attributes?: Readonly<Record<string, string>>;
  children?: readonly HtmlNodeV1[];
}>;
export type HtmlNodeV1 = HtmlTextNodeV1 | HtmlElementNodeV1;

const ALLOWED_TAGS = new Set([
  "html",
  "head",
  "body",
  "meta",
  "title",
  "link",
  "main",
  "article",
  "header",
  "h1",
  "h2",
  "h3",
  "p",
  "aside",
  "ul",
  "ol",
  "li",
  "section",
  "dl",
  "dt",
  "dd",
  "a",
  "footer",
  "span",
  "time",
]);
const VOID_TAGS = new Set(["meta", "link"]);
const PREVIEW_ALLOWED_TAGS = new Set([
  ...ALLOWED_TAGS,
  "figure",
  "figcaption",
  "img",
]);
const PREVIEW_VOID_TAGS = new Set([...VOID_TAGS, "img"]);

export function htmlText(value: string): HtmlTextNodeV1 {
  return { kind: "text", value };
}

export function htmlElement(
  tag: string,
  attributes: Readonly<Record<string, string>> = {},
  children: readonly HtmlNodeV1[] = [],
): HtmlElementNodeV1 {
  return { kind: "element", tag, attributes, children };
}

function escapeText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function serializeElement(
  node: HtmlElementNodeV1,
  depth: number,
  allowedTags: ReadonlySet<string>,
  voidTags: ReadonlySet<string>,
): string[] {
  if (!allowedTags.has(node.tag) || !/^[a-z][a-z0-9]*$/u.test(node.tag)) {
    throw new Error(`HTML tag가 허용되지 않습니다: ${node.tag}`);
  }
  const attributes = Object.entries(node.attributes ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [name] of attributes) {
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || name.startsWith("on") || name === "style") {
      throw new Error(`HTML attribute가 허용되지 않습니다: ${name}`);
    }
  }
  const attributeText = attributes
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  const indentation = "  ".repeat(depth);
  const children = node.children ?? [];
  if (voidTags.has(node.tag)) {
    if (children.length > 0) {
      throw new Error(`void element에는 child를 둘 수 없습니다: ${node.tag}`);
    }
    return [`${indentation}<${node.tag}${attributeText}>`];
  }
  if (children.length === 0) {
    return [`${indentation}<${node.tag}${attributeText}></${node.tag}>`];
  }
  if (children.length === 1 && children[0]?.kind === "text") {
    return [
      `${indentation}<${node.tag}${attributeText}>${escapeText(children[0].value)}</${node.tag}>`,
    ];
  }
  if (children.some((child) => child.kind === "text")) {
    throw new Error("HTML serializer는 mixed content를 허용하지 않습니다.");
  }
  const lines = [`${indentation}<${node.tag}${attributeText}>`];
  for (const child of children) {
    lines.push(...serializeElement(child as HtmlElementNodeV1, depth + 1, allowedTags, voidTags));
  }
  lines.push(`${indentation}</${node.tag}>`);
  return lines;
}

export function serializeHtmlDocumentV1(root: HtmlElementNodeV1): string {
  if (root.tag !== "html") {
    throw new Error("HTML document root는 html element여야 합니다.");
  }
  return `<!doctype html>\n${serializeElement(root, 0, ALLOWED_TAGS, VOID_TAGS).join("\n")}\n`;
}

export function serializePreviewHtmlDocumentV1(root: HtmlElementNodeV1): string {
  if (root.tag !== "html") {
    throw new Error("HTML document root는 html element여야 합니다.");
  }
  return `<!doctype html>\n${serializeElement(
    root,
    0,
    PREVIEW_ALLOWED_TAGS,
    PREVIEW_VOID_TAGS,
  ).join("\n")}\n`;
}
