import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { sha256Bytes, sha256Canonical } from "./canonical-json.js";
import {
  PersonaSnapshotV1Schema,
  type PersonaSnapshotV1,
} from "./content-domain.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const WRITER_PERSONA_PATH = path.resolve(
  moduleDirectory,
  "../../docs/writer-persona.md",
);

const RuntimePersonaInputSchema = z.strictObject({
  brandName: z.string(),
  brandType: z.string(),
  targetReader: z.string(),
  tone: z.string(),
  voiceTags: z.array(z.string()).min(1),
});

export type RuntimePersonaInput = z.input<typeof RuntimePersonaInputSchema>;

type PersonaPolicyIdentity = {
  name: string;
  version: string;
  domain: "travel";
  locale: "ko-KR";
  runtimeRole: "final-writer-only";
};

const REQUIRED_FRONTMATTER = [
  "name",
  "version",
  "domain",
  "locale",
  "runtime_role",
] as const;

function normalizeRuntimeText(value: string, label: string): string {
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/\p{White_Space}+/gu, " ");
  if (!normalized) {
    throw new Error(`${label}은(는) 비어 있을 수 없습니다.`);
  }
  return normalized;
}

function parsePolicyIdentity(document: string): PersonaPolicyIdentity {
  if (!document.startsWith("---\n")) {
    throw new Error("Writer Persona frontmatter 시작 구분자가 없습니다.");
  }
  const end = document.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error("Writer Persona frontmatter 종료 구분자가 없습니다.");
  }

  const fields = new Map<string, string>();
  for (const line of document.slice(4, end).split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("Writer Persona frontmatter 형식이 잘못되었습니다.");
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (fields.has(key)) {
      throw new Error(`Writer Persona frontmatter key가 중복됩니다: ${key}`);
    }
    fields.set(key, value);
  }

  for (const key of REQUIRED_FRONTMATTER) {
    if (!fields.get(key)) {
      throw new Error(`Writer Persona frontmatter 필드가 없습니다: ${key}`);
    }
  }
  if (fields.get("domain") !== "travel") {
    throw new Error("Writer Persona domain은 travel이어야 합니다.");
  }
  if (fields.get("locale") !== "ko-KR") {
    throw new Error("Writer Persona locale은 ko-KR이어야 합니다.");
  }
  if (fields.get("runtime_role") !== "final-writer-only") {
    throw new Error("Writer Persona runtime_role이 올바르지 않습니다.");
  }

  return {
    name: fields.get("name")!,
    version: fields.get("version")!,
    domain: "travel",
    locale: "ko-KR",
    runtimeRole: "final-writer-only",
  };
}

export async function loadWriterPersona(
  inputValue: RuntimePersonaInput,
): Promise<PersonaSnapshotV1> {
  const input = RuntimePersonaInputSchema.parse(inputValue);
  const stats = await lstat(WRITER_PERSONA_PATH);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Writer Persona는 regular non-symlink file이어야 합니다.");
  }
  const resolved = await realpath(WRITER_PERSONA_PATH);
  if (resolved !== WRITER_PERSONA_PATH) {
    throw new Error("Writer Persona realpath가 고정 경로와 다릅니다.");
  }

  const bytes = await readFile(WRITER_PERSONA_PATH);
  let document: string;
  try {
    document = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Writer Persona가 유효한 UTF-8 문서가 아닙니다.");
  }
  const policyIdentity = parsePolicyIdentity(document);
  const personaDocumentSha256 = sha256Bytes(bytes);
  const voiceTags = input.voiceTags.map((tag, index) =>
    normalizeRuntimeText(tag, `voiceTags[${index}]`),
  );
  if (new Set(voiceTags).size !== voiceTags.length) {
    throw new Error("voiceTags는 정규화 후 중복될 수 없습니다.");
  }

  const normalized = {
    brandName: normalizeRuntimeText(input.brandName, "brandName"),
    brandType: normalizeRuntimeText(input.brandType, "brandType"),
    targetReader: normalizeRuntimeText(input.targetReader, "targetReader"),
    tone: normalizeRuntimeText(input.tone, "tone"),
    voiceTags,
  };
  const snapshotIdentity = {
    policyIdentity,
    personaDocumentSha256,
    ...normalized,
  };
  const personaSnapshotSha256 = sha256Canonical(snapshotIdentity);

  return PersonaSnapshotV1Schema.parse({
    schemaVersion: "1.0",
    snapshotId: `persona_${personaSnapshotSha256.slice(0, 24)}`,
    personaVersion: policyIdentity.version,
    personaDocumentSha256,
    personaSnapshotSha256,
    ...normalized,
  });
}
