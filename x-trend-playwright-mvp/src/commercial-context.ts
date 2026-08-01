import { z } from "zod";

export const CommercialFieldSourceSchema = z.literal("explicit");
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

export const CommercialContextV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    brand_name: CommercialTextFieldSchema,
    brand_type: CommercialTextFieldSchema,
    target_reader: CommercialTextFieldSchema,
    offering: CommercialTextFieldSchema,
    cta_goal: CommercialCtaGoalFieldSchema,
  })
  .superRefine(validateCommercialContext);

export type CommercialContextV1 = z.infer<typeof CommercialContextV1Schema>;

const CANONICAL_KEYS = [
  "brand_name",
  "brand_type",
  "target_reader",
  "offering",
  "cta_goal",
] as const;
type CanonicalKey = (typeof CANONICAL_KEYS)[number];

const CANONICAL_KEY_SET = new Set<string>(CANONICAL_KEYS);
const FORBIDDEN_INPUT =
  /(?:https?:\/\/|\/\/[a-z0-9]|www\.|\b[a-z0-9][a-z0-9.-]*\.(?:com|net|org|io|co|kr|jp|ai)(?:\/\S*)?|<[^>]*>|\[[^\]]+\]\([^)]+\)|javascript:|data:text\/html)/iu;
const CONTROL_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const RESIDUAL_INPUT =
  /(?:search_topic|\btopic\b|\bkeyword\b|검색\s*주제|검색어|키워드|(?:글|콘텐츠|문서|페이지)\s*(?:을|를)?\s*(?:작성|생성|제작|발행)|(?:작성|생성|제작|발행)\s*해\s*(?:줘|주세요|주십시오)|(?:써|만들어)\s*(?:줘|주세요|주십시오))/iu;
const UNSUPPORTED_COMMERCIAL_CLAIM =
  /(?:[₩$€]\s*\d[\d,.]*|\d[\d,.]*(?:\s*(?:만|천))?\s*(?:원|유로|달러|usd|eur|퍼센트|%)|가격|할인|특가|무료|예약\s*가능|출발\s*확정|보장|무조건|최고|최저|유일|판매량|수상|인증|자격|경력|실적)/iu;

type RegionGroup = Readonly<{
  id: string;
  label: string;
  terms: readonly string[];
  patterns?: readonly RegExp[];
}>;

const REGION_GROUPS: readonly RegionGroup[] = [
  {
    id: "europe",
    label: "유럽",
    terms: [
      "유럽",
      "영국",
      "프랑스",
      "이탈리아",
      "스페인",
      "포르투갈",
      "독일",
      "스위스",
      "오스트리아",
      "체코",
      "그리스",
      "북유럽",
    ],
    patterns: [
      /(?:^|[^\p{L}\p{N}])(?:파리|로마)(?=$|[\s·,./()-]|여행|패키지|항공|관광|투어)/u,
    ],
  },
  {
    id: "japan",
    label: "일본",
    terms: [
      "일본",
      "도쿄",
      "오사카",
      "교토",
      "후쿠오카",
      "홋카이도",
      "삿포로",
      "오키나와",
    ],
  },
  {
    id: "southeast_asia",
    label: "동남아",
    terms: [
      "동남아",
      "태국",
      "방콕",
      "베트남",
      "다낭",
      "하노이",
      "호치민",
      "싱가포르",
      "말레이시아",
      "인도네시아",
      "발리",
      "필리핀",
    ],
    patterns: [/(?:^|필리핀\s+)세부\s*(?:여행|패키지|리조트|항공|투어|관광|휴양)/u],
  },
  {
    id: "korea",
    label: "국내",
    terms: ["국내", "한국", "서울", "제주", "부산", "강원"],
  },
  {
    id: "americas",
    label: "미주",
    terms: ["미주", "미국", "캐나다", "뉴욕", "하와이"],
  },
  {
    id: "oceania",
    label: "오세아니아",
    terms: ["오세아니아", "뉴질랜드"],
    patterns: [
      /(?:^|[^\p{L}\p{N}])호주(?=$|[\s·,./()-]|여행|패키지|항공|관광|투어)/u,
    ],
  },
  {
    id: "middle_east",
    label: "중동",
    terms: ["중동", "두바이", "아랍에미리트"],
  },
  {
    id: "greater_china",
    label: "중화권",
    terms: [
      "중화권",
      "중국",
      "베이징",
      "상하이",
      "장가계",
      "하이난",
      "대만",
      "타이베이",
      "홍콩",
      "마카오",
    ],
  },
  {
    id: "south_asia",
    label: "남아시아",
    terms: ["남아시아", "네팔", "스리랑카", "몰디브", "북인도", "남인도"],
    patterns: [
      /(?:^|[^\p{L}\p{N}])인도(?=$|[\s·,./()-]|여행|패키지|항공|관광|투어)/u,
    ],
  },
  {
    id: "africa",
    label: "아프리카",
    terms: ["아프리카", "이집트", "모로코", "남아공", "케냐", "탄자니아"],
  },
];

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
  if (RESIDUAL_INPUT.test(normalized)) {
    throw new Error(`${label} 값에는 별도 검색어 또는 실행 지시 문장을 넣을 수 없습니다.`);
  }
  if (UNSUPPORTED_COMMERCIAL_CLAIM.test(normalized)) {
    throw new Error(`${label} 값에 미검증 가격·혜택·보장 표현을 넣을 수 없습니다.`);
  }
  return normalized;
}

function normalizeRawInput(rawInput: string): string {
  const input = rawInput.normalize("NFC").trim();
  if (!input) throw new Error("필수 입력 필드 5개가 필요합니다.");
  if ([...input].length > 2_000) throw new Error("input 값이 너무 깁니다.");
  if (CONTROL_CHARACTER.test(input)) {
    throw new Error("input 값에 제어 문자를 넣을 수 없습니다.");
  }
  return input;
}

function displaySegment(segment: string): string {
  const normalized = segment.replace(/\p{White_Space}+/gu, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function parseExplicitValues(rawInput: string): Map<CanonicalKey, string> {
  const values = new Map<CanonicalKey, string>();
  const segments = rawInput
    .split(/[;\n]/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const separator = segment.indexOf(":");
    if (separator <= 0) {
      throw new Error(`key:value 형식이 아닌 입력 segment입니다: ${displaySegment(segment)}`);
    }

    const rawKey = segment.slice(0, separator).trim();
    if (!CANONICAL_KEY_SET.has(rawKey)) {
      throw new Error(`인식할 수 없는 입력 key입니다: ${rawKey}`);
    }
    const key = rawKey as CanonicalKey;
    if (values.has(key)) throw new Error(`${key} 값이 중복되었습니다.`);

    const rawValue = segment.slice(separator + 1);
    const value = normalizeText(rawValue, key);
    if (/[:：]/u.test(rawValue)) {
      throw new Error(
        `필드는 세미콜론 또는 줄바꿈으로 구분하고 각 segment에는 하나의 key:value만 입력해야 합니다: ${displaySegment(segment)}`,
      );
    }
    values.set(key, value);
  }

  const missing = CANONICAL_KEYS.filter((key) => !values.has(key));
  if (missing.length > 0) {
    throw new Error(`필수 입력 필드가 없습니다: ${missing.join(", ")}`);
  }
  return values;
}

function normalizeCtaGoal(value: string, label: string): CommercialCtaGoal {
  const normalized = normalizeText(value, label, 40).toLowerCase();
  const allowedValues: Readonly<Record<string, CommercialCtaGoal>> = {
    reservation: "reservation",
    예약: "reservation",
    purchase: "purchase",
    구매: "purchase",
    signup: "signup",
    가입: "signup",
    download: "download",
    다운로드: "download",
    inquiry: "inquiry",
    문의: "inquiry",
  };
  const goal = allowedValues[normalized];
  if (!goal) throw new Error(`${label} 값은 예약/구매/가입/다운로드/문의 중 하나여야 합니다.`);
  return goal;
}

function detectRegions(value: string): RegionGroup[] {
  return REGION_GROUPS.filter((region) =>
    region.terms.some((term) => value.includes(term)) ||
    region.patterns?.some((pattern) => pattern.test(value)),
  );
}

function assertRegionConsistency(values: Map<CanonicalKey, string>): void {
  const regionFields = (["brand_type", "target_reader", "offering"] as const)
    .map((key) => ({ key, regions: detectRegions(values.get(key)!) }))
    .filter((entry) => entry.regions.length > 0);
  if (regionFields.length <= 1) return;

  const baseline = new Set(regionFields[0]!.regions.map((region) => region.id));
  const isConsistent = regionFields.every(({ regions }) => {
    const ids = new Set(regions.map((region) => region.id));
    return ids.size === baseline.size && [...ids].every((id) => baseline.has(id));
  });
  if (isConsistent) return;

  const detail = regionFields
    .map(
      ({ key, regions }) =>
        `${key}(${regions.map((region) => region.label).join(", ")})`,
    )
    .join(", ");
  throw new Error(`상업 입력 필드의 지역이 충돌합니다: ${detail}`);
}

function validateCommercialContext(
  context: {
    brand_name: { value: string };
    brand_type: { value: string };
    target_reader: { value: string };
    offering: { value: string };
    cta_goal: { value: CommercialCtaGoal };
  },
  refinement: z.RefinementCtx,
): void {
  const values = new Map<CanonicalKey, string>([
    ["brand_name", context.brand_name.value],
    ["brand_type", context.brand_type.value],
    ["target_reader", context.target_reader.value],
    ["offering", context.offering.value],
    ["cta_goal", context.cta_goal.value],
  ]);

  for (const key of CANONICAL_KEYS) {
    const value = values.get(key)!;
    try {
      const normalized = normalizeText(value, key, key === "cta_goal" ? 40 : 160);
      if (normalized !== value) {
        refinement.addIssue({
          code: "custom",
          path: [key, "value"],
          message: `${key} 값은 정규화된 명시값이어야 합니다.`,
        });
      }
    } catch (error) {
      refinement.addIssue({
        code: "custom",
        path: [key, "value"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    assertRegionConsistency(values);
  } catch (error) {
    refinement.addIssue({
      code: "custom",
      path: ["offering", "value"],
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function field(value: string) {
  return { value, source: "explicit" as const };
}

export function extractCommercialContext(rawInput: string): CommercialContextV1 {
  const input = normalizeRawInput(rawInput);
  const explicit = parseExplicitValues(input);
  assertRegionConsistency(explicit);

  return CommercialContextV1Schema.parse({
    schemaVersion: "1.0",
    brand_name: field(explicit.get("brand_name")!),
    brand_type: field(explicit.get("brand_type")!),
    target_reader: field(explicit.get("target_reader")!),
    offering: field(explicit.get("offering")!),
    cta_goal: {
      value: normalizeCtaGoal(explicit.get("cta_goal")!, "cta_goal"),
      source: "explicit",
    },
  });
}
