import { describe, expect, it } from "vitest";

import {
  CommercialContextV1Schema,
  extractCommercialContext,
} from "../src/commercial-context.js";

const VALID_FIELDS = {
  brand_name: "트래블메이트",
  brand_type: "일본 전문 여행사",
  target_reader: "일본 여행을 준비하는 가족",
  offering: "일본 패키지 여행상품",
  cta_goal: "문의",
} as const;

function inputWith(
  overrides: Partial<Record<keyof typeof VALID_FIELDS, string>> = {},
  omitted: keyof typeof VALID_FIELDS | null = null,
): string {
  return Object.entries({ ...VALID_FIELDS, ...overrides })
    .filter(([key]) => key !== omitted)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

describe("extractCommercialContext", () => {
  it("requires and returns exactly five explicit commercial fields", () => {
    const context = extractCommercialContext(
      Object.entries(VALID_FIELDS)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
    );

    expect(context).toEqual({
      schemaVersion: "1.0",
      brand_name: { value: VALID_FIELDS.brand_name, source: "explicit" },
      brand_type: { value: VALID_FIELDS.brand_type, source: "explicit" },
      target_reader: { value: VALID_FIELDS.target_reader, source: "explicit" },
      offering: { value: VALID_FIELDS.offering, source: "explicit" },
      cta_goal: { value: "inquiry", source: "explicit" },
    });
    expect(JSON.stringify(context)).not.toMatch(/search_topic|inferred|default/u);
  });

  it("reports every missing required field", () => {
    for (const key of Object.keys(VALID_FIELDS) as Array<keyof typeof VALID_FIELDS>) {
      expect(() => extractCommercialContext(inputWith({}, key))).toThrow(
        new RegExp(key, "u"),
      );
    }
  });

  it("rejects duplicate and empty fields", () => {
    expect(() =>
      extractCommercialContext(`${inputWith()}; brand_name: 다른브랜드`),
    ).toThrow(/brand_name.*중복/u);
    expect(() => extractCommercialContext(inputWith({ brand_name: "" }))).toThrow(
      /brand_name.*비어/u,
    );
  });

  it("rejects search-topic aliases, unknown keys, and residual natural language", () => {
    for (const invalid of [
      `${inputWith()}; search_topic: 일본 여행`,
      `${inputWith()}; topic: 일본 여행`,
      `${inputWith()}; keyword: 일본 여행`,
      `${inputWith()}; unknown_key: 값`,
      "일본 전문 여행사가 가족에게 패키지 상품을 소개하는 글",
      `${inputWith()}; 이 글을 작성해줘`,
      inputWith({ offering: "일본 패키지 여행상품 글을 작성해 주세요" }),
      inputWith({ offering: "일본 패키지 작성해줘" }),
      inputWith({ offering: "일본 패키지 keyword 도쿄" }),
      inputWith({ offering: "일본 패키지 | hidden_key: value" }),
      inputWith({ offering: "일본 패키지 검색주제：도쿄" }),
    ]) {
      expect(() => extractCommercialContext(invalid)).toThrow();
    }
  });

  it("requires semicolons or line breaks between fields", () => {
    expect(() =>
      extractCommercialContext(
        "brand_name: 트래블메이트 brand_type: 일본 전문 여행사 " +
          "target_reader: 가족 offering: 일본 패키지 cta_goal: 문의",
      ),
    ).toThrow(/세미콜론 또는 줄바꿈/u);
  });

  it("retains URL, markup, control-character, claim, and CTA safety checks", () => {
    expect(() =>
      extractCommercialContext(inputWith({ offering: "https://example.com/product" })),
    ).toThrow(/URL/u);
    expect(() =>
      extractCommercialContext(inputWith({ offering: "일본 패키지 //evil.example/product" })),
    ).toThrow(/URL/u);
    expect(() =>
      extractCommercialContext(inputWith({ offering: "일본 패키지 evil.example.com" })),
    ).toThrow(/URL/u);
    expect(() =>
      extractCommercialContext(inputWith({ offering: "<b>일본 패키지</b>" })),
    ).toThrow(/markup/u);
    expect(() =>
      extractCommercialContext(inputWith({ brand_name: "트래블\u0000메이트" })),
    ).toThrow(/제어/u);
    expect(() =>
      extractCommercialContext(inputWith({ brand_name: "트래블\u009b메이트" })),
    ).toThrow(/제어/u);
    expect(() =>
      extractCommercialContext(inputWith({ offering: "일본 <!-- hidden --> 패키지" })),
    ).toThrow(/markup/u);
    expect(() =>
      extractCommercialContext(inputWith({ offering: "100만원 일본 패키지" })),
    ).toThrow(/미검증/u);
    expect(() =>
      extractCommercialContext(inputWith({ offering: "일본 패키지 $100" })),
    ).toThrow(/미검증/u);
    expect(() =>
      extractCommercialContext(inputWith({ brand_name: "최고 보장 여행사" })),
    ).toThrow(/미검증/u);
    expect(() => extractCommercialContext(inputWith({ cta_goal: "팔로우" }))).toThrow(
      /예약\/구매/u,
    );
    for (const legacyAlias of ["booking", "결제", "상담"]) {
      expect(() =>
        extractCommercialContext(inputWith({ cta_goal: legacyAlias })),
      ).toThrow(/예약\/구매/u);
    }
  });

  it("rejects conflicting known regions across the commercial fields", () => {
    expect(() =>
      extractCommercialContext(inputWith({ offering: "유럽 패키지 여행상품" })),
    ).toThrow(/brand_type.*일본.*offering.*유럽/u);
    expect(() =>
      extractCommercialContext(inputWith({ target_reader: "유럽 여행을 준비하는 가족" })),
    ).toThrow(/target_reader.*유럽.*offering.*일본/u);
    expect(() =>
      extractCommercialContext(
        inputWith({
          brand_type: "중국 전문 여행사",
          target_reader: "중국 여행을 준비하는 가족",
        }),
      ),
    ).toThrow(/중화권.*일본/u);
    expect(() => extractCommercialContext(inputWith())).not.toThrow();
  });

  it("handles ambiguous and consistently multi-region values", () => {
    expect(() =>
      extractCommercialContext(inputWith({ offering: "일본 상품 세부 안내" })),
    ).not.toThrow();
    for (const offering of [
      "일본 패키지 세부 여행 일정",
      "로마자 안내가 필요한 일본 여행상품",
      "호주머니가 가벼운 일본 여행상품",
    ]) {
      expect(() => extractCommercialContext(inputWith({ offering }))).not.toThrow();
    }
    expect(() =>
      extractCommercialContext(
        inputWith({
          brand_type: "일본·유럽 전문 여행사",
          target_reader: "일본·유럽 여행을 준비하는 가족",
          offering: "일본·유럽 패키지 여행상품",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects legacy non-explicit field sources at the public schema", () => {
    const context = extractCommercialContext(inputWith());
    expect(
      CommercialContextV1Schema.safeParse({
        ...context,
        brand_name: { ...context.brand_name, source: "default" },
      }).success,
    ).toBe(false);
  });

  it("enforces safety and region consistency through the public schema", () => {
    const context = extractCommercialContext(inputWith());
    expect(
      CommercialContextV1Schema.safeParse({
        ...context,
        offering: { ...context.offering, value: "<b>일본 패키지</b>" },
      }).success,
    ).toBe(false);
    expect(
      CommercialContextV1Schema.safeParse({
        ...context,
        offering: { ...context.offering, value: "유럽 패키지 여행상품" },
      }).success,
    ).toBe(false);
  });
});
