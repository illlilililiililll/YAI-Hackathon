import { z } from "zod";

import {
  SiteLinkCandidateV1Schema,
  WriterLinkChoiceV1Schema,
  type SiteLinkCandidateV1,
  type WriterLinkChoiceV1,
} from "./content-domain.js";

export const LINK_LABELS_V1 = {
  internal_guide: "관련 여행 가이드 보기",
  internal_details: "자세히 보기",
  cta_contact: "여행 상담하기",
  cta_more: "여행 정보 더 보기",
} as const;

export type LinkLabelId = keyof typeof LINK_LABELS_V1;

const LinkCandidateInputSchema = z.strictObject({
  linkCandidateId: z.string().regex(/^link_[a-z0-9][a-z0-9_-]{0,47}$/u),
  kind: z.enum(["internal", "cta"]),
  labelId: z.enum([
    "internal_guide",
    "internal_details",
    "cta_contact",
    "cta_more",
  ]),
  url: z.string().min(1),
});

const SiteLinkRegistryInputSchema = z.strictObject({
  siteOrigin: z.string().min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  candidates: z.array(LinkCandidateInputSchema),
});

export type SiteLinkRegistryInput = z.input<typeof SiteLinkRegistryInputSchema>;

export type SiteLinkRegistry = Readonly<{
  siteOrigin: string;
  allowedHosts: readonly string[];
  candidates: readonly SiteLinkCandidateV1[];
}>;

const PLACEHOLDER_PATTERN = /(?:\{\{|\}\}|<%|%>|\[\s*(?:todo|tbd|link|url|링크)\s*\]|placeholder)/iu;

function parseHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}은(는) 유효한 absolute URL이어야 합니다.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label}은(는) HTTPS만 허용합니다.`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label}에는 credential 또는 fragment를 넣을 수 없습니다.`);
  }
  if (PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`${label}에는 placeholder를 넣을 수 없습니다.`);
  }
  return url;
}

function validateAllowedHost(host: string): void {
  if (!/^[a-z0-9.-]+$/u.test(host) || host.endsWith(".") || host.includes(":")) {
    throw new Error(`allowedHosts 값이 올바르지 않습니다: ${host}`);
  }
  const parsed = new URL(`https://${host}/`);
  if (parsed.hostname !== host) {
    throw new Error(`allowedHosts는 canonical lower-case hostname이어야 합니다: ${host}`);
  }
}

export function createSiteLinkRegistry(
  inputValue: SiteLinkRegistryInput,
): SiteLinkRegistry {
  const input = SiteLinkRegistryInputSchema.parse(inputValue);
  const originUrl = parseHttpsUrl(input.siteOrigin, "siteOrigin");
  if (originUrl.pathname !== "/" || originUrl.search) {
    throw new Error("siteOrigin은 origin root만 허용합니다.");
  }

  input.allowedHosts.forEach(validateAllowedHost);
  const sortedHosts = [...input.allowedHosts].sort();
  if (
    new Set(input.allowedHosts).size !== input.allowedHosts.length ||
    input.allowedHosts.some((host, index) => host !== sortedHosts[index])
  ) {
    throw new Error("allowedHosts는 ASCII 오름차순의 고유 배열이어야 합니다.");
  }
  if (!input.allowedHosts.includes(originUrl.hostname)) {
    throw new Error("siteOrigin hostname이 allowedHosts에 없습니다.");
  }

  const candidates = input.candidates.map((candidate) => {
    const expectedKind = candidate.labelId.startsWith("internal_")
      ? "internal"
      : "cta";
    if (candidate.kind !== expectedKind) {
      throw new Error("link kind와 labelId가 일치하지 않습니다.");
    }
    const url = parseHttpsUrl(candidate.url, "candidate.url");
    if (!input.allowedHosts.includes(url.hostname)) {
      throw new Error("link candidate hostname이 allowedHosts에 없습니다.");
    }
    return SiteLinkCandidateV1Schema.parse({
      linkCandidateId: candidate.linkCandidateId,
      kind: candidate.kind,
      displayLabel: LINK_LABELS_V1[candidate.labelId],
      url: url.href,
    });
  });

  const ids = candidates.map((candidate) => candidate.linkCandidateId);
  const urls = candidates.map((candidate) => candidate.url);
  if (new Set(ids).size !== ids.length || new Set(urls).size !== urls.length) {
    throw new Error("link candidate ID와 URL은 각각 고유해야 합니다.");
  }

  return Object.freeze({
    siteOrigin: originUrl.origin,
    allowedHosts: Object.freeze([...input.allowedHosts]),
    candidates: Object.freeze(candidates),
  });
}

export function projectWriterLinkChoices(
  registry: SiteLinkRegistry,
): WriterLinkChoiceV1[] {
  return registry.candidates.map((candidate) =>
    WriterLinkChoiceV1Schema.parse({
      linkCandidateId: candidate.linkCandidateId,
      kind: candidate.kind,
      displayLabel: candidate.displayLabel,
    }),
  );
}

export function resolveSiteLink(
  registry: SiteLinkRegistry,
  linkCandidateId: string,
  expectedKind: "internal" | "cta",
): SiteLinkCandidateV1 {
  const candidate = registry.candidates.find(
    (entry) => entry.linkCandidateId === linkCandidateId,
  );
  if (!candidate || candidate.kind !== expectedKind) {
    throw new Error("Writer가 허용되지 않은 link candidate를 선택했습니다.");
  }
  return candidate;
}
