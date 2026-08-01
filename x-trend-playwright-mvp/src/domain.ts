import { z } from "zod";

export const SearchStatusSchema = z.enum([
  "ok",
  "login_required",
  "blocked",
  "error",
]);

const XPostUrlSchema = z
  .url()
  .refine((value) => {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "x.com" || hostname.endsWith(".x.com");
  }, "게시물 URL은 x.com 주소여야 합니다.");

export const XPostSchema = z.object({
  author: z.string().trim().min(1),
  text: z.string().trim().min(1),
  url: XPostUrlSchema.nullable(),
});

export const AgentSearchPayloadSchema = z.object({
  status: SearchStatusSchema,
  posts: z.array(XPostSchema).max(10),
  message: z.string().trim().min(1),
});

export const XSearchResultSchema = AgentSearchPayloadSchema.extend({
  keyword: z.string().min(1),
  searchUrl: z.url(),
  collectedAt: z.iso.datetime(),
});

export type AgentSearchPayload = z.infer<typeof AgentSearchPayloadSchema>;
export type XSearchResult = z.infer<typeof XSearchResultSchema>;

export function normalizeKeyword(input: string): string {
  const normalized = input.normalize("NFKC").trim().replace(/\s+/gu, " ");

  if (!normalized) {
    throw new Error("검색 키워드를 입력해야 합니다.");
  }

  if (normalized.length > 100) {
    throw new Error("검색 키워드는 100자 이하여야 합니다.");
  }

  return normalized;
}

export function buildXSearchUrl(keyword: string): string {
  const url = new URL("https://x.com/search");
  url.searchParams.set("q", normalizeKeyword(keyword));
  url.searchParams.set("src", "typed_query");
  url.searchParams.set("f", "live");
  return url.toString();
}
