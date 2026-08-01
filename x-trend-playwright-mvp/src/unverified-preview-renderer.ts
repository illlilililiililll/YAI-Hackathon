import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { sha256Bytes, sha256Canonical } from "./canonical-json.js";
import {
  CommercialContextV1Schema,
  type CommercialContextV1,
  type CommercialCtaGoal,
} from "./commercial-context.js";
import {
  htmlElement as element,
  htmlText as text,
  serializePreviewHtmlDocumentV1,
} from "./html-serializer-v1.js";
import {
  UnverifiedPreviewDraftV1Schema,
  type UnverifiedPreviewDraftV1,
} from "./unverified-preview-agent.js";

export const UNVERIFIED_PREVIEW_WARNING =
  "외부 근거 미검증 · 테스트 프리뷰 · 발행 금지" as const;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const UNVERIFIED_PREVIEW_THEME_PATH = path.join(
  moduleDirectory,
  "renderer",
  "unverified-preview-theme-v1.css",
);
export const UNVERIFIED_PREVIEW_HERO_PATH = path.join(
  moduleDirectory,
  "renderer",
  "unverified-europe-youth-hero.png",
);

const RenderedPreviewFileSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("index.html"),
    contentType: z.literal("text/html; charset=utf-8"),
    bytes: z.instanceof(Uint8Array),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    name: z.literal("styles.css"),
    contentType: z.literal("text/css; charset=utf-8"),
    bytes: z.instanceof(Uint8Array),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    name: z.literal("hero.png"),
    contentType: z.literal("image/png"),
    bytes: z.instanceof(Uint8Array),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

export const UnverifiedPreviewRenderResultSchema = z.strictObject({
  previewRevisionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  files: z.tuple([
    RenderedPreviewFileSchema,
    RenderedPreviewFileSchema,
    RenderedPreviewFileSchema,
  ]),
});
export type UnverifiedPreviewRenderResult = z.infer<
  typeof UnverifiedPreviewRenderResultSchema
>;

const CTA_LABELS: Readonly<Record<CommercialCtaGoal, string>> = {
  reservation: "예약하기",
  purchase: "구매하기",
  signup: "가입하기",
  download: "다운로드하기",
  inquiry: "문의하기",
};

const CTA_GOAL_LABELS: Readonly<Record<CommercialCtaGoal, string>> = {
  reservation: "예약",
  purchase: "구매",
  signup: "가입",
  download: "다운로드",
  inquiry: "문의",
};

async function loadThemeBytes(): Promise<Uint8Array> {
  const stat = await lstat(UNVERIFIED_PREVIEW_THEME_PATH);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Unverified preview theme은 regular non-symlink file이어야 합니다.");
  }
  const bytes = await readFile(UNVERIFIED_PREVIEW_THEME_PATH);
  const css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (css.includes("\r") || !css.endsWith("\n") || css.endsWith("\n\n")) {
    throw new Error("Unverified preview theme은 LF와 trailing LF 하나를 사용해야 합니다.");
  }
  if (/(?:@import|url\s*\(|javascript:|expression\s*\()/iu.test(css)) {
    throw new Error("Unverified preview theme에 외부 또는 실행 가능 resource가 있습니다.");
  }
  return bytes;
}

async function loadHeroBytes(): Promise<Uint8Array> {
  const stat = await lstat(UNVERIFIED_PREVIEW_HERO_PATH);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Unverified preview hero는 regular non-symlink file이어야 합니다.");
  }
  const bytes = await readFile(UNVERIFIED_PREVIEW_HERO_PATH);
  if (bytes.byteLength < 8) {
    throw new Error("Unverified preview hero image가 비어 있습니다.");
  }
  const signature = Array.from(bytes.subarray(0, 8));
  if (signature.join(",") !== "137,80,78,71,13,10,26,10") {
    throw new Error("Unverified preview hero image가 PNG가 아닙니다.");
  }
  return bytes;
}

function buildDocument(
  draft: UnverifiedPreviewDraftV1,
  commercialContext: CommercialContextV1,
  warningCodes: readonly string[],
) {
  const ctaGoal = commercialContext.cta_goal.value;
  const showDefaultHero =
    commercialContext.offering.value.includes("유럽") &&
    /(?:20대|청년)/u.test(commercialContext.target_reader.value);
  const googleFallback = warningCodes.some((code) => code.startsWith("google_"));
  return element("html", { lang: "ko-KR" }, [
    element("head", {}, [
      element("meta", { charset: "utf-8" }),
      element("meta", {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      }),
      element("meta", { content: "noindex,nofollow", name: "robots" }),
      element("title", {}, [text(draft.title)]),
      element("meta", { content: draft.metaDescription, name: "description" }),
      element("link", { href: "./styles.css", rel: "stylesheet" }),
    ]),
    element("body", {}, [
      element("main", {
        class: "preview-shell",
        "data-persona-snapshot-id": draft.personaSnapshotId,
      }, [
        element("aside", { class: "preview-warning", "data-warning-position": "top" }, [
          element("p", { "data-role": "unverified-warning" }, [
            text(UNVERIFIED_PREVIEW_WARNING),
          ]),
        ]),
        ...(googleFallback
          ? [
              element("aside", { class: "signal-warning", "data-signal-warning": "google" }, [
                element("p", {}, [
                  text("신호 제한: Google Trends 결과를 확인하지 못해 X 신호로 주제를 선택했습니다."),
                ]),
              ]),
            ]
          : []),
        element("header", { class: "preview-hero" }, [
          element("p", { class: "brand-line" }, [
            text(
              commercialContext.brand_name.value === commercialContext.brand_type.value
                ? commercialContext.brand_name.value
                : `${commercialContext.brand_name.value} · ${commercialContext.brand_type.value}`,
            ),
          ]),
          element("h1", { class: "preview-title" }, [text(draft.title)]),
          element("p", { class: "preview-deck" }, [text(draft.metaDescription)]),
          element("p", { class: "preview-intro" }, [text(draft.intro)]),
        ]),
        ...(showDefaultHero
          ? [
              element("figure", { class: "preview-media" }, [
                element("img", {
                  alt: "유럽 여행을 준비하는 20대 여행자들의 AI 생성 프리뷰 이미지",
                  decoding: "async",
                  height: "941",
                  src: "./hero.png",
                  width: "1672",
                }),
                element("figcaption", { class: "preview-media-caption" }, [
                  text("AI 생성 프리뷰 이미지 · 실제 상품 일정과 무관"),
                ]),
              ]),
            ]
          : []),
        ...draft.sections.map((section) =>
          element("section", { class: "preview-section" }, [
            element("h2", { class: "section-title" }, [text(section.heading)]),
            element("p", { class: "section-copy" }, [text(section.body)]),
          ]),
        ),
        element("aside", { class: "disabled-cta", "data-cta-state": "disabled" }, [
          element("h2", { class: "section-title" }, [
            text(`${commercialContext.offering.value} ${CTA_GOAL_LABELS[ctaGoal]} 안내`),
          ]),
          element("p", { class: "cta-copy" }, [text(draft.ctaSupportingCopy)]),
          element("span", {
            "aria-disabled": "true",
            class: "cta-disabled-label",
            "data-cta-disabled": "true",
          }, [text(`${CTA_LABELS[ctaGoal]} · 연결 주소 없음`)]),
          element("p", { class: "cta-note" }, [
            text("검증된 CTA URL이 제공되지 않아 이 프리뷰에서는 이동 기능이 비활성화되어 있습니다."),
          ]),
        ]),
        element("footer", { class: "preview-footer" }, [
          element("p", { class: "ai-disclosure" }, [
            text("이 페이지는 AI의 도움을 받아 만든 로컬 캠페인 프리뷰입니다."),
          ]),
          element("aside", { class: "preview-warning", "data-warning-position": "bottom" }, [
            element("p", { "data-role": "unverified-warning" }, [
              text(UNVERIFIED_PREVIEW_WARNING),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

export async function renderUnverifiedPreview(inputValue: {
  draft: UnverifiedPreviewDraftV1;
  commercialContext: CommercialContextV1;
  warningCodes: readonly string[];
}): Promise<UnverifiedPreviewRenderResult> {
  const draft = UnverifiedPreviewDraftV1Schema.parse(inputValue.draft);
  const commercialContext = CommercialContextV1Schema.parse(inputValue.commercialContext);
  const warningCodes = z.array(z.string().min(1)).parse(inputValue.warningCodes);
  const html = serializePreviewHtmlDocumentV1(
    buildDocument(draft, commercialContext, warningCodes),
  );
  const htmlBytes = new TextEncoder().encode(html);
  const cssBytes = await loadThemeBytes();
  const heroBytes = await loadHeroBytes();
  const htmlSha256 = sha256Bytes(htmlBytes);
  const cssSha256 = sha256Bytes(cssBytes);
  const heroSha256 = sha256Bytes(heroBytes);
  return UnverifiedPreviewRenderResultSchema.parse({
    previewRevisionSha256: sha256Canonical({ htmlSha256, cssSha256, heroSha256 }),
    files: [
      {
        name: "index.html",
        contentType: "text/html; charset=utf-8",
        bytes: htmlBytes,
        byteLength: htmlBytes.byteLength,
        sha256: htmlSha256,
      },
      {
        name: "styles.css",
        contentType: "text/css; charset=utf-8",
        bytes: cssBytes,
        byteLength: cssBytes.byteLength,
        sha256: cssSha256,
      },
      {
        name: "hero.png",
        contentType: "image/png",
        bytes: heroBytes,
        byteLength: heroBytes.byteLength,
        sha256: heroSha256,
      },
    ],
  });
}
