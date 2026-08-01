import { Agent, run, webSearchTool } from "@openai/agents";
import { z } from "zod";

import { ArticleDraftV1Schema, type ContentBriefV1 } from "./content-domain.js";
import { sha256Canonical } from "./canonical-json.js";
import {
  KeywordSelectionSchema,
  validateKeywordSelection,
  type KeywordSelection,
  type KeywordSelectorInput,
} from "./keyword-selector.js";
import type {
  ArticleDraftProvider,
  ArticleDraftProviderContext,
  ArticleDraftProviderRequestV1,
} from "./article-agent.js";
import {
  ClaimDraftV1Schema,
  type ClaimDraftV1,
} from "./claim-ledger.js";
import type { ClaimExtractionPort } from "./evidence-agent.js";
import {
  dedupeDiscoveryRefs,
  projectHostedWebSearchSources,
  type WebDiscoveryPort,
} from "./web-search-discovery.js";

type RawEventSink = (event: unknown) => void | number | Promise<void | number>;

const ClaimExtractionOutputSchema = z.strictObject({
  claims: z.array(ClaimDraftV1Schema).min(1).max(12),
});

function modelName(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
}

function rawHostedSearch(item: unknown): {
  id: string;
  action: { type: "search"; sources: Array<{ type: "url"; url: string }> };
} | null {
  const json =
    typeof (item as { toJSON?: unknown })?.toJSON === "function"
      ? (item as { toJSON(): unknown }).toJSON()
      : item;
  const rawItem = (json as { rawItem?: unknown } | null)?.rawItem as
    | {
        type?: unknown;
        name?: unknown;
        id?: unknown;
        providerData?: { action?: unknown };
      }
    | undefined;
  if (
    rawItem?.type !== "hosted_tool_call" ||
    rawItem.name !== "web_search_call" ||
    typeof rawItem.id !== "string"
  ) {
    return null;
  }
  const action = rawItem.providerData?.action as {
    type?: unknown;
    sources?: unknown;
  } | undefined;
  if (action?.type !== "search" || !Array.isArray(action.sources)) return null;
  const sources = action.sources.flatMap((source) => {
    const value = source as { type?: unknown; url?: unknown };
    return value.type === "url" && typeof value.url === "string"
      ? [{ type: "url" as const, url: value.url }]
      : [];
  });
  return { id: rawItem.id, action: { type: "search", sources } };
}

export class OpenAiWebDiscoveryPort implements WebDiscoveryPort {
  constructor(
    private readonly options: {
      allowedDomains: string[];
      onRawEvent?: RawEventSink;
      signal?: AbortSignal;
    },
  ) {}

  async discover(brief: ContentBriefV1, attempt: 1 | 2) {
    const searchTool = webSearchTool({
      searchContextSize: "low",
      externalWebAccess: true,
      filters: { allowedDomains: this.options.allowedDomains },
    });
    const agent = new Agent({
      name: "Official travel source discovery",
      model: modelName(),
      modelSettings: { parallelToolCalls: false },
      tools: [searchTool],
      instructions: [
        "Use the hosted web search tool exactly once.",
        "Find current official government, tourism-board, transport, or facility pages for the supplied Korean travel content brief.",
        "Do not use X, Google Trends, blogs, forums, aggregators, or search snippets as factual evidence.",
        "The application will read only typed tool action.sources URLs; keep the final answer minimal.",
      ].join("\n"),
    });
    const result = await run(
      agent,
      JSON.stringify({ attempt, brief }),
      { stream: true, maxTurns: 3, signal: this.options.signal },
    );
    const calls: Array<{ seq: number; call: NonNullable<ReturnType<typeof rawHostedSearch>> }> = [];
    let fallbackSeq = 0;
    for await (const event of result) {
      fallbackSeq += 1;
      const acceptedSeq = await this.options.onRawEvent?.(event);
      const rawEventSeq = acceptedSeq ?? fallbackSeq;
      if (event.type === "run_item_stream_event") {
        const call = rawHostedSearch(event.item);
        if (call) calls.push({ seq: rawEventSeq, call });
      }
    }
    await result.completed;
    if (result.error) throw result.error;
    return dedupeDiscoveryRefs(
      calls.flatMap(({ seq: rawEventSeq, call }) => {
        const projection = {
          type: "web_search_call" as const,
          id: call.id,
          status: "completed" as const,
          action: call.action,
        };
        return projectHostedWebSearchSources(projection, {
          rawEventSeq,
          semanticPayloadSha256: sha256Canonical(projection),
        });
      }),
    );
  }
}

export class OpenAiArticleDraftProvider implements ArticleDraftProvider {
  async generate(
    request: ArticleDraftProviderRequestV1,
    context: ArticleDraftProviderContext,
  ): Promise<unknown> {
    const agent = new Agent({
      name: request.mode === "initial" ? "Grounded article writer" : "Grounded article repair writer",
      model: modelName(),
      modelSettings: { parallelToolCalls: false },
      outputType: ArticleDraftV1Schema,
      instructions: [
        "Return only the strict ArticleDraftV1 structured output.",
        "Use only the supplied accepted/qualified claim text. Never add facts from memory.",
        "Every title, meta, heading, paragraph, list item, FAQ question and answer must reference exactly one supplied claimId.",
        "Do not output URLs, HTML, Markdown links, CSS, scripts, images, tables, JSON-LD, publication status, or placeholders.",
        "The first block is one intro. Include at least one H2 section. H3 may only follow an H2. CTA is optional and last.",
        "Use Korean reader-first prose in the persona tone. slug must be ASCII lowercase kebab-case. metaDescription should be 50-160 Korean characters.",
        request.mode === "repair"
          ? "Repair only editableUnitIds and preserve every ID, claimId, block shape and metadata exactly."
          : "Create fresh lower-case UUIDv4 articleId and short deterministic unit/block/pair identifiers.",
      ].join("\n"),
    });
    const result = await run(agent, JSON.stringify(request), {
      stream: true,
      maxTurns: 2,
      signal: context.signal,
    });
    for await (const event of result) {
      await context.onRawEvent?.(event);
    }
    await result.completed;
    if (result.error) throw result.error;
    return ArticleDraftV1Schema.parse(result.finalOutput);
  }
}

export class OpenAiClaimExtractionPort implements ClaimExtractionPort {
  constructor(
    private readonly options: {
      onRawEvent?: RawEventSink;
      signal?: AbortSignal;
    } = {},
  ) {}

  async extract(input: Parameters<ClaimExtractionPort["extract"]>[0]): Promise<ClaimDraftV1[]> {
    if (input.admittedSources.length === 0) return [];
    const agent = new Agent({
      name: "Evidence claim ledger extractor",
      model: modelName(),
      modelSettings: { parallelToolCalls: false },
      outputType: ClaimExtractionOutputSchema,
      instructions: [
        "Create atomic Korean factual claims using only the supplied admitted source spans.",
        "Every claim must cite one or more exact sourceId/evidenceSpanId pairs that directly support its text.",
        "Return at least one core claim supported by a tier A source. Do not infer from titles alone or add model-memory facts.",
        "Use stable/none unless a span contains an exact YYYY-MM-DD date needed for a high-volatility entry, safety, or health claim.",
        "For risk claims set qualification and validAt to the exact date literal present in the cited excerpt; otherwise omit risky claims.",
        "Generate lower-case claim_ identifiers that are unique within this output.",
      ].join("\n"),
    });
    const result = await run(agent, JSON.stringify(input), {
      stream: true,
      maxTurns: 1,
      signal: this.options.signal,
    });
    for await (const event of result) await this.options.onRawEvent?.(event);
    await result.completed;
    if (result.error) throw result.error;
    return ClaimExtractionOutputSchema.parse(result.finalOutput).claims;
  }
}

export async function selectKeywordsWithOpenAi(
  input: KeywordSelectorInput,
  options: { signal?: AbortSignal; onRawEvent?: RawEventSink } = {},
): Promise<KeywordSelection> {
  const agent = new Agent({
    name: "Travel keyword selector",
    model: modelName(),
    modelSettings: { parallelToolCalls: false },
    outputType: KeywordSelectionSchema,
    instructions: [
      "Choose exactly one target candidate and 3-4 distinct secondary candidates from the supplied IDs.",
      "Never change, recompute, normalize, or invent scores and candidates.",
      "In google_scored mode target must be one of the complete candidates shown first. In degraded mode respect X rank and semantic cohesion.",
      "Return semanticCohesion coherent, an appropriate closed articleIntent and no numeric score fields.",
    ].join("\n"),
  });
  const result = await run(agent, JSON.stringify(input), {
    stream: true,
    maxTurns: 1,
    signal: options.signal,
  });
  for await (const event of result) await options.onRawEvent?.(event);
  await result.completed;
  if (result.error) throw result.error;
  return validateKeywordSelection(
    KeywordSelectionSchema.parse(result.finalOutput),
    input,
  );
}

export function evidenceSearchPrompt(brief: ContentBriefV1): string {
  return z.string().parse(
    `${brief.primaryKeyword}: ${brief.secondaryKeywords.join(", ")}`,
  );
}
