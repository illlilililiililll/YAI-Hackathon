import { z } from "zod";

import {
  ContentBriefV1Schema,
  SourceDiscoveryRefV1Schema,
  type ContentBriefV1,
  type SourceDiscoveryRefV1,
} from "./content-domain.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

// Deliberately excludes hosted result text. Only the typed action.sources
// projection is allowed to cross the discovery boundary.
const HostedWebSearchCallSchema = z.object({
  type: z.literal("web_search_call"),
  id: z.string().min(1),
  status: z.literal("completed"),
  action: z.object({
    type: z.literal("search"),
    sources: z
      .array(
        z.strictObject({
          type: z.literal("url"),
          url: z.url(),
        }),
      )
      .default([]),
  }),
});

export type HostedWebSearchCallProjection = z.infer<
  typeof HostedWebSearchCallSchema
>;

export interface DiscoveryProjectionMetadata {
  rawEventSeq: number;
  semanticPayloadSha256: string;
}

export interface WebDiscoveryPort {
  discover(
    brief: ContentBriefV1,
    attempt: 1 | 2,
  ): Promise<SourceDiscoveryRefV1[]>;
}

function canonicalDiscoveryUrl(input: string): string {
  const url = new URL(input);
  return url.href;
}

/**
 * Projects only action.sources from one completed hosted web-search call.
 * Unknown fields (including resultsPayload and model-written text) are ignored.
 */
export function projectHostedWebSearchSources(
  input: unknown,
  metadataInput: DiscoveryProjectionMetadata,
): SourceDiscoveryRefV1[] {
  const call = HostedWebSearchCallSchema.parse(input);
  const metadata = z
    .strictObject({
      rawEventSeq: z.number().int().positive(),
      semanticPayloadSha256: Sha256Schema,
    })
    .parse(metadataInput);

  const seen = new Set<string>();
  const refs: SourceDiscoveryRefV1[] = [];
  for (const source of call.action.sources) {
    const candidateUrl = canonicalDiscoveryUrl(source.url);
    if (seen.has(candidateUrl)) {
      continue;
    }
    seen.add(candidateUrl);
    refs.push(
      SourceDiscoveryRefV1Schema.parse({
        webSearchCallId: call.id,
        rawEventSeq: metadata.rawEventSeq,
        semanticPayloadSha256: metadata.semanticPayloadSha256,
        candidateUrl,
      }),
    );
  }
  return refs;
}

export function validateDiscoveryPortInput(brief: ContentBriefV1): ContentBriefV1 {
  return ContentBriefV1Schema.parse(brief);
}

export function dedupeDiscoveryRefs(
  refsInput: readonly SourceDiscoveryRefV1[],
): SourceDiscoveryRefV1[] {
  const seen = new Set<string>();
  const refs: SourceDiscoveryRefV1[] = [];
  for (const input of refsInput) {
    const ref = SourceDiscoveryRefV1Schema.parse(input);
    const candidateUrl = canonicalDiscoveryUrl(ref.candidateUrl);
    if (seen.has(candidateUrl)) {
      continue;
    }
    seen.add(candidateUrl);
    refs.push(
      SourceDiscoveryRefV1Schema.parse({ ...ref, candidateUrl }),
    );
  }
  return refs;
}
