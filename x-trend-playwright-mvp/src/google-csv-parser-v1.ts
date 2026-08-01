import { createHash } from "node:crypto";

import {
  GoogleCandidateSchema,
  GoogleInterestPointSchema,
  type GoogleCandidate,
  type GoogleInterestPoint,
} from "./content-domain.js";

const HOUR_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/u;

export type PartialBoundary =
  | { state: "none" }
  | { state: "from"; timestamp: string }
  | { state: "unavailable" };

export type ParsedGoogleInterestCsv = {
  csvSha256: string;
  seriesByCandidateId: Record<string, GoogleInterestPoint[]>;
};

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new Error("Google Trends CSV 따옴표가 닫히지 않았습니다.");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

function parseSeoulHour(value: string): string {
  const match = HOUR_PATTERN.exec(value);
  if (!match) {
    throw new Error(`지원하지 않는 Google Trends 시각 형식입니다: ${value}`);
  }

  const [, year, month, day, hour] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:00:00+09:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`유효하지 않은 Google Trends 시각입니다: ${value}`);
  }
  return parsed.toISOString();
}

function parseInterestValue(value: string): number {
  if (!/^(?:0|[1-9]\d?|100)$/u.test(value)) {
    throw new Error(`Interest 값은 0..100 정수여야 합니다: ${value}`);
  }
  return Number(value);
}

export function parseGoogleInterestOverTimeCsv(
  rawBytes: Uint8Array,
  candidatesInput: GoogleCandidate[],
  partialBoundary: PartialBoundary,
): ParsedGoogleInterestCsv {
  if (partialBoundary.state === "unavailable") {
    throw new Error("Partial 구간을 화면 extraction과 결속할 수 없습니다.");
  }

  const candidates = candidatesInput.map((candidate) =>
    GoogleCandidateSchema.parse(candidate),
  );
  if (candidates.length < 1 || candidates.length > 5) {
    throw new Error("Google Trends 비교 후보는 1..5개여야 합니다.");
  }
  if (
    new Set(candidates.map((candidate) => candidate.candidateId)).size !==
      candidates.length ||
    new Set(candidates.map((candidate) => candidate.label)).size !==
      candidates.length
  ) {
    throw new Error("Google Trends 후보 ID와 label은 각각 고유해야 합니다.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    throw new Error("Google Trends CSV는 strict UTF-8이어야 합니다.");
  }
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }

  const rows = parseCsvRows(text);
  const headerIndex = rows.findIndex((row) => row[0] === "Time");
  if (headerIndex < 0) {
    throw new Error("Google Trends CSV의 Time header를 찾을 수 없습니다.");
  }

  const header = rows[headerIndex];
  if (!header) {
    throw new Error("Google Trends CSV header를 읽을 수 없습니다.");
  }
  const expectedHeader = ["Time", ...candidates.map((candidate) => candidate.label)];
  if (
    header.length !== expectedHeader.length ||
    header.some((value, index) => value !== expectedHeader[index])
  ) {
    throw new Error("Google Trends CSV 후보 column 순서가 요청과 다릅니다.");
  }

  const partialFrom =
    partialBoundary.state === "from"
      ? Date.parse(parseSeoulHour(partialBoundary.timestamp))
      : null;
  const seriesByCandidateId = Object.fromEntries(
    candidates.map((candidate) => [candidate.candidateId, []]),
  ) as Record<string, GoogleInterestPoint[]>;
  let previousTimestamp = -Infinity;

  for (const row of rows.slice(headerIndex + 1)) {
    if (row.length === 1 && row[0] === "") {
      continue;
    }
    if (row.length !== expectedHeader.length) {
      throw new Error("Google Trends CSV row width가 header와 다릅니다.");
    }

    const rawTimestamp = row[0];
    if (!rawTimestamp) {
      throw new Error("Google Trends CSV timestamp가 비어 있습니다.");
    }
    const observedAt = parseSeoulHour(rawTimestamp);
    const timestamp = Date.parse(observedAt);
    if (timestamp <= previousTimestamp) {
      throw new Error("Google Trends CSV timestamp는 중복 없이 증가해야 합니다.");
    }
    previousTimestamp = timestamp;

    candidates.forEach((candidate, candidateIndex) => {
      const rawValue = row[candidateIndex + 1];
      if (rawValue === undefined) {
        throw new Error("Google Trends CSV candidate cell이 없습니다.");
      }
      const point = GoogleInterestPointSchema.parse({
        observedAt,
        value: parseInterestValue(rawValue),
        isPartial: partialFrom !== null && timestamp >= partialFrom,
      });
      seriesByCandidateId[candidate.candidateId]?.push(point);
    });
  }

  if (Object.values(seriesByCandidateId).some((series) => series.length === 0)) {
    throw new Error("Google Trends CSV에 Interest row가 없습니다.");
  }

  return {
    csvSha256: createHash("sha256").update(rawBytes).digest("hex"),
    seriesByCandidateId,
  };
}
