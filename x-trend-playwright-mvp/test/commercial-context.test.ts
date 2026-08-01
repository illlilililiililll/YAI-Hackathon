import { describe, expect, it } from "vitest";

import { extractCommercialContext } from "../src/commercial-context.js";

describe("extractCommercialContext", () => {
  it("separates a natural-language campaign sentence from the X search topic", () => {
    const context = extractCommercialContext(
      "유럽 전문 여행사에서 20대 청년들을 기반으로 패키지 여행상품을 판매하기 위한 글",
    );

    expect(context.search_topic).toEqual({ value: "유럽 패키지 여행", source: "inferred" });
    expect(context.brand_name).toEqual({ value: "유럽 전문 여행사", source: "default" });
    expect(context.brand_type).toEqual({ value: "유럽 전문 여행사", source: "inferred" });
    expect(context.target_reader).toEqual({ value: "20대 청년 여행자", source: "inferred" });
    expect(context.offering).toEqual({ value: "유럽 패키지 여행상품", source: "inferred" });
    expect(context.cta_goal).toEqual({ value: "reservation", source: "default" });
  });

  it("gives explicit key:value fields precedence and preserves each source", () => {
    const context = extractCommercialContext(
      [
        "brand_name: 트래블메이트",
        "brand_type: 동남아 전문 여행사",
        "target_reader: 첫 해외여행을 준비하는 대학생",
        "offering: 동남아 단체 패키지",
        "cta_goal: 문의",
        "search_topic: 방콕 패키지 여행",
      ].join("\n"),
    );

    expect(context.search_topic).toEqual({ value: "방콕 패키지 여행", source: "explicit" });
    expect(context.brand_name).toEqual({ value: "트래블메이트", source: "explicit" });
    expect(context.brand_type).toEqual({ value: "동남아 전문 여행사", source: "explicit" });
    expect(context.target_reader).toEqual({
      value: "첫 해외여행을 준비하는 대학생",
      source: "explicit",
    });
    expect(context.offering).toEqual({ value: "동남아 단체 패키지", source: "explicit" });
    expect(context.cta_goal).toEqual({ value: "inquiry", source: "explicit" });
  });

  it("infers a missing search topic from explicit commercial fields", () => {
    const context = extractCommercialContext(
      [
        "brand_name: 트래블메이트",
        "brand_type: 동남아 전문 여행사",
        "target_reader: 첫 해외여행을 준비하는 대학생",
        "offering: 동남아 단체 패키지 상품",
        "cta_goal: 문의",
      ].join("\n"),
    );

    expect(context.search_topic).toEqual({
      value: "동남아 패키지 여행",
      source: "inferred",
    });
  });

  it("uses field-level defaults without inventing a real brand", () => {
    const context = extractCommercialContext("유럽 여행 글을 작성해줘");
    expect(context.brand_name).toEqual({ value: "유럽 전문 여행사", source: "default" });
    expect(context.offering.source).toBe("default");
    expect(context.cta_goal).toEqual({ value: "reservation", source: "default" });
  });

  it("extracts non-default destinations and does not mistake adjectives for brands", () => {
    expect(extractCommercialContext("제주 여행 글을 작성해줘").search_topic).toEqual({
      value: "제주 여행",
      source: "inferred",
    });
    expect(extractCommercialContext("부산 가족 여행을 소개하는 글").search_topic).toEqual({
      value: "부산 가족 여행",
      source: "inferred",
    });
    expect(
      extractCommercialContext("친절한 여행사에서 유럽 여행 글을 작성해줘").brand_name,
    ).toEqual({ value: "유럽 전문 여행사", source: "default" });
  });

  it("rejects duplicate, empty, URL, and unsupported CTA fields", () => {
    expect(() =>
      extractCommercialContext("brand_name: 하나 brand_name: 둘"),
    ).toThrow(/중복/u);
    expect(() => extractCommercialContext("brand_name:" )).toThrow(/비어/u);
    expect(() => extractCommercialContext("offering: https://example.com/product")).toThrow(
      /URL/u,
    );
    expect(() => extractCommercialContext("cta_goal: 팔로우")).toThrow(/예약\/구매/u);
    expect(() => extractCommercialContext("offering: 100만원 특가 유럽 패키지")).toThrow(
      /미검증/u,
    );
    expect(() => extractCommercialContext("brand_name: 최고 보장 여행사")).toThrow(
      /미검증/u,
    );
  });
});
