import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sha256Canonical } from "./canonical-json.js";
import {
  EvidenceSpanV1Schema,
  SourceDiscoveryRefV1Schema,
  SourceLedgerEntryV1Schema,
  SourceSnapshotV1Schema,
  type EvidenceSpanV1,
  type ProviderMode,
  type SourceDiscoveryRefV1,
  type SourceLedgerEntryV1,
  type SourceSnapshotV1,
} from "./content-domain.js";
import type { FetchedSourcePage } from "./source-fetch.js";
import { z } from "zod";

const SourceHostRuleSchema = z.strictObject({
  hostname: z.string().min(1).transform((value) => value.toLowerCase()),
  publisher: z.string().min(1),
  tier: z.enum(["A", "B", "C"]),
});

export const SourceHostPolicyV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    policyId: z.string().min(1),
    rules: z.array(SourceHostRuleSchema).min(1),
  })
  .superRefine((policy, context) => {
    const hostnames = policy.rules.map((rule) => rule.hostname);
    if (new Set(hostnames).size !== hostnames.length) {
      context.addIssue({
        code: "custom",
        path: ["rules"],
        message: "Source host rule hostname은 고유해야 합니다.",
      });
    }
    const sorted = [...hostnames].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    if (sorted.some((hostname, index) => hostname !== hostnames[index])) {
      context.addIssue({
        code: "custom",
        path: ["rules"],
        message: "Source host rules는 hostname ASCII 순서여야 합니다.",
      });
    }
  });

export type SourceHostPolicyV1 = z.infer<typeof SourceHostPolicyV1Schema>;

export interface SourceAdmissionOptions {
  discovery: SourceDiscoveryRefV1;
  fetched: FetchedSourcePage;
  policy: SourceHostPolicyV1;
  sourceIdFactory?: () => string;
  evidenceSpanIdFactory?: () => string;
}

export async function loadSourceHostPolicy(
  policyUrl: URL = new URL(
    "../config/source-host-policy-v1.json",
    import.meta.url,
  ),
): Promise<SourceHostPolicyV1> {
  const raw = await readFile(policyUrl, "utf8");
  return SourceHostPolicyV1Schema.parse(JSON.parse(raw));
}

export function sourceHostRule(
  policyInput: SourceHostPolicyV1,
  hostnameInput: string,
): SourceHostPolicyV1["rules"][number] | null {
  const policy = SourceHostPolicyV1Schema.parse(policyInput);
  const hostname = hostnameInput.toLowerCase();
  return policy.rules.find((rule) => rule.hostname === hostname) ?? null;
}

export function isAllowedSourceHost(
  policy: SourceHostPolicyV1,
  hostname: string,
): boolean {
  return sourceHostRule(policy, hostname) !== null;
}

function fullBlockSpan(
  fetched: FetchedSourcePage,
  block: FetchedSourcePage["blocks"][number],
  evidenceSpanIdFactory: () => string,
): EvidenceSpanV1 {
  const startUtf8Byte = 0;
  const endUtf8Byte = Buffer.byteLength(block.text, "utf8");
  const excerpt = block.text;
  const payloadSha256 = sha256Canonical({
    fetchResultSha256: fetched.resultSha256,
    blockId: block.blockId,
    startUtf8Byte,
    endUtf8Byte,
    excerpt,
  });
  return EvidenceSpanV1Schema.parse({
    evidenceSpanId: evidenceSpanIdFactory(),
    fetchToolCallId: fetched.fetchToolCallId,
    fetchResultSha256: fetched.resultSha256,
    blockId: block.blockId,
    startUtf8Byte,
    endUtf8Byte,
    locator: block.domPath,
    excerpt,
    retrievedAt: fetched.retrievedAt,
    payloadSha256,
  });
}

export function evidenceSpanMatchesBlock(
  spanInput: EvidenceSpanV1,
  fetched: FetchedSourcePage,
): boolean {
  const span = EvidenceSpanV1Schema.parse(spanInput);
  if (
    span.fetchResultSha256 !== fetched.resultSha256 ||
    span.fetchToolCallId !== fetched.fetchToolCallId
  ) {
    return false;
  }
  const block = fetched.blocks.find((candidate) => candidate.blockId === span.blockId);
  if (!block || block.domPath !== span.locator) {
    return false;
  }
  const bytes = Buffer.from(block.text, "utf8");
  if (span.endUtf8Byte > bytes.byteLength || span.startUtf8Byte >= span.endUtf8Byte) {
    return false;
  }
  let excerpt: string;
  try {
    excerpt = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(span.startUtf8Byte, span.endUtf8Byte),
    );
  } catch {
    return false;
  }
  return (
    excerpt === span.excerpt &&
    span.payloadSha256 ===
      sha256Canonical({
        fetchResultSha256: fetched.resultSha256,
        blockId: span.blockId,
        startUtf8Byte: span.startUtf8Byte,
        endUtf8Byte: span.endUtf8Byte,
        excerpt: span.excerpt,
      })
  );
}

function excluded(
  discovery: SourceDiscoveryRefV1,
  reasonCode: string,
): SourceLedgerEntryV1 {
  return SourceLedgerEntryV1Schema.parse({
    status: "excluded",
    candidateUrl: discovery.candidateUrl,
    reasonCode,
    webSearchCallId: discovery.webSearchCallId,
  });
}

export function admitSourceSnapshot(
  options: SourceAdmissionOptions,
): SourceLedgerEntryV1 {
  const discovery = SourceDiscoveryRefV1Schema.parse(options.discovery);
  const finalUrl = new URL(options.fetched.finalUrl);
  const rule = sourceHostRule(options.policy, finalUrl.hostname);
  if (!rule) {
    return excluded(discovery, "unknown_host");
  }
  if (
    options.fetched.discovery.candidateUrl !== discovery.candidateUrl ||
    options.fetched.blocks.length === 0
  ) {
    return excluded(discovery, "fetch_contract_mismatch");
  }
  const titleBlock =
    options.fetched.blocks.find((block) => block.tag === "title") ??
    options.fetched.blocks.find((block) => block.tag === "h1");
  if (!titleBlock) {
    return excluded(discovery, "title_missing");
  }

  const sourceIdFactory =
    options.sourceIdFactory ?? (() => `source_${randomUUID()}`);
  const evidenceSpanIdFactory =
    options.evidenceSpanIdFactory ?? (() => `span_${randomUUID()}`);
  const spans = options.fetched.blocks
    .map((block) => fullBlockSpan(options.fetched, block, evidenceSpanIdFactory))
    .sort((left, right) =>
      left.evidenceSpanId.localeCompare(right.evidenceSpanId, "en"),
    );
  if (spans.some((span) => !evidenceSpanMatchesBlock(span, options.fetched))) {
    return excluded(discovery, "evidence_span_mismatch");
  }
  const spanIds = spans.map((span) => span.evidenceSpanId);
  const spanPayloads = spans.map((span) => span.payloadSha256);
  if (
    new Set(spanIds).size !== spanIds.length ||
    new Set(spanPayloads).size !== spanPayloads.length
  ) {
    return excluded(discovery, "duplicate_evidence_span");
  }
  finalUrl.hash = "";
  const canonicalUrl = finalUrl.href;
  const snapshotIdentity = {
    schemaVersion: "1.0",
    webSearchCallId: discovery.webSearchCallId,
    sourceFetchCallId: options.fetched.fetchToolCallId,
    fetchResultSha256: options.fetched.resultSha256,
    canonicalUrl,
    title: titleBlock.text,
    publisher: rule.publisher,
    tier: rule.tier,
    publishedAt: null,
    validAt: null,
    retrievedAt: options.fetched.retrievedAt,
    spans,
  };
  const snapshot: SourceSnapshotV1 = SourceSnapshotV1Schema.parse({
    sourceId: sourceIdFactory(),
    canonicalUrl,
    title: titleBlock.text,
    publisher: rule.publisher,
    tier: rule.tier,
    publishedAt: null,
    retrievedAt: options.fetched.retrievedAt,
    spans,
    snapshotSha256: sha256Canonical(snapshotIdentity),
    provenanceMode: options.fetched.provenanceMode as ProviderMode,
  });
  return SourceLedgerEntryV1Schema.parse({ status: "admitted", snapshot });
}
