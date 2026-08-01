import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import {
  CanonicalArticleContentV1Schema,
  ClaimRecordV1Schema,
  type ArticleSurfaceV1,
  type CanonicalArticleContentV1,
  type ClaimRecordV1,
} from "./content-domain.js";

type SurfaceTree = Pick<
  CanonicalArticleContentV1,
  "articleId" | "title" | "metaDescription" | "blocks"
>;

export type CollectedCanonicalSurface = ArticleSurfaceV1 & {
  text: string;
  claimId: string | null;
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function surfaceIdFor(articleId: string, unitId: string): string {
  return `surface_${sha256Text(`${articleId}\0${unitId}`).slice(0, 24)}`;
}

function writerSurface(
  tree: SurfaceTree,
  unit: SurfaceTree["title"],
  jsonPointer: string,
): CollectedCanonicalSurface {
  return {
    surfaceId: surfaceIdFor(tree.articleId, unit.unitId),
    unitId: unit.unitId,
    jsonPointer,
    textSha256: sha256Text(unit.text),
    origin: "writer",
    declaredAssertion: "fact",
    text: unit.text,
    claimId: null,
  };
}

export function collectCanonicalSurfaces(
  tree: SurfaceTree,
): CollectedCanonicalSurface[] {
  const surfaces: CollectedCanonicalSurface[] = [
    writerSurface(tree, tree.title, "/title"),
    writerSurface(tree, tree.metaDescription, "/metaDescription"),
  ];

  tree.blocks.forEach((block, blockIndex) => {
    const root = `/blocks/${blockIndex}`;
    switch (block.kind) {
      case "intro":
        block.paragraphs.forEach((unit, index) => {
          surfaces.push(writerSurface(tree, unit, `${root}/paragraphs/${index}`));
        });
        break;
      case "summary":
      case "checklist":
        surfaces.push(writerSurface(tree, block.heading.text, `${root}/heading/text`));
        block.items.forEach((unit, index) => {
          surfaces.push(writerSurface(tree, unit, `${root}/items/${index}`));
        });
        break;
      case "section":
        surfaces.push(writerSurface(tree, block.heading.text, `${root}/heading/text`));
        block.paragraphs.forEach((unit, index) => {
          surfaces.push(writerSurface(tree, unit, `${root}/paragraphs/${index}`));
        });
        break;
      case "faq":
        surfaces.push(writerSurface(tree, block.heading.text, `${root}/heading/text`));
        block.pairs.forEach((pair, pairIndex) => {
          surfaces.push(
            writerSurface(tree, pair.question, `${root}/pairs/${pairIndex}/question`),
          );
          pair.answers.forEach((unit, answerIndex) => {
            surfaces.push(
              writerSurface(
                tree,
                unit,
                `${root}/pairs/${pairIndex}/answers/${answerIndex}`,
              ),
            );
          });
        });
        break;
      case "related_link":
      case "cta":
        if (block.supportingCopy) {
          surfaces.push(
            writerSurface(tree, block.supportingCopy, `${root}/supportingCopy`),
          );
        }
        surfaces.push({
          surfaceId: surfaceIdFor(tree.articleId, block.link.unitId),
          unitId: block.link.unitId,
          jsonPointer: `${root}/link`,
          textSha256: sha256Text(block.link.displayLabel),
          origin: "system_link",
          declaredAssertion: "instruction",
          text: block.link.displayLabel,
          claimId: null,
        });
        break;
    }
  });
  return surfaces;
}

export function validateSurfaceIndex(
  contentValue: CanonicalArticleContentV1,
  claimsValue?: readonly ClaimRecordV1[],
): CollectedCanonicalSurface[] {
  const content = CanonicalArticleContentV1Schema.parse(contentValue);
  const expected = collectCanonicalSurfaces(content);
  const stored = expected.map(({ text: _text, claimId: _claimId, ...surface }) => surface);
  if (canonicalJson(stored) !== canonicalJson(content.surfaceIndex)) {
    throw new Error("Canonical Article surfaceIndex가 body에서 재계산한 값과 다릅니다.");
  }

  const unitIds = expected.map((surface) => surface.unitId);
  const surfaceIds = expected.map((surface) => surface.surfaceId);
  if (
    new Set(unitIds).size !== unitIds.length ||
    new Set(surfaceIds).size !== surfaceIds.length
  ) {
    throw new Error("Canonical Article unit 또는 surface ID가 중복됩니다.");
  }

  const factualSurfaces = expected.filter((surface) => surface.origin === "writer");
  if (content.claimUsages.length !== factualSurfaces.length) {
    throw new Error("factual surface와 ClaimUsage cardinality가 다릅니다.");
  }
  factualSurfaces.forEach((surface, index) => {
    const usage = content.claimUsages[index];
    if (!usage || usage.surfaceId !== surface.surfaceId) {
      throw new Error("ClaimUsage 순서 또는 surface reference가 올바르지 않습니다.");
    }
    surface.claimId = usage.claimId;
  });
  const systemIds = new Set(
    expected
      .filter((surface) => surface.origin === "system_link")
      .map((surface) => surface.surfaceId),
  );
  if (content.claimUsages.some((usage) => systemIds.has(usage.surfaceId))) {
    throw new Error("system link surface에는 ClaimUsage가 없어야 합니다.");
  }

  if (claimsValue) {
    const claims = claimsValue.map((claim) => ClaimRecordV1Schema.parse(claim));
    const claimMap = new Map(claims.map((claim) => [claim.claimId, claim]));
    for (const usage of content.claimUsages) {
      const claim = claimMap.get(usage.claimId);
      if (!claim || (claim.status !== "accepted" && claim.status !== "qualified")) {
        throw new Error("ClaimUsage가 accepted/qualified Claim으로 resolve되지 않습니다.");
      }
    }
  }

  const sourceIds = content.sources.map((source) => source.sourceId);
  const sortedSourceIds = [...sourceIds].sort();
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((sourceId, index) => sourceId !== sortedSourceIds[index])
  ) {
    throw new Error("SourceCitation은 sourceId ASCII 오름차순의 고유 배열이어야 합니다.");
  }
  for (const source of content.sources) {
    if (new URL(source.url).protocol !== "https:") {
      throw new Error("SourceCitation URL은 HTTPS여야 합니다.");
    }
  }
  return expected;
}
