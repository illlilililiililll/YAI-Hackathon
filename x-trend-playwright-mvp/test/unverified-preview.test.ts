import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { extractCommercialContext } from "../src/commercial-context.js";
import type { ContentBriefV1, PersonaSnapshotV1 } from "../src/content-domain.js";
import {
  validateUnverifiedPreviewDraft,
  writeUnverifiedPreviewDraft,
  type UnverifiedPreviewDraftProvider,
  type UnverifiedPreviewDraftV1,
} from "../src/unverified-preview-agent.js";
import {
  renderUnverifiedPreview,
  UNVERIFIED_PREVIEW_WARNING,
} from "../src/unverified-preview-renderer.js";
import {
  UNVERIFIED_PREVIEW_FILE_NAMES,
  UnverifiedPreviewStore,
} from "../src/unverified-preview-store.js";

const brief: ContentBriefV1 = {
  schemaVersion: "1.0",
  primaryKeyword: "유럽 패키지 여행",
  secondaryKeywords: ["유럽 여행 준비", "청년 여행", "패키지 선택"],
  articleIntent: "recommendation",
  coverage: "focused",
  keywordSelectionSha256: "a".repeat(64),
};

const commercialContext = extractCommercialContext(
  "유럽 전문 여행사가 20대 청년에게 패키지 여행상품을 소개하는 글",
);

const persona: PersonaSnapshotV1 = {
  schemaVersion: "1.0",
  snapshotId: `persona_${"a".repeat(24)}`,
  personaVersion: "1.3.0",
  personaDocumentSha256: "b".repeat(64),
  personaSnapshotSha256: "c".repeat(64),
  brandName: commercialContext.brand_name.value,
  brandType: commercialContext.brand_type.value,
  targetReader: commercialContext.target_reader.value,
  tone: "차분하고 구체적인 합니다체",
  voiceTags: ["answer-first", "grounded", "practical"],
};

function validDraft(): UnverifiedPreviewDraftV1 {
  return {
    schemaVersion: "1.0",
    personaSnapshotId: persona.snapshotId,
    title: "유럽 패키지 여행, 나에게 맞는 방식부터 살펴보기",
    metaDescription:
      "유럽 패키지 여행을 고민하는 청년 독자가 원하는 여행 방식과 선택 기준을 차분하게 정리하는 캠페인 프리뷰입니다.",
    intro:
      "여행을 고르는 첫 단계는 내가 기대하는 경험과 준비 방식을 말로 정리해 보는 것입니다.",
    sections: [
      {
        heading: "먼저 원하는 여행 모습을 떠올려 보세요",
        body: "누구와 어떤 분위기로 떠나고 싶은지 질문해 보면 상품을 살펴볼 때 기준을 세우기 좋습니다.",
      },
      {
        heading: "상품 설명에서 확인할 질문을 준비하세요",
        body: "제공된 설명을 읽으며 내 우선순위와 맞는지 차근차근 비교해 보세요.",
      },
    ],
    ctaSupportingCopy:
      "관심이 있다면 연결 주소가 준비된 뒤 상품 설명을 직접 확인해 보세요.",
  };
}

describe("unverified preview writer boundary", () => {
  it("rejects external facts, URLs, prices, and popularity claims", () => {
    const base = validDraft();
    for (const forbidden of [
      "가장 인기 있는 선택입니다.",
      "가격은 100유로입니다.",
      "비자 없이 입국할 수 있습니다.",
      "https://example.com에서 확인하세요.",
      "다녀온 사람들은 보통 이동 방식부터 정리합니다.",
    ]) {
      expect(() =>
        validateUnverifiedPreviewDraft(
          {
            ...base,
            sections: [
              { ...base.sections[0]!, body: forbidden },
              base.sections[1]!,
            ],
          },
          { brief, commercialContext, persona },
        ),
      ).toThrow();
    }
  });

  it("repairs invalid output exactly once", async () => {
    const generate = vi
      .fn<UnverifiedPreviewDraftProvider["generate"]>()
      .mockResolvedValueOnce({ ...validDraft(), intro: "현재 가장 인기 있는 여행입니다." })
      .mockResolvedValueOnce(validDraft());
    const draft = await writeUnverifiedPreviewDraft(
      { generate },
      { brief, commercialContext, persona },
    );
    expect(draft.title).toContain(brief.primaryKeyword);
    expect(draft.personaSnapshotId).toBe(persona.snapshotId);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.map(([request]) => request.mode)).toEqual(["initial", "repair"]);
  });

  it("rejects hard-sell copy and Persona style violations", () => {
    expect(() =>
      validateUnverifiedPreviewDraft(
        { ...validDraft(), intro: "지금 결정해!" },
        { brief, commercialContext, persona },
      ),
    ).toThrow(/persona_hard_sell/u);
    expect(() =>
      validateUnverifiedPreviewDraft(
        { ...validDraft(), ctaSupportingCopy: "기회를 놓치기 전에 서두르세요." },
        { brief, commercialContext, persona },
      ),
    ).toThrow(/persona_hard_sell/u);
  });

  it("accepts Korean question headings without terminal punctuation", () => {
    expect(() =>
      validateUnverifiedPreviewDraft(
        {
          ...validDraft(),
          sections: validDraft().sections.map((section, index) => ({
            ...section,
            heading: index === 0 ? "여행 방향은 어떻게 정할까요" : section.heading,
          })),
        },
        { brief, commercialContext, persona },
      ),
    ).not.toThrow();
  });
});

describe("unverified preview render and store", () => {
  it("forces two warnings, noindex, and a disabled CTA without anchors", async () => {
    const rendered = await renderUnverifiedPreview({
      draft: validDraft(),
      commercialContext,
      warningCodes: ["google_trends_unavailable"],
    });
    const html = new TextDecoder().decode(rendered.files[0].bytes);
    expect(html.match(new RegExp(UNVERIFIED_PREVIEW_WARNING, "gu"))).toHaveLength(2);
    expect(html).toContain('<meta content="noindex,nofollow" name="robots">');
    expect(html).toContain('data-cta-state="disabled"');
    expect(html).toContain(`data-persona-snapshot-id="${persona.snapshotId}"`);
    expect(html).toContain('<img alt="유럽 여행을 준비하는 20대 여행자들의 AI 생성 프리뷰 이미지"');
    expect(html).toContain('src="./hero.png"');
    expect(html).toContain("AI 생성 프리뷰 이미지");
    expect(html).toContain("Google Trends 결과를 확인하지 못해 X 신호로 주제를 선택했습니다.");
    expect(html).toContain("연결 주소 없음");
    expect(html).toContain(commercialContext.brand_name.value);
    expect(html).not.toContain("이 프리뷰의 캠페인 기준");
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script");
    expect(rendered.files[2]).toMatchObject({
      name: "hero.png",
      contentType: "image/png",
    });
    expect(rendered.files[2].byteLength).toBeGreaterThan(0);
  });

  it("does not show the Europe-youth hero for a mismatched campaign", async () => {
    const rendered = await renderUnverifiedPreview({
      draft: validDraft(),
      commercialContext: extractCommercialContext(
        "search_topic: 일본 가족 여행; target_reader: 가족 여행자; offering: 일본 패키지 여행상품",
      ),
      warningCodes: [],
    });
    const html = new TextDecoder().decode(rendered.files[0].bytes);
    expect(html).not.toContain("<img ");
    expect(html).not.toContain("유럽 여행을 준비하는 20대 여행자");
  });

  it("rejects a draft that does not carry the current PersonaSnapshot identity", () => {
    expect(() =>
      validateUnverifiedPreviewDraft(
        { ...validDraft(), personaSnapshotId: `persona_${"d".repeat(24)}` },
        { brief, commercialContext, persona },
      ),
    ).toThrow(/persona_snapshot_mismatch/u);
  });

  it("writes only the closed preview file tuple outside output/runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yai-unverified-preview-"));
    const outputRoot = path.join(root, "output");
    const runId = "run_00000000-0000-4000-8000-000000000001";
    const store = new UnverifiedPreviewStore({ outputRoot });
    const files = UNVERIFIED_PREVIEW_FILE_NAMES.map((name) => ({
      name,
      bytes: new TextEncoder().encode(`${name}\n`),
    }));
    const result = await store.commit({ runId, files });

    expect((await readdir(result.runDirectory)).sort()).toEqual(
      [...UNVERIFIED_PREVIEW_FILE_NAMES].sort(),
    );
    expect(await readFile(path.join(result.runDirectory, "PREVIEW_ONLY.txt"), "utf8"))
      .toContain("PREVIEW_ONLY");
    await expect(readdir(path.join(outputRoot, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
