import { parse } from "parse5";

import { sha256Bytes } from "./canonical-json.js";
import {
  ExtractedBlockV1Schema,
  type ExtractedBlockV1,
} from "./content-domain.js";

const INCLUDED_TAGS = new Set([
  "title",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "dt",
  "dd",
] as const);

const EXCLUDED_SUBTREES = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
]);

interface ParseNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParseNode[];
}

export interface SourceTextExtraction {
  blocks: ExtractedBlockV1[];
  truncated: boolean;
  extractedUtf8Bytes: number;
}

export interface SourceTextExtractorOptions {
  maxBlocks?: number;
  maxExtractedUtf8Bytes?: number;
}

function normalizeVisibleText(input: string): string {
  return input
    .replace(/\r\n?/gu, "\n")
    .replace(/\p{White_Space}+/gu, " ")
    .normalize("NFC")
    .trim();
}

function isHiddenElement(node: ParseNode): boolean {
  const attributes = new Map(
    (node.attrs ?? []).map((attribute) => [
      attribute.name.toLowerCase(),
      attribute.value.toLowerCase(),
    ]),
  );
  return (
    attributes.has("hidden") ||
    attributes.has("inert") ||
    attributes.get("aria-hidden") === "true"
  );
}

function descendantText(node: ParseNode): string {
  if (node.nodeName === "#text") {
    return node.value ?? "";
  }
  if (node.tagName && EXCLUDED_SUBTREES.has(node.tagName.toLowerCase())) {
    return "";
  }
  if (isHiddenElement(node)) {
    return "";
  }
  return (node.childNodes ?? []).map(descendantText).join("");
}

function elementChildren(node: ParseNode): ParseNode[] {
  return (node.childNodes ?? []).filter(
    (child): child is ParseNode => typeof child.tagName === "string",
  );
}

/** Deterministic parse5 visible-block projection used by Source admission. */
export function extractSourceText(
  html: string,
  finalUrl: string,
  options: SourceTextExtractorOptions = {},
): SourceTextExtraction {
  const maxBlocks = options.maxBlocks ?? 60;
  const maxExtractedUtf8Bytes = options.maxExtractedUtf8Bytes ?? 65_536;
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1) {
    throw new Error("maxBlocks는 양의 정수여야 합니다.");
  }
  if (!Number.isInteger(maxExtractedUtf8Bytes) || maxExtractedUtf8Bytes < 1) {
    throw new Error("maxExtractedUtf8Bytes는 양의 정수여야 합니다.");
  }
  const canonicalFinalUrl = new URL(finalUrl).href;
  const documentNode = parse(html) as unknown as ParseNode;
  const blocks: ExtractedBlockV1[] = [];
  let extractedUtf8Bytes = 0;
  let truncated = false;

  const visit = (node: ParseNode, domPath: string): boolean => {
    const tag = node.tagName?.toLowerCase();
    if (tag && (EXCLUDED_SUBTREES.has(tag) || isHiddenElement(node))) {
      return true;
    }

    if (tag && INCLUDED_TAGS.has(tag as never)) {
      const text = normalizeVisibleText(descendantText(node));
      if (text.length > 0) {
        const bytes = Buffer.from(text, "utf8");
        if (
          blocks.length >= maxBlocks ||
          extractedUtf8Bytes + bytes.byteLength > maxExtractedUtf8Bytes
        ) {
          truncated = true;
          return false;
        }
        const blockId = `block_${sha256Bytes(
          Buffer.from(`${canonicalFinalUrl}\0${domPath}\0${text}`, "utf8"),
        ).slice(0, 24)}`;
        blocks.push(
          ExtractedBlockV1Schema.parse({
            blockId,
            domPath,
            tag,
            text,
            textSha256: sha256Bytes(bytes),
          }),
        );
        extractedUtf8Bytes += bytes.byteLength;
      }
    }

    const children = elementChildren(node);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child?.tagName) {
        continue;
      }
      if (!visit(child, `${domPath}/${child.tagName.toLowerCase()}[${index + 1}]`)) {
        return false;
      }
    }
    return true;
  };

  visit(documentNode, "");
  return { blocks, truncated, extractedUtf8Bytes };
}
