import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { sha256Bytes, sha256Canonical } from "./canonical-json.js";
import {
  ProviderModeSchema,
  SourceDiscoveryRefV1Schema,
  type ExtractedBlockV1,
  type ProviderMode,
  type SourceDiscoveryRefV1,
} from "./content-domain.js";
import { extractSourceText } from "./source-text-extractor.js";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_QUERY_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "signature",
  "sig",
  "x-amz-signature",
  "x-goog-signature",
]);
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

export type SourceFetchErrorCode =
  | "redirect_policy"
  | "non_public_ip"
  | "http_status"
  | "content_type"
  | "charset"
  | "body_too_large"
  | "no_text"
  | "timeout"
  | "network";

export class SourceFetchError extends Error {
  constructor(
    public readonly code: SourceFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type SourceHostResolver = (
  hostname: string,
) => Promise<ResolvedAddress[]>;

export interface PinnedTransportRequest {
  url: string;
  hostname: string;
  approvedAddresses: readonly ResolvedAddress[];
  signal: AbortSignal;
  maxBodyBytes: number;
}

export interface PinnedTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  remoteAddress: string;
}

/**
 * A production implementation must connect only through approvedAddresses and
 * preserve the original hostname for Host, TLS SNI and certificate checks.
 */
export interface PinnedSourceTransport {
  request(request: PinnedTransportRequest): Promise<PinnedTransportResponse>;
}

export interface FetchedSourcePage {
  discovery: SourceDiscoveryRefV1;
  fetchToolCallId: string;
  requestUrl: string;
  finalUrl: string;
  redirectChain: string[];
  status: 200;
  contentType: string;
  retrievedAt: string;
  decompressedByteLength: number;
  bodySha256: string;
  blocks: ExtractedBlockV1[];
  truncated: boolean;
  resultSha256: string;
  provenanceMode: ProviderMode;
}

export interface FetchSourcePageOptions {
  discovery: SourceDiscoveryRefV1;
  fetchToolCallId: string;
  transport: PinnedSourceTransport;
  resolver?: SourceHostResolver;
  now?: () => Date;
  /**
   * Callers must state provenance explicitly. A network response alone cannot
   * prove that the invocation was captured by the live provenance registry.
   */
  provenanceMode: ProviderMode;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxExtractedUtf8Bytes?: number;
  maxRedirects?: number;
  forbiddenSecretValues?: readonly string[];
  isAllowedRedirectHost?: (hostname: string) => boolean;
  signal?: AbortSignal;
}

function normalizedIpLiteral(input: string): string {
  const withoutBrackets = input.startsWith("[") && input.endsWith("]")
    ? input.slice(1, -1)
    : input;
  return withoutBrackets.toLowerCase();
}

function parseIpv4(input: string): number[] | null {
  if (isIP(input) !== 4) {
    return null;
  }
  const octets = input.split(".").map(Number);
  return octets.length === 4 ? octets : null;
}

function inIpv4Cidr(octets: number[], base: number[], prefix: number): boolean {
  const value =
    (((octets[0] ?? 0) << 24) >>> 0) +
    ((octets[1] ?? 0) << 16) +
    ((octets[2] ?? 0) << 8) +
    (octets[3] ?? 0);
  const baseValue =
    (((base[0] ?? 0) << 24) >>> 0) +
    ((base[1] ?? 0) << 16) +
    ((base[2] ?? 0) << 8) +
    (base[3] ?? 0);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function parseIpv6(input: string): bigint | null {
  if (
    isIP(input) !== 6 ||
    input.includes("%") ||
    input.includes(".") ||
    input.split("::").length > 2
  ) {
    return null;
  }
  const [leftRaw = "", rightRaw = ""] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((input.includes("::") && missing < 1) || (!input.includes("::") && missing !== 0)) {
    return null;
  }
  const hextets = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (
    hextets.length !== 8 ||
    hextets.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
  ) {
    return null;
  }
  return hextets.reduce(
    (value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)),
    0n,
  );
}

function ipv6CidrBase(input: string): bigint {
  const parsed = parseIpv6(input);
  if (parsed === null) {
    throw new Error(`invalid IPv6 CIDR base: ${input}`);
  }
  return parsed;
}

function inIpv6Cidr(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

export function isPublicGlobalAddress(addressInput: string): boolean {
  const address = normalizedIpLiteral(addressInput);
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const blocked: Array<[number[], number]> = [
      [[0, 0, 0, 0], 8],
      [[10, 0, 0, 0], 8],
      [[100, 64, 0, 0], 10],
      [[127, 0, 0, 0], 8],
      [[169, 254, 0, 0], 16],
      [[172, 16, 0, 0], 12],
      [[192, 0, 0, 0], 24],
      [[192, 0, 2, 0], 24],
      [[192, 88, 99, 0], 24],
      [[192, 168, 0, 0], 16],
      [[198, 18, 0, 0], 15],
      [[198, 51, 100, 0], 24],
      [[203, 0, 113, 0], 24],
      [[224, 0, 0, 0], 4],
      [[240, 0, 0, 0], 4],
    ];
    return !blocked.some(([base, prefix]) => inIpv4Cidr(ipv4, base, prefix));
  }
  const ipv6 = parseIpv6(address);
  if (ipv6 === null) {
    return false;
  }
  const blockedV6: Array<[bigint, number]> = [
    [ipv6CidrBase("::"), 128],
    [ipv6CidrBase("::1"), 128],
    [ipv6CidrBase("::ffff:0:0"), 96],
    [ipv6CidrBase("100::"), 64],
    [ipv6CidrBase("2001:2::"), 48],
    [ipv6CidrBase("2001:20::"), 28],
    [ipv6CidrBase("2001:db8::"), 32],
    [ipv6CidrBase("fc00::"), 7],
    [ipv6CidrBase("fe80::"), 10],
    [ipv6CidrBase("ff00::"), 8],
  ];
  if (blockedV6.some(([base, prefix]) => inIpv6Cidr(ipv6, base, prefix))) {
    return false;
  }
  return inIpv6Cidr(ipv6, ipv6CidrBase("2000::"), 3);
}

export const defaultSourceHostResolver: SourceHostResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new SourceFetchError("network", "지원하지 않는 DNS address family입니다.");
    }
    return { address: answer.address, family: answer.family };
  });
};

function validateSafeUrl(
  input: string,
  forbiddenSecretValues: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SourceFetchError("redirect_policy", "Source URL이 유효하지 않습니다.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new SourceFetchError(
      "redirect_policy",
      "Source URL은 credential/fragment 없는 HTTPS여야 합니다.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    METADATA_HOSTS.has(hostname)
  ) {
    throw new SourceFetchError("non_public_ip", "로컬·metadata host는 허용되지 않습니다.");
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      throw new SourceFetchError(
        "redirect_policy",
        "credential-like query key는 허용되지 않습니다.",
      );
    }
  }
  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(url.href);
  } catch {
    throw new SourceFetchError(
      "redirect_policy",
      "Source URL percent encoding이 유효하지 않습니다.",
    );
  }
  for (const secret of forbiddenSecretValues) {
    if (secret.length >= 6 && (url.href.includes(secret) || decodedUrl.includes(secret))) {
      throw new SourceFetchError(
        "redirect_policy",
        "Source URL에 secret 값이 포함되어 있습니다.",
      );
    }
  }
  return url;
}

async function resolveApprovedAddresses(
  hostnameInput: string,
  resolver: SourceHostResolver,
): Promise<ResolvedAddress[]> {
  const hostname = normalizedIpLiteral(hostnameInput);
  let answers: ResolvedAddress[];
  if (isIP(hostname) !== 0) {
    answers = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  } else {
    try {
      answers = await resolver(hostname);
    } catch (error) {
      throw new SourceFetchError(
        "network",
        `Source DNS 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const unique = new Map<string, ResolvedAddress>();
  for (const answer of answers) {
    const address = normalizedIpLiteral(answer.address);
    if (isIP(address) !== answer.family || !isPublicGlobalAddress(address)) {
      throw new SourceFetchError(
        "non_public_ip",
        `public global-unicast가 아닌 주소입니다: ${address}`,
      );
    }
    unique.set(address, { address, family: answer.family });
  }
  if (unique.size === 0) {
    throw new SourceFetchError("network", "Source DNS 결과가 비어 있습니다.");
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.family - right.family || left.address.localeCompare(right.address, "en"),
  );
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function validateHtmlContentType(value: string | undefined): string {
  if (!value) {
    throw new SourceFetchError("content_type", "Content-Type이 없습니다.");
  }
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "text/html") {
    throw new SourceFetchError("content_type", "HTML Source만 허용됩니다.");
  }
  const charset = parts
    .slice(1)
    .find((part) => part.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^['"]|['"]$/gu, "");
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    throw new SourceFetchError("charset", "UTF-8 HTML만 허용됩니다.");
  }
  return value;
}

async function withTimeout<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceFetchError("timeout", "Source fetch 시간이 초과되었습니다."));
    }, timeoutMs);
  });
  try {
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;
    return await Promise.race([operation(signal), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function fetchSourcePage(
  options: FetchSourcePageOptions,
): Promise<FetchedSourcePage> {
  const discovery = SourceDiscoveryRefV1Schema.parse(options.discovery);
  if (!options.fetchToolCallId.trim()) {
    throw new Error("fetchToolCallId가 필요합니다.");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxExtractedUtf8Bytes = options.maxExtractedUtf8Bytes ?? 65_536;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    !Number.isInteger(maxExtractedUtf8Bytes) ||
    maxExtractedUtf8Bytes < 1
  ) {
    throw new Error("Source fetch limit은 유효한 정수여야 합니다.");
  }
  const resolver = options.resolver ?? defaultSourceHostResolver;
  const now = options.now ?? (() => new Date());
  const provenanceMode = ProviderModeSchema.parse(options.provenanceMode);
  const forbiddenSecretValues = options.forbiddenSecretValues ?? [];
  const firstUrl = validateSafeUrl(discovery.candidateUrl, forbiddenSecretValues);
  const discoveryHost = firstUrl.hostname.toLowerCase();
  const redirectChain: string[] = [];
  let currentUrl = firstUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const hostname = currentUrl.hostname.toLowerCase();
    if (
      hostname !== discoveryHost &&
      !options.isAllowedRedirectHost?.(hostname)
    ) {
      throw new SourceFetchError(
        "redirect_policy",
        "허용되지 않은 redirect host입니다.",
      );
    }
    const approvedAddresses = await resolveApprovedAddresses(hostname, resolver);
    let response: PinnedTransportResponse;
    try {
      response = await withTimeout(timeoutMs, options.signal, (signal) =>
        options.transport.request({
          url: currentUrl.href,
          hostname,
          approvedAddresses,
          signal,
          maxBodyBytes,
        }),
      );
    } catch (error) {
      if (error instanceof SourceFetchError) {
        throw error;
      }
      throw new SourceFetchError(
        "network",
        `Source transport가 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const remoteAddress = normalizedIpLiteral(response.remoteAddress);
    if (
      !isPublicGlobalAddress(remoteAddress) ||
      !approvedAddresses.some((answer) => answer.address === remoteAddress)
    ) {
      throw new SourceFetchError(
        "non_public_ip",
        "실제 remote address가 승인 DNS 집합과 다릅니다.",
      );
    }

    if (REDIRECT_STATUS.has(response.status)) {
      if (hop >= maxRedirects) {
        throw new SourceFetchError("redirect_policy", "redirect 한도를 초과했습니다.");
      }
      const location = headerValue(response.headers, "location");
      if (!location) {
        throw new SourceFetchError("redirect_policy", "redirect location이 없습니다.");
      }
      redirectChain.push(currentUrl.href);
      let redirectUrl: string;
      try {
        redirectUrl = new URL(location, currentUrl).href;
      } catch {
        throw new SourceFetchError(
          "redirect_policy",
          "redirect location이 유효한 URL이 아닙니다.",
        );
      }
      currentUrl = validateSafeUrl(redirectUrl, forbiddenSecretValues);
      continue;
    }

    if (response.status !== 200) {
      throw new SourceFetchError("http_status", `Source HTTP ${response.status}`);
    }
    const contentType = validateHtmlContentType(
      headerValue(response.headers, "content-type"),
    );
    if (response.body.byteLength > maxBodyBytes) {
      throw new SourceFetchError("body_too_large", "Source body가 제한을 초과했습니다.");
    }
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch {
      throw new SourceFetchError("charset", "유효한 UTF-8 body가 아닙니다.");
    }
    if (!html.trim()) {
      throw new SourceFetchError("no_text", "Source body가 비어 있습니다.");
    }
    const extraction = extractSourceText(html, currentUrl.href, {
      maxBlocks: 60,
      maxExtractedUtf8Bytes,
    });
    if (extraction.blocks.length === 0) {
      throw new SourceFetchError("no_text", "허용된 visible text block이 없습니다.");
    }
    const retrievedAt = now().toISOString();
    const resultWithoutHash = {
      requestUrl: firstUrl.href,
      finalUrl: currentUrl.href,
      redirectChain,
      status: 200 as const,
      contentType,
      retrievedAt,
      decompressedByteLength: response.body.byteLength,
      bodySha256: sha256Bytes(response.body),
      blocks: extraction.blocks,
      truncated: extraction.truncated,
      provenanceMode,
    };
    return {
      discovery,
      fetchToolCallId: options.fetchToolCallId,
      ...resultWithoutHash,
      resultSha256: sha256Canonical(resultWithoutHash),
    };
  }
  throw new SourceFetchError("redirect_policy", "redirect 처리가 종료되지 않았습니다.");
}
