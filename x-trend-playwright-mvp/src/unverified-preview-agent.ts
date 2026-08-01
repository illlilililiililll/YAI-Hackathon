import { Agent, run } from "@openai/agents";
import { z } from "zod";

import {
  CommercialContextV1Schema,
  type CommercialContextV1,
} from "./commercial-context.js";
import {
  ContentBriefV1Schema,
  PersonaSnapshotV1Schema,
  type ContentBriefV1,
  type PersonaSnapshotV1,
} from "./content-domain.js";

const PreviewTextSchema = z.string().trim().min(1).max(600);

export const UnverifiedPreviewSectionV1Schema = z.strictObject({
  heading: z.string().trim().min(1).max(80),
  body: PreviewTextSchema,
});

export const UnverifiedPreviewDraftV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  personaSnapshotId: z.string().regex(/^persona_[0-9a-f]{24}$/u),
  title: z.string().trim().min(1).max(100),
  metaDescription: z.string().trim().min(50).max(180),
  intro: PreviewTextSchema,
  sections: z.array(UnverifiedPreviewSectionV1Schema).min(2).max(4),
  ctaSupportingCopy: z.string().trim().min(1).max(240),
});

export type UnverifiedPreviewDraftV1 = z.infer<typeof UnverifiedPreviewDraftV1Schema>;

export type UnverifiedPreviewWriterInput = Readonly<{
  brief: ContentBriefV1;
  commercialContext: CommercialContextV1;
  persona: PersonaSnapshotV1;
}>;

export type UnverifiedPreviewProviderRequest = Readonly<{
  mode: "initial" | "repair";
  input: UnverifiedPreviewWriterInput;
  previousDraft?: unknown;
  failureCodes?: readonly string[];
}>;

export type UnverifiedPreviewProviderContext = Readonly<{
  signal?: AbortSignal;
  onRawEvent?: (event: unknown) => void | Promise<void>;
}>;

export interface UnverifiedPreviewDraftProvider {
  generate(
    request: UnverifiedPreviewProviderRequest,
    context: UnverifiedPreviewProviderContext,
  ): Promise<unknown>;
}

const URL_OR_MARKUP =
  /(?:https?:\/\/|www\.|<\/?[a-z][^>]*>|\[[^\]]+\]\([^)]+\)|javascript:|data:text\/html)/iu;
const PRICE_OR_DATE =
  /(?:\d[\d,.]*\s*(?:원|유로|달러|퍼센트|%)|\b20\d{2}[-./년]\s*\d{1,2}|\d{1,2}\s*(?:월|박\s*\d*\s*일))/iu;
const PROHIBITED_FACT =
  /(?:가격|할인|특가|무료|예약\s*가능|출발\s*확정|비자|입국|여권|치안|안전|질병|건강|예방접종|운영\s*시간|영업\s*시간|항공편|검색량|급상승|인기|랭킹|(?<!우선)순위|\d+\s*위|최고|최저|유일|보장|무조건|확실히|성공률|판매량|수상|인증|자격|경력|실적)/iu;
const UNSUPPORTED_GENERALIZATION =
  /(?:다녀온\s*사람|사람들은\s*(?:보통|대체로)|일반적으로|대체로|도시마다\s*(?:분위기|특징)|도움이\s*될\s*수\s*있|여행의\s*흐름을\s*정|일정의\s*밀도가\s*중요)/iu;
const HARD_SELL_OR_CASUAL_STYLE =
  /(?:지금\s*결정|당장|서두르|놓치기|마감\s*임박|기회는\s*지금|필수입니다|해!|하세요!|됩니다!)/iu;

function validatePersonaStyle(draft: UnverifiedPreviewDraftV1): void {
  const prose = [
    draft.metaDescription,
    draft.intro,
    ...draft.sections.map((section) => section.body),
    draft.ctaSupportingCopy,
  ];
  if (draftTexts(draft).some((value) => HARD_SELL_OR_CASUAL_STYLE.test(value))) {
    throw new Error("preview_persona_hard_sell_forbidden");
  }
  for (const value of prose) {
    const sentences = value.split(/(?<=[.!?])\s+/u);
    if (
      sentences.some(
        (sentence) =>
          !/(?:니다|세요|까요|습니까|겠습니까)[.!?]$/u.test(sentence.trim()),
      )
    ) {
      throw new Error("preview_persona_polite_style_required");
    }
  }
  const firstIntroSentence = draft.intro.split(/(?<=[.!?])\s+/u)[0] ?? "";
  if (!/(?:먼저|됩니다|보시면|정리|고르|확인)/u.test(firstIntroSentence)) {
    throw new Error("preview_persona_answer_first_required");
  }
  if (
    draft.sections.some(
      (section) =>
        !/(?:\?|까요|습니까|겠습니까)$/u.test(section.heading.trim()) &&
        !/(?:방법|기준|준비|선택|확인|정리|살펴|시작|보세요)/u.test(section.heading),
    )
  ) {
    throw new Error("preview_persona_heading_order_required");
  }
}

function draftTexts(draft: UnverifiedPreviewDraftV1): string[] {
  return [
    draft.title,
    draft.metaDescription,
    draft.intro,
    ...draft.sections.flatMap((section) => [section.heading, section.body]),
    draft.ctaSupportingCopy,
  ];
}

export function validateUnverifiedPreviewDraft(
  draftValue: unknown,
  inputValue: UnverifiedPreviewWriterInput,
): UnverifiedPreviewDraftV1 {
  const brief = ContentBriefV1Schema.parse(inputValue.brief);
  CommercialContextV1Schema.parse(inputValue.commercialContext);
  const persona = PersonaSnapshotV1Schema.parse(inputValue.persona);
  const draft = UnverifiedPreviewDraftV1Schema.parse(draftValue);
  if (draft.personaSnapshotId !== persona.snapshotId) {
    throw new Error("preview_persona_snapshot_mismatch");
  }
  if (!draft.title.normalize("NFC").startsWith(brief.primaryKeyword.normalize("NFC"))) {
    throw new Error("preview_title_primary_keyword_missing");
  }
  for (const text of draftTexts(draft)) {
    if (URL_OR_MARKUP.test(text)) throw new Error("preview_url_or_markup_forbidden");
    if (PRICE_OR_DATE.test(text)) throw new Error("preview_price_or_date_forbidden");
    if (PROHIBITED_FACT.test(text)) throw new Error("preview_external_fact_forbidden");
    if (UNSUPPORTED_GENERALIZATION.test(text)) {
      throw new Error("preview_unsupported_generalization_forbidden");
    }
  }
  validatePersonaStyle(draft);
  return draft;
}

function modelName(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
}

export class OpenAiUnverifiedPreviewDraftProvider
  implements UnverifiedPreviewDraftProvider
{
  async generate(
    request: UnverifiedPreviewProviderRequest,
    context: UnverifiedPreviewProviderContext,
  ): Promise<unknown> {
    const agent = new Agent({
      name:
        request.mode === "initial"
          ? "Unverified commercial travel preview writer"
          : "Unverified commercial travel preview repair writer",
      model: modelName(),
      modelSettings: { parallelToolCalls: false },
      outputType: UnverifiedPreviewDraftV1Schema,
      instructions: [
        "Return only the strict UnverifiedPreviewDraftV1 structured output in Korean.",
        "Apply the supplied immutable PersonaSnapshot. Copy its exact snapshotId into personaSnapshotId; never invent or modify the identity.",
        "This is an explicitly unverified local sales preview. The human has authorized omitting only the Persona policy's Claim linkage and accepted/qualified Claim checks for this preview.",
        "Keep the rest of Persona 1.3.0: safety first, answer the reader directly, then apply brand voice, then offer a restrained next action.",
        "Use the Persona tone and voiceTags. Write calm, concrete, short Korean sentences in 합니다 style. Avoid translated phrasing, hype, fear, pressure, and keyword stuffing.",
        "Use only the supplied campaign context and selected keyword labels. Write audience-oriented editorial framing and questions, not external factual claims or product features that were not supplied.",
        "Section bodies must use reader-directed questions, instructions, and choices. Do not state what Europe, destinations, travelers, past visitors, or products are generally like or what people usually do.",
        "Begin the title with the exact primaryKeyword. The intro must answer first. Organize section headings in the reader's question or action order, and make each section's first sentence answer its heading directly.",
        "Never state or imply prices, discounts, dates, schedules, availability, entry/visa, safety/health, rankings, popularity, search volume, awards, credentials, results, or guarantees.",
        "Never mention X, Google Trends, trend scores, sources, verification, or evidence in the article copy.",
        "Do not output URLs, HTML, Markdown, scripts, images, tables, placeholders, or a clickable CTA.",
        "The renderer owns the warning banners, preview-only image asset, and disabled CTA label. The Writer must not create or describe an image.",
        request.mode === "repair"
          ? "The previous output was rejected. Regenerate the complete object and address every supplied failure code without adding new claims."
          : "Create two to four short sections and restrained, non-guaranteeing CTA supporting copy.",
      ].join("\n"),
    });
    const stream = await run(agent, JSON.stringify(request), {
      stream: true,
      maxTurns: 1,
      signal: context.signal,
    });
    for await (const event of stream) await context.onRawEvent?.(event);
    await stream.completed;
    if (stream.error) throw stream.error;
    return UnverifiedPreviewDraftV1Schema.parse(stream.finalOutput);
  }
}

export async function writeUnverifiedPreviewDraft(
  provider: UnverifiedPreviewDraftProvider,
  inputValue: UnverifiedPreviewWriterInput,
  context: UnverifiedPreviewProviderContext = {},
): Promise<UnverifiedPreviewDraftV1> {
  const input: UnverifiedPreviewWriterInput = Object.freeze({
    brief: ContentBriefV1Schema.parse(inputValue.brief),
    commercialContext: CommercialContextV1Schema.parse(inputValue.commercialContext),
    persona: PersonaSnapshotV1Schema.parse(inputValue.persona),
  });
  let previousDraft: unknown;
  let failureCodes: string[] = [];
  for (const mode of ["initial", "repair"] as const) {
    try {
      previousDraft = await provider.generate(
        {
          mode,
          input,
          ...(mode === "repair" ? { previousDraft, failureCodes } : {}),
        },
        context,
      );
      return validateUnverifiedPreviewDraft(previousDraft, input);
    } catch (error) {
      failureCodes = [error instanceof Error ? error.message : "preview_writer_invalid_output"];
      if (mode === "repair") {
        throw new Error(
          `unverified_preview_writer_repair_exhausted:${failureCodes.join(",")}`,
        );
      }
    }
  }
  throw new Error("unverified_preview_writer_repair_exhausted");
}
