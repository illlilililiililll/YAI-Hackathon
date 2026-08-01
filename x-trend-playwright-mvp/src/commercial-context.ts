import { z } from "zod";

export const CommercialFieldSourceSchema = z.enum(["explicit", "inferred", "default"]);
export type CommercialFieldSource = z.infer<typeof CommercialFieldSourceSchema>;

const CommercialTextFieldSchema = z.strictObject({
  value: z.string().min(1).max(160),
  source: CommercialFieldSourceSchema,
});

export const CommercialCtaGoalSchema = z.enum([
  "reservation",
  "purchase",
  "signup",
  "download",
  "inquiry",
]);
export type CommercialCtaGoal = z.infer<typeof CommercialCtaGoalSchema>;

const CommercialCtaGoalFieldSchema = z.strictObject({
  value: CommercialCtaGoalSchema,
  source: CommercialFieldSourceSchema,
});

export const CommercialContextV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  search_topic: CommercialTextFieldSchema,
  brand_name: CommercialTextFieldSchema,
  brand_type: CommercialTextFieldSchema,
  target_reader: CommercialTextFieldSchema,
  offering: CommercialTextFieldSchema,
  cta_goal: CommercialCtaGoalFieldSchema,
});

export type CommercialContextV1 = z.infer<typeof CommercialContextV1Schema>;

const DEFAULTS = Object.freeze({
  search_topic: "유럽 패키지 여행",
  brand_name: "유럽 전문 여행사",
  brand_type: "유럽 전문 여행사",
  target_reader: "유럽 패키지여행을 찾는 20대 청년 여행자",
  offering: "유럽 패키지 여행상품",
  cta_goal: "reservation" as const,
});

const KEY_ALIASES = {
  search_topic: "search_topic",
  topic: "search_topic",
  keyword: "search_topic",
  brand_name: "brand_name",
  brand_type: "brand_type",
  target_reader: "target_reader",
  offering: "offering",
  cta_goal: "cta_goal",
} as const;

type ExplicitKey = keyof typeof KEY_ALIASES;
type CanonicalKey = (typeof KEY_ALIASES)[ExplicitKey];

const KEY_VALUE_PATTERN = new RegExp(
  String.raw`(?:^|[\s;,])(${Object.keys(KEY_ALIASES).join("|")})\s*:\s*(.*?)(?=(?:[\s;,]+(?:${Object.keys(KEY_ALIASES).join("|")})\s*:)|[\n;]|$)`,
  "giu",
);
const FORBIDDEN_INPUT =
  /(?:https?:\/\/|www\.|<\/?[a-z][^>]*>|\[[^\]]+\]\([^)]+\)|javascript:|data:text\/html)/iu;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const UNSUPPORTED_COMMERCIAL_CLAIM =
  /(?:\d[\d,.]*\s*(?:원|유로|달러|퍼센트|%)|가격|할인|특가|무료|예약\s*가능|출발\s*확정|보장|무조건|최고|최저|유일|판매량|수상|인증|자격|경력|실적)/iu;

function normalizeText(value: string, label: string, maxLength = 160): string {
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/\p{White_Space}+/gu, " ");
  if (!normalized) throw new Error(`${label} 값이 비어 있습니다.`);
  if ([...normalized].length > maxLength) {
    throw new Error(`${label} 값이 너무 깁니다.`);
  }
  if (CONTROL_CHARACTER.test(normalized) || FORBIDDEN_INPUT.test(normalized)) {
    throw new Error(`${label} 값에 URL, markup 또는 제어 문자를 넣을 수 없습니다.`);
  }
  if (UNSUPPORTED_COMMERCIAL_CLAIM.test(normalized)) {
    throw new Error(`${label} 값에 미검증 가격·혜택·보장 표현을 넣을 수 없습니다.`);
  }
  return normalized;
}

function parseExplicitValues(rawInput: string): Map<CanonicalKey, string> {
  const values = new Map<CanonicalKey, string>();
  for (const match of rawInput.matchAll(KEY_VALUE_PATTERN)) {
    const rawKey = match[1]?.toLowerCase() as ExplicitKey | undefined;
    if (!rawKey || !(rawKey in KEY_ALIASES)) continue;
    const key = KEY_ALIASES[rawKey];
    if (values.has(key)) throw new Error(`${key} 값이 중복되었습니다.`);
    values.set(
      key,
      normalizeText(match[2] ?? "", key, key === "search_topic" ? 80 : 160),
    );
  }
  return values;
}

function field(value: string, source: CommercialFieldSource) {
  return { value, source } as const;
}

function inferRegion(input: string): string | null {
  const regions = ["유럽", "동남아", "일본", "미주", "호주", "중동"] as const;
  return regions.find((region) => input.includes(region)) ?? null;
}

function inferSearchTopic(input: string): string | null {
  const region = inferRegion(input);
  const hasPackage = /패키지(?:\s*여행|\s*상품|여행상품)?/u.test(input);
  if (region && hasPackage) return `${region} 패키지 여행`;
  if (region) return `${region} 여행`;
  const destination = /(?:^|\s)([가-힣A-Za-z][가-힣A-Za-z0-9·_-]{1,23})(?:\s+(가족|신혼|우정|배낭|혼자|패키지))?\s*여행(?!사)/u.exec(
    input,
  );
  if (destination?.[1]) {
    return [destination[1], destination[2], "여행"].filter(Boolean).join(" ");
  }
  if (hasPackage) return "패키지 여행";
  if (
    [...input].length <= 80 &&
    !/(?:작성|판매|발행|마케팅|타겟|독자|상품|서비스|전환|위한\s*글)/u.test(input)
  ) {
    return input;
  }
  return null;
}

function inferBrandName(input: string): string | null {
  const named = /(?:브랜드명|브랜드 이름|발행 주체)(?:은|는|이|가)?\s+([가-힣A-Za-z0-9&·_-]{2,30})/u.exec(
    input,
  )?.[1];
  if (named) return named;
  const quotedAgency = /["“']([^"”']{2,30})["”']\s*여행사/u.exec(input)?.[1];
  if (quotedAgency) return normalizeText(quotedAgency, "brand_name", 30);
  const calledAgency = /([가-힣A-Za-z0-9&·_-]{2,30})(?:라는|이라고\s*하는)\s*여행사/u.exec(
    input,
  )?.[1];
  if (calledAgency) return calledAgency;
  return null;
}

function inferBrandType(input: string): string | null {
  const region = inferRegion(input);
  if (region && /전문\s*여행사|여행사/u.test(input)) return `${region} 전문 여행사`;
  if (/여행사/u.test(input)) return "여행사";
  if (/여행\s*(?:정보\s*)?미디어/u.test(input)) return "여행 정보 미디어";
  return null;
}

function inferTargetReader(input: string): string | null {
  const age = /([1-6]0)\s*대/u.exec(input)?.[1];
  if (age) {
    return input.includes("청년") ? `${age}대 청년 여행자` : `${age}대 여행자`;
  }
  if (/대학생/u.test(input)) return "대학생 여행자";
  if (/신혼/u.test(input)) return "신혼여행을 준비하는 여행자";
  if (/가족/u.test(input)) return "가족여행을 준비하는 독자";
  if (/청년/u.test(input)) return "청년 여행자";
  return null;
}

function inferOffering(input: string): string | null {
  const region = inferRegion(input);
  if (/패키지(?:\s*여행)?(?:\s*상품|상품)/u.test(input)) {
    return region ? `${region} 패키지 여행상품` : "패키지 여행상품";
  }
  if (/패키지\s*여행/u.test(input)) {
    return region ? `${region} 패키지 여행상품` : "패키지 여행상품";
  }
  return null;
}

function normalizeCtaGoal(value: string, label: string): CommercialCtaGoal {
  const normalized = normalizeText(value, label, 40).toLowerCase();
  const aliases: Readonly<Record<string, CommercialCtaGoal>> = {
    reservation: "reservation",
    booking: "reservation",
    예약: "reservation",
    purchase: "purchase",
    구매: "purchase",
    결제: "purchase",
    signup: "signup",
    가입: "signup",
    download: "download",
    다운로드: "download",
    inquiry: "inquiry",
    문의: "inquiry",
    상담: "inquiry",
  };
  const goal = aliases[normalized];
  if (!goal) throw new Error(`${label} 값은 예약/구매/가입/다운로드/문의 중 하나여야 합니다.`);
  return goal;
}

function inferCtaGoal(input: string): CommercialCtaGoal | null {
  if (/예약/u.test(input)) return "reservation";
  if (/(?:구매|결제)/u.test(input)) return "purchase";
  if (/가입/u.test(input)) return "signup";
  if (/(?:다운로드|자료\s*받기)/u.test(input)) return "download";
  if (/(?:문의|상담)/u.test(input)) return "inquiry";
  return null;
}

function chooseText(
  explicit: string | undefined,
  inferred: string | null,
  fallback: string,
) {
  return explicit !== undefined
    ? field(explicit, "explicit")
    : inferred
      ? field(inferred, "inferred")
      : field(fallback, "default");
}

export function extractCommercialContext(rawInput: string): CommercialContextV1 {
  const input = normalizeText(rawInput, "input", 2_000);
  const explicit = parseExplicitValues(input);
  const prose = input.replace(KEY_VALUE_PATTERN, " ").replace(/\s+/gu, " ").trim();
  const inferenceInput = [
    prose,
    explicit.get("brand_type"),
    explicit.get("target_reader"),
    explicit.get("offering"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  const explicitCta = explicit.get("cta_goal");
  const inferredCta = inferCtaGoal(inferenceInput);
  const ctaGoal = explicitCta
    ? { value: normalizeCtaGoal(explicitCta, "cta_goal"), source: "explicit" as const }
    : inferredCta
      ? { value: inferredCta, source: "inferred" as const }
      : { value: DEFAULTS.cta_goal, source: "default" as const };

  return CommercialContextV1Schema.parse({
    schemaVersion: "1.0",
    search_topic: chooseText(
      explicit.get("search_topic"),
      inferSearchTopic(inferenceInput),
      DEFAULTS.search_topic,
    ),
    brand_name: chooseText(
      explicit.get("brand_name"),
      inferBrandName(prose),
      DEFAULTS.brand_name,
    ),
    brand_type: chooseText(
      explicit.get("brand_type"),
      inferBrandType(inferenceInput),
      DEFAULTS.brand_type,
    ),
    target_reader: chooseText(
      explicit.get("target_reader"),
      inferTargetReader(inferenceInput),
      DEFAULTS.target_reader,
    ),
    offering: chooseText(
      explicit.get("offering"),
      inferOffering(inferenceInput),
      DEFAULTS.offering,
    ),
    cta_goal: ctaGoal,
  });
}
