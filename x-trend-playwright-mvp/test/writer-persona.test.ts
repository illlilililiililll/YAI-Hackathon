import { describe, expect, it } from "vitest";

import { loadWriterPersona, WRITER_PERSONA_PATH } from "../src/writer-persona.js";

describe("Writer Persona loader", () => {
  it("loads the one exact document and creates a stable normalized snapshot", async () => {
    const input = {
      brandName: "  RoamRank  ",
      brandType: "여행\t정보 서비스",
      targetReader: "여행을 준비하는 독자",
      tone: "차분하고  구체적인 합니다체",
      voiceTags: ["근거 중심", "실용적"],
    };
    const first = await loadWriterPersona(input);
    const second = await loadWriterPersona(input);

    expect(WRITER_PERSONA_PATH).toMatch(/\/docs\/writer-persona\.md$/u);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: "1.0",
      personaVersion: "1.3.0",
      brandName: "RoamRank",
      brandType: "여행 정보 서비스",
      tone: "차분하고 구체적인 합니다체",
    });
    expect(first.snapshotId).toBe(`persona_${first.personaSnapshotSha256.slice(0, 24)}`);
    expect(first.personaDocumentSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects empty or normalized duplicate runtime values", async () => {
    await expect(
      loadWriterPersona({
        brandName: " ",
        brandType: "travel",
        targetReader: "reader",
        tone: "calm",
        voiceTags: ["clear"],
      }),
    ).rejects.toThrow("brandName");
    await expect(
      loadWriterPersona({
        brandName: "RoamRank",
        brandType: "travel",
        targetReader: "reader",
        tone: "calm",
        voiceTags: ["근거  중심", "근거 중심"],
      }),
    ).rejects.toThrow("중복");
  });
});
