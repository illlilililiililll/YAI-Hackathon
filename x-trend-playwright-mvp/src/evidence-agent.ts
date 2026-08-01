import {
  ContentBriefV1Schema,
  EvidenceResearchResultV1Schema,
  SourceLedgerEntryV1Schema,
  type ContentBriefV1,
  type EvidenceResearchResultV1,
  type SourceDiscoveryRefV1,
  type SourceLedgerEntryV1,
  type SourceSnapshotV1,
} from "./content-domain.js";
import {
  buildClaimLedger,
  coreClaimsHaveTierAEvidence,
  type ClaimDraftV1,
} from "./claim-ledger.js";
import type { FetchedSourcePage } from "./source-fetch.js";
import { SourceFetchError } from "./source-fetch.js";
import {
  admitSourceSnapshot,
  isAllowedSourceHost,
  SourceHostPolicyV1Schema,
  type SourceHostPolicyV1,
} from "./source-policy-gate.js";
import {
  dedupeDiscoveryRefs,
  validateDiscoveryPortInput,
  type WebDiscoveryPort,
} from "./web-search-discovery.js";

export interface EvidenceSourceFetchPort {
  fetch(
    discovery: SourceDiscoveryRefV1,
    attempt: 1 | 2,
  ): Promise<FetchedSourcePage>;
}

export interface ClaimExtractionPort {
  extract(input: {
    brief: ContentBriefV1;
    admittedSources: SourceSnapshotV1[];
    attempt: 1 | 2;
  }): Promise<ClaimDraftV1[]>;
}

export interface EvidenceAgentOptions {
  discovery: WebDiscoveryPort;
  fetcher: EvidenceSourceFetchPort;
  claimExtractor: ClaimExtractionPort;
  sourceHostPolicy: SourceHostPolicyV1;
  maxSourcesPerAttempt?: number;
  sourceIdFactory?: () => string;
  evidenceSpanIdFactory?: () => string;
}

function exclusion(
  ref: SourceDiscoveryRefV1,
  reasonCode: string,
): SourceLedgerEntryV1 {
  return SourceLedgerEntryV1Schema.parse({
    status: "excluded",
    candidateUrl: ref.candidateUrl,
    reasonCode,
    webSearchCallId: ref.webSearchCallId,
  });
}

function admittedSnapshots(entries: readonly SourceLedgerEntryV1[]): SourceSnapshotV1[] {
  return entries.flatMap((entry) =>
    entry.status === "admitted" ? [entry.snapshot] : [],
  );
}

function sourceKey(entry: SourceLedgerEntryV1): string {
  return entry.status === "admitted"
    ? `admitted:${entry.snapshot.canonicalUrl}`
    : `excluded:${entry.candidateUrl}`;
}

/**
 * Two-attempt Evidence orchestration. Discovery and network boundaries remain
 * injected so the integration owner can attach hosted Agents SDK streaming and
 * the pinned production transport without creating a second code path.
 */
export async function researchEvidence(
  briefInput: ContentBriefV1,
  options: EvidenceAgentOptions,
): Promise<EvidenceResearchResultV1> {
  const brief = ContentBriefV1Schema.parse(validateDiscoveryPortInput(briefInput));
  const policy = SourceHostPolicyV1Schema.parse(options.sourceHostPolicy);
  const maxSourcesPerAttempt = options.maxSourcesPerAttempt ?? 6;
  if (!Number.isInteger(maxSourcesPerAttempt) || maxSourcesPerAttempt < 1) {
    throw new Error("maxSourcesPerAttempt는 양의 정수여야 합니다.");
  }

  const ledger: SourceLedgerEntryV1[] = [];
  const ledgerKeys = new Set<string>();
  const attemptedUrls = new Set<string>();
  const warningCodes = new Set<string>();
  let lastClaims: EvidenceResearchResultV1["claims"] = [];
  let fetchAttemptCount = 0;
  let blockedFetchCount = 0;

  for (const attempt of [1, 2] as const) {
    const discovered = dedupeDiscoveryRefs(await options.discovery.discover(brief, attempt));
    const newRefs = discovered
      .filter((ref) => !attemptedUrls.has(ref.candidateUrl))
      .slice(0, maxSourcesPerAttempt);
    if (newRefs.length === 0) {
      warningCodes.add(
        attempt === 1 ? "source_discovery_empty" : "source_research_exhausted",
      );
    }

    for (const ref of newRefs) {
      attemptedUrls.add(ref.candidateUrl);
      let candidateHostname: string;
      try {
        candidateHostname = new URL(ref.candidateUrl).hostname.toLowerCase();
      } catch {
        const entry = exclusion(ref, "invalid_url");
        const key = sourceKey(entry);
        if (!ledgerKeys.has(key)) {
          ledgerKeys.add(key);
          ledger.push(entry);
        }
        continue;
      }
      // Admission policy is also an egress policy: unknown publishers must be
      // rejected before DNS resolution or an outbound request can occur.
      if (!isAllowedSourceHost(policy, candidateHostname)) {
        const entry = exclusion(ref, "unknown_host");
        const key = sourceKey(entry);
        if (!ledgerKeys.has(key)) {
          ledgerKeys.add(key);
          ledger.push(entry);
        }
        continue;
      }
      fetchAttemptCount += 1;
      let entry: SourceLedgerEntryV1;
      try {
        const fetched = await options.fetcher.fetch(ref, attempt);
        entry = admitSourceSnapshot({
          discovery: ref,
          fetched,
          policy,
          sourceIdFactory: options.sourceIdFactory,
          evidenceSpanIdFactory: options.evidenceSpanIdFactory,
        });
      } catch (error) {
        if (error instanceof SourceFetchError) {
          if (
            error.code === "non_public_ip" ||
            error.code === "redirect_policy" ||
            error.code === "timeout" ||
            error.code === "network"
          ) {
            blockedFetchCount += 1;
          }
          entry = exclusion(ref, `fetch_${error.code}`);
        } else {
          throw error;
        }
      }
      const key = sourceKey(entry);
      if (!ledgerKeys.has(key)) {
        ledgerKeys.add(key);
        ledger.push(entry);
      }
    }

    const sources = admittedSnapshots(ledger);
    const claimDrafts = await options.claimExtractor.extract({
      brief,
      admittedSources: sources,
      attempt,
    });
    lastClaims = buildClaimLedger(claimDrafts, sources);
    if (coreClaimsHaveTierAEvidence(lastClaims, sources)) {
      return EvidenceResearchResultV1Schema.parse({
        status: "sufficient",
        sources: ledger,
        claims: lastClaims,
        attempts: attempt,
        warningCodes: [...warningCodes],
      });
    }
    if (attempt === 1) {
      warningCodes.add("core_claim_research_retry");
    }
  }

  const noAdmittedSources = admittedSnapshots(ledger).length === 0;
  const sourceBlocked =
    noAdmittedSources &&
    fetchAttemptCount > 0 &&
    blockedFetchCount === fetchAttemptCount;
  return EvidenceResearchResultV1Schema.parse({
    status: sourceBlocked ? "source_blocked" : "needs_evidence",
    sources: ledger,
    claims: lastClaims,
    attempts: 2,
    warningCodes: [...warningCodes],
  });
}
