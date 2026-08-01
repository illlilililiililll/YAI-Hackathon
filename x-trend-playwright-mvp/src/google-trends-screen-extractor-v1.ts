import { z } from "zod";

import {
  GoogleCandidateSchema,
  type GoogleCandidate,
  type GoogleRelatedQueryCapture,
  type GoogleRelatedQueryRow,
  type GoogleRelatedTopicCapture,
  type GoogleRelatedTopicRow,
  type GoogleUnavailableCode,
} from "./content-domain.js";
import type { PartialBoundary } from "./google-csv-parser-v1.js";

const RawScreenRowSchema = z.strictObject({
  label: z.string(),
  displayedValue: z.string(),
  secondaryText: z.string().nullable(),
});

const RawScreenCardSchema = z.strictObject({
  candidateLabel: z.string().nullable(),
  kind: z.enum(["related_queries", "related_topics"]),
  mode: z.enum(["top", "rising"]),
  heading: z.string(),
  rows: z.array(RawScreenRowSchema),
});

export const GoogleRenderedScreenSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  pageUrl: z.url(),
  pageTitle: z.string(),
  bodyState: z.enum([
    "ready",
    "consent_required",
    "auth_required",
    "challenge_or_blocked",
    "rate_limited",
  ]),
  partialBoundary: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("none") }),
    z.strictObject({
      state: z.literal("from"),
      timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/u),
    }),
    z.strictObject({ state: z.literal("unavailable") }),
  ]),
  cards: z.array(RawScreenCardSchema),
});

export type GoogleRenderedScreen = z.infer<typeof GoogleRenderedScreenSchema>;

export type GoogleRenderedCandidateCaptures = {
  candidateId: string;
  relatedQueries: {
    top: GoogleRelatedQueryCapture;
    rising: GoogleRelatedQueryCapture;
  };
  relatedTopics: {
    top: GoogleRelatedTopicCapture;
    rising: GoogleRelatedTopicCapture;
  };
};

function resultPayload(text: string): string {
  const marker = "### Result\n";
  const start = text.indexOf(marker);
  if (start < 0) {
    throw new Error("Playwright MCP 결과에서 Google extraction JSON을 찾지 못했습니다.");
  }
  const payloadStart = start + marker.length;
  const nextSection = text.indexOf("\n### ", payloadStart);
  return text.slice(payloadStart, nextSection < 0 ? undefined : nextSection);
}

export function parseGoogleRenderedScreen(text: string): GoogleRenderedScreen {
  return GoogleRenderedScreenSchema.parse(JSON.parse(resultPayload(text)));
}

function bodyUnavailableCode(
  state: GoogleRenderedScreen["bodyState"],
): GoogleUnavailableCode | null {
  return state === "ready" ? null : state;
}

function unavailable<T extends GoogleRelatedQueryCapture | GoogleRelatedTopicCapture>(
  reasonCode: GoogleUnavailableCode,
): T {
  return { state: "unavailable", value: null, reasonCode } as T;
}

function parsePercentBasisPoints(value: string): number | null {
  const match = /^\+?((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?%$/u.exec(
    value.trim(),
  );
  if (!match?.[1]) {
    return null;
  }
  const whole = Number(match[1].replaceAll(",", ""));
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (!Number.isSafeInteger(whole)) {
    return null;
  }
  return whole * 100 + Number(fraction || "0");
}

function queryRows(
  card: z.infer<typeof RawScreenCardSchema>,
): GoogleRelatedQueryRow[] {
  return card.rows.map((row, index) => {
    const valueText = row.displayedValue.trim();
    const percentBasisPoints = parsePercentBasisPoints(valueText);
    return {
      label: row.label.trim(),
      rank: index + 1,
      displayedValue: row.displayedValue,
      risingValue:
        card.mode !== "rising"
          ? null
          : /^breakout$/iu.test(valueText)
            ? {
                kind: "breakout" as const,
                lowerBoundExclusivePercent: 5000 as const,
                rawText: "Breakout" as const,
              }
            : percentBasisPoints === null
              ? null
              : {
                  kind: "percent" as const,
                  percentBasisPoints,
                  rawText: row.displayedValue,
                },
    };
  });
}

function topicRows(
  card: z.infer<typeof RawScreenCardSchema>,
): GoogleRelatedTopicRow[] {
  return card.rows.map((row, index) => ({
    label: row.label.trim(),
    topicType: row.secondaryText?.trim() || null,
    rank: index + 1,
    displayedValue: row.displayedValue,
  }));
}

function exactCard(
  screen: GoogleRenderedScreen,
  candidate: GoogleCandidate,
  kind: "related_queries" | "related_topics",
  mode: "top" | "rising",
): z.infer<typeof RawScreenCardSchema> | null {
  const matches = screen.cards.filter(
    (card) =>
      card.kind === kind &&
      card.mode === mode &&
      card.candidateLabel === candidate.label,
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function extractGoogleRenderedCaptures(
  screenInput: GoogleRenderedScreen,
  candidatesInput: GoogleCandidate[],
): {
  captures: GoogleRenderedCandidateCaptures[];
  partialBoundary: PartialBoundary;
} {
  const screen = GoogleRenderedScreenSchema.parse(screenInput);
  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  const blockedReason = bodyUnavailableCode(screen.bodyState);

  const captures = candidates.map((candidate) => {
    const queryTop = exactCard(screen, candidate, "related_queries", "top");
    const queryRising = exactCard(
      screen,
      candidate,
      "related_queries",
      "rising",
    );
    const topicTop = exactCard(screen, candidate, "related_topics", "top");
    const topicRising = exactCard(
      screen,
      candidate,
      "related_topics",
      "rising",
    );

    return {
      candidateId: candidate.candidateId,
      relatedQueries: {
        top: blockedReason
          ? unavailable<GoogleRelatedQueryCapture>(blockedReason)
          : queryTop
            ? { state: "available" as const, value: queryRows(queryTop) }
            : unavailable<GoogleRelatedQueryCapture>("schema_changed"),
        rising: blockedReason
          ? unavailable<GoogleRelatedQueryCapture>(blockedReason)
          : queryRising
            ? { state: "available" as const, value: queryRows(queryRising) }
            : unavailable<GoogleRelatedQueryCapture>("schema_changed"),
      },
      relatedTopics: {
        top: blockedReason
          ? unavailable<GoogleRelatedTopicCapture>(blockedReason)
          : topicTop
            ? { state: "available" as const, value: topicRows(topicTop) }
            : unavailable<GoogleRelatedTopicCapture>("schema_changed"),
        rising: blockedReason
          ? unavailable<GoogleRelatedTopicCapture>(blockedReason)
          : topicRising
            ? { state: "available" as const, value: topicRows(topicRising) }
            : unavailable<GoogleRelatedTopicCapture>("schema_changed"),
      },
    };
  });

  return { captures, partialBoundary: screen.partialBoundary };
}

export function findInterestDownloadTarget(snapshotText: string): string | null {
  const lines = snapshotText.split("\n");
  const interestIndexes = lines
    .map((line, index) => (/interest over time/iu.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const refs = new Set<string>();
  for (const index of interestIndexes) {
    for (let cursor = index; cursor < Math.min(lines.length, index + 40); cursor += 1) {
      const line = lines[cursor] ?? "";
      if (
        cursor > index &&
        /(?:^|\s)-\s+(?:heading|region)\b/iu.test(line) &&
        !/interest over time/iu.test(line)
      ) {
        break;
      }
      if (!/download|export.*csv/iu.test(line)) {
        continue;
      }
      const match = /\[ref=([^\]]+)\]/u.exec(line);
      if (match?.[1]) {
        refs.add(match[1]);
      }
    }
  }
  return refs.size === 1 ? [...refs][0] ?? null : null;
}

export type GoogleCardModeTarget = {
  mode: "top" | "rising";
  ref: string;
};

/**
 * Finds only explicit Top/Rising controls from an accessibility snapshot.
 * The capture layer owns cardinality: an unexpected count is schema drift,
 * never permission to guess which control belongs to a card.
 */
export function findGoogleCardModeTargets(
  snapshotText: string,
  mode: "top" | "rising",
): GoogleCardModeTarget[] {
  const pattern = mode === "top" ? /\btop\b/iu : /\brising\b/iu;
  const refs = new Set<string>();
  for (const line of snapshotText.split("\n")) {
    if (
      !pattern.test(line) ||
      !/(?:button|option|menuitem|tab|combobox)/iu.test(line)
    ) {
      continue;
    }
    const match = /\[ref=([^\]]+)\]/u.exec(line);
    if (match?.[1]) {
      refs.add(match[1]);
    }
  }
  return [...refs].map((ref) => ({ mode, ref }));
}

export function missingGoogleCardModes(
  screenInput: GoogleRenderedScreen,
  candidatesInput: GoogleCandidate[],
): Array<{
  candidateId: string;
  candidateLabel: string;
  kind: "related_queries" | "related_topics";
  mode: "top" | "rising";
}> {
  const screen = GoogleRenderedScreenSchema.parse(screenInput);
  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  return candidates.flatMap((candidate) =>
    (["related_queries", "related_topics"] as const).flatMap((kind) =>
      (["top", "rising"] as const)
        .filter((mode) => exactCard(screen, candidate, kind, mode) === null)
        .map((mode) => ({
          candidateId: candidate.candidateId,
          candidateLabel: candidate.label,
          kind,
          mode,
        })),
    ),
  );
}

export function mergeGoogleRenderedScreens(
  screensInput: GoogleRenderedScreen[],
  candidatesInput: GoogleCandidate[],
): GoogleRenderedScreen {
  if (screensInput.length === 0) {
    throw new Error("Google Top/Rising screen이 비어 있습니다.");
  }
  const screens = screensInput.map((screen) =>
    GoogleRenderedScreenSchema.parse(screen),
  );
  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  const first = screens[0];
  if (!first) {
    throw new Error("Google Top/Rising 첫 screen이 없습니다.");
  }
  if (
    screens.some(
      (screen) =>
        screen.pageUrl !== first.pageUrl || screen.pageTitle !== first.pageTitle,
    )
  ) {
    throw new Error("Google Top/Rising screen identity가 바뀌었습니다.");
  }
  const blocking = screens.find((screen) => screen.bodyState !== "ready");
  if (blocking) {
    return blocking;
  }
  const cards = candidates.flatMap((candidate) =>
    (["related_queries", "related_topics"] as const).flatMap((kind) =>
      (["top", "rising"] as const).map((mode) => {
        const matches = screens.flatMap((screen) =>
          screen.cards.filter(
            (card) =>
              card.candidateLabel === candidate.label &&
              card.kind === kind &&
              card.mode === mode,
          ),
        );
        if (matches.length !== 1) {
          throw new Error(
            `Google selector cardinality drift: ${candidate.label}/${kind}/${mode}=${matches.length}`,
          );
        }
        return matches[0]!;
      }),
    ),
  );
  const partialBoundary = screens.every(
    (screen) =>
      JSON.stringify(screen.partialBoundary) ===
      JSON.stringify(first.partialBoundary),
  )
    ? first.partialBoundary
    : { state: "unavailable" as const };
  return GoogleRenderedScreenSchema.parse({
    ...first,
    partialBoundary,
    cards,
  });
}

export function buildGoogleRenderedScreenFunction(
  candidatesInput: GoogleCandidate[],
): string {
  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  const candidateJson = JSON.stringify(candidates.map((candidate) => candidate.label));
  return `() => {
    const candidateLabels = ${candidateJson};
    const bodyText = document.body?.innerText ?? '';
    const normalized = bodyText.toLowerCase();
    const bodyState = /before you continue|consent required|동의가 필요/.test(normalized)
      ? 'consent_required'
      : location.hostname === 'accounts.google.com' || /sign in to continue|로그인하여 계속/.test(normalized)
        ? 'auth_required'
        : /too many requests|429|rate limit/.test(normalized)
          ? 'rate_limited'
          : /captcha|verify you are human|unusual traffic|자동화된 요청/.test(normalized)
            ? 'challenge_or_blocked'
            : 'ready';

    const text = (node) => (node?.textContent ?? '').trim().replace(/\\s+/g, ' ');
    const exactCandidate = (cardText) => {
      const matches = candidateLabels.filter((label) => cardText.includes(label));
      return matches.length === 1 ? matches[0] : null;
    };
    const headings = Array.from(document.querySelectorAll(
      'h1,h2,h3,h4,[role="heading"],.title,[class*="widget-title"]'
    ));
    const cards = [];
    const seen = new Set();
    for (const headingNode of headings) {
      const heading = text(headingNode);
      const kind = /related queries/i.test(heading)
        ? 'related_queries'
        : /related topics/i.test(heading)
          ? 'related_topics'
          : null;
      if (!kind) continue;
      const card = headingNode.closest(
        'trends-widget,explore-widget,md-card,[role="region"],[class*="widget-container"],[class*="widget"]'
      ) || headingNode.parentElement;
      if (!card || seen.has(card)) continue;
      seen.add(card);
      const cardText = text(card);
      const activeControls = Array.from(card.querySelectorAll(
        '[aria-selected="true"],option:checked,[class*="select-value"],[class*="active"]'
      )).map(text).filter(Boolean);
      const selectedTop = activeControls.filter((value) => /(^|\\s)top(\\s|$)/i.test(value));
      const selectedRising = activeControls.filter((value) => /(^|\\s)rising(\\s|$)/i.test(value));
      const mode = selectedTop.length === 1 && selectedRising.length === 0
        ? 'top'
        : selectedRising.length === 1 && selectedTop.length === 0
          ? 'rising'
          : null;
      if (!mode) continue;
      const rowNodes = Array.from(card.querySelectorAll(
        '[role="row"],[class*="item-row"],[class*="feed-item"],[class*="list-item"],tr'
      ));
      const rows = rowNodes.map((row) => {
        const labels = Array.from(row.querySelectorAll(
          '[class*="label"],[class*="title"],[role="cell"]'
        )).map(text).filter(Boolean);
        const values = Array.from(row.querySelectorAll(
          '[class*="value"],[class*="percent"],[role="cell"]'
        )).map(text).filter(Boolean);
        const label = labels[0] ?? '';
        const displayedValue = values.find((value) => /breakout|%|^\\d+$/i.test(value)) ?? values.at(-1) ?? '';
        const secondaryText = kind === 'related_topics' ? (labels[1] ?? null) : null;
        return { label, displayedValue, secondaryText };
      }).filter((row) => row.label.length > 0);
      cards.push({
        candidateLabel: exactCandidate(cardText),
        kind,
        mode,
        heading,
        rows,
      });
    }

    const partialMatches = bodyText.match(/\\bpartial\\b/gi) ?? [];
    const partialBoundary = partialMatches.length === 0
      ? { state: 'none' }
      : { state: 'unavailable' };
    return {
      schemaVersion: '1.0',
      pageUrl: location.href,
      pageTitle: document.title,
      bodyState,
      partialBoundary,
      cards,
    };
  }`;
}
