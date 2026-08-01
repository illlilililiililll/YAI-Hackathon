import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Bytes } from "./canonical-json.js";
import {
  ArticleRenderInputV1Schema,
  StaticRenderResultV1Schema,
  type ArticleRenderInputV1,
  type StaticRenderResultV1,
} from "./content-domain.js";
import {
  htmlElement as element,
  htmlText as text,
  serializeHtmlDocumentV1,
  type HtmlElementNodeV1,
} from "./html-serializer-v1.js";
import { validateSurfaceIndex } from "./surface-index-validator.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const ARTICLE_THEME_PATH = path.join(
  moduleDirectory,
  "renderer",
  "article-theme-v1.css",
);

const UI_LITERAL_V1 = {
  sources_heading: "출처",
  verified_label: "마지막 검증 시각",
} as const;

export async function loadArticleThemeBytes(): Promise<Uint8Array> {
  const stats = await lstat(ARTICLE_THEME_PATH);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Article theme은 regular non-symlink file이어야 합니다.");
  }
  const bytes = await readFile(ARTICLE_THEME_PATH);
  const css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (css.includes("\r") || !css.endsWith("\n") || css.endsWith("\n\n")) {
    throw new Error("Article theme은 LF와 trailing LF 하나를 사용해야 합니다.");
  }
  return bytes;
}

function surfaceLeaf(
  tag: "h1" | "h2" | "h3" | "p" | "li" | "dt" | "dd" | "a",
  className: string,
  unit: { surfaceId: string; text?: string; displayLabel?: string; url?: string },
): HtmlElementNodeV1 {
  const visibleText = unit.text ?? unit.displayLabel;
  if (visibleText === undefined) {
    throw new Error("render surface text가 없습니다.");
  }
  const attributes: Record<string, string> = {
    class: className,
    "data-surface-id": unit.surfaceId,
  };
  if (tag === "a") {
    if (!unit.url) {
      throw new Error("link surface URL이 없습니다.");
    }
    attributes.href = unit.url;
  }
  return element(tag, attributes, [text(visibleText)]);
}

function headingLeaf(
  heading: { level: 2 | 3; text: { surfaceId: string; text: string } },
): HtmlElementNodeV1 {
  return surfaceLeaf(heading.level === 2 ? "h2" : "h3", "block-heading", heading.text);
}

function renderBlock(
  block: ArticleRenderInputV1["content"]["blocks"][number],
): HtmlElementNodeV1 {
  switch (block.kind) {
    case "summary":
      return element("aside", { class: "summary-box" }, [
        headingLeaf(block.heading),
        element(
          "ul",
          { class: "summary-list" },
          block.items.map((unit) => surfaceLeaf("li", "summary-item", unit)),
        ),
      ]);
    case "section":
      return element("section", { class: "content-section" }, [
        headingLeaf(block.heading),
        ...block.paragraphs.map((unit) =>
          surfaceLeaf("p", "article-paragraph", unit),
        ),
      ]);
    case "checklist":
      return element("section", { class: "checklist-section" }, [
        headingLeaf(block.heading),
        element(
          "ul",
          { class: "checklist-list" },
          block.items.map((unit) => surfaceLeaf("li", "checklist-item", unit)),
        ),
      ]);
    case "faq":
      return element("section", { class: "faq-section" }, [
        headingLeaf(block.heading),
        element(
          "dl",
          { class: "faq-list" },
          block.pairs.flatMap((pair) => [
            surfaceLeaf("dt", "faq-question", pair.question),
            ...pair.answers.map((unit) => surfaceLeaf("dd", "faq-answer", unit)),
          ]),
        ),
      ]);
    case "related_link":
      return element("aside", { class: "related-link" }, [
        ...(block.supportingCopy
          ? [surfaceLeaf("p", "supporting-copy", block.supportingCopy)]
          : []),
        surfaceLeaf("a", "link-anchor", {
          ...block.link,
          url: block.link.url,
        }),
      ]);
    case "cta":
      return element("aside", { class: "article-cta" }, [
        ...(block.supportingCopy
          ? [surfaceLeaf("p", "cta-copy", block.supportingCopy)]
          : []),
        surfaceLeaf("a", "cta-link", { ...block.link, url: block.link.url }),
      ]);
    case "intro":
      throw new Error("intro block은 article header에서만 렌더링합니다.");
  }
}

function buildDocument(input: ArticleRenderInputV1): HtmlElementNodeV1 {
  const content = input.content;
  const intro = content.blocks[0];
  if (!intro || intro.kind !== "intro") {
    throw new Error("Canonical Article 첫 block은 intro여야 합니다.");
  }
  const articleChildren: HtmlElementNodeV1[] = [
    element("header", { class: "article-header" }, [
      surfaceLeaf("h1", "article-title", content.title),
      surfaceLeaf("p", "article-deck", content.metaDescription),
      ...intro.paragraphs.map((unit) => surfaceLeaf("p", "article-lead", unit)),
    ]),
    ...content.blocks.slice(1).map(renderBlock),
    element("section", { class: "sources-section" }, [
      element("h2", { "data-ui-literal-id": "sources_heading" }, [
        text(UI_LITERAL_V1.sources_heading),
      ]),
      element(
        "ol",
        { id: "sources" },
        content.sources.map((source) =>
          element("li", { class: "source-item", "data-source-id": source.sourceId }, [
            element("a", { class: "source-link", href: source.url }, [text(source.title)]),
            element("time", { datetime: source.retrievedAt }, [text(source.retrievedAt)]),
          ]),
        ),
      ),
    ]),
    element("footer", { class: "article-footer" }, [
      element("p", { "data-role": "disclosure" }, [text(content.disclosure)]),
      element("p", { class: "verified-row" }, [
        element("span", { "data-ui-literal-id": "verified_label" }, [
          text(UI_LITERAL_V1.verified_label),
        ]),
        element(
          "time",
          { "data-role": "verified-at", datetime: content.verifiedAt },
          [text(content.verifiedAt)],
        ),
      ]),
    ]),
  ];

  return element("html", { lang: "ko-KR" }, [
    element("head", {}, [
      element("meta", { charset: "utf-8" }),
      element("meta", {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      }),
      element("title", {}, [text(content.title.text)]),
      element("meta", { content: content.metaDescription.text, name: "description" }),
      element("link", { href: "./styles.css", rel: "stylesheet" }),
    ]),
    element("body", {}, [
      element("main", { class: "page-shell" }, [
        element("article", { class: "travel-article" }, articleChildren),
      ]),
    ]),
  ]);
}

export async function renderStaticArticle(
  inputValue: ArticleRenderInputV1,
): Promise<StaticRenderResultV1> {
  const input = ArticleRenderInputV1Schema.parse(inputValue);
  validateSurfaceIndex(input.content);
  const html = serializeHtmlDocumentV1(buildDocument(input));
  const htmlBytes = new TextEncoder().encode(html);
  const cssBytes = await loadArticleThemeBytes();
  return StaticRenderResultV1Schema.parse({
    contentRevisionSha256: input.contentRevisionSha256,
    files: [
      {
        path: "public/index.html",
        contentType: "text/html; charset=utf-8",
        bytes: htmlBytes,
        byteLength: htmlBytes.byteLength,
        sha256: sha256Bytes(htmlBytes),
      },
      {
        path: "public/styles.css",
        contentType: "text/css; charset=utf-8",
        bytes: cssBytes,
        byteLength: cssBytes.byteLength,
        sha256: sha256Bytes(cssBytes),
      },
    ],
    coverage: input.content.surfaceIndex.map((surface) => ({
      surfaceId: surface.surfaceId,
      domLocator: `[data-surface-id="${surface.surfaceId}"]`,
      renderedTextSha256: surface.textSha256,
    })),
  });
}
