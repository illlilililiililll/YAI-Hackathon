import { describe, expect, it } from "vitest";

import {
  createSiteLinkRegistry,
  projectWriterLinkChoices,
  resolveSiteLink,
} from "../src/site-link-registry.js";

describe("SiteLinkRegistry", () => {
  it("keeps URLs private from the Writer projection and resolves them for the assembler", () => {
    const registry = createSiteLinkRegistry({
      siteOrigin: "https://example.com/",
      allowedHosts: ["example.com"],
      candidates: [
        {
          linkCandidateId: "link_guide",
          kind: "internal",
          labelId: "internal_guide",
          url: "https://example.com/guides/travel",
        },
      ],
    });
    const choices = projectWriterLinkChoices(registry);

    expect(choices).toEqual([
      {
        linkCandidateId: "link_guide",
        kind: "internal",
        displayLabel: "관련 여행 가이드 보기",
      },
    ]);
    expect(JSON.stringify(choices)).not.toContain("https://");
    expect(resolveSiteLink(registry, "link_guide", "internal").url).toBe(
      "https://example.com/guides/travel",
    );
  });

  it("rejects unsafe, duplicate, or mismatched link configuration", () => {
    expect(() =>
      createSiteLinkRegistry({
        siteOrigin: "https://example.com/",
        allowedHosts: ["example.com"],
        candidates: [
          {
            linkCandidateId: "link_bad",
            kind: "cta",
            labelId: "internal_details",
            url: "https://example.com/path",
          },
        ],
      }),
    ).toThrow("kind");
    expect(() =>
      createSiteLinkRegistry({
        siteOrigin: "https://example.com/",
        allowedHosts: ["example.com"],
        candidates: [
          {
            linkCandidateId: "link_bad",
            kind: "internal",
            labelId: "internal_details",
            url: "javascript:alert(1)",
          },
        ],
      }),
    ).toThrow("HTTPS");
  });
});
