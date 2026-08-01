import { Client, buildConnector } from "undici";

import type {
  PinnedSourceTransport,
  PinnedTransportRequest,
  PinnedTransportResponse,
} from "./source-fetch.js";

function headersToRecord(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  );
}

/**
 * Creates a fresh one-request Undici client whose DNS lookup can return only
 * the addresses approved by source-fetch. The URL hostname remains the TLS
 * SNI/certificate/Host identity; only socket routing is pinned.
 */
export class UndiciPinnedSourceTransport implements PinnedSourceTransport {
  async request(
    request: PinnedTransportRequest,
  ): Promise<PinnedTransportResponse> {
    const url = new URL(request.url);
    const selected = request.approvedAddresses[0];
    if (!selected) throw new Error("승인된 Source address가 없습니다.");
    let remoteAddress: string | undefined;
    const baseConnector = buildConnector({
      allowH2: false,
      maxCachedSessions: 0,
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, request.approvedAddresses.map((entry) => ({
            address: entry.address,
            family: entry.family,
          })));
          return;
        }
        callback(null, selected.address, selected.family);
      },
    });
    const connector: typeof baseConnector = (options, callback) => {
      baseConnector(options, (error, socket) => {
        if (error) {
          callback(error, null);
          return;
        }
        remoteAddress = socket.remoteAddress;
        callback(null, socket);
      });
    };
    const client = new Client(url.origin, {
      connect: connector,
      pipelining: 1,
      maxResponseSize: request.maxBodyBytes + 1,
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
      keepAliveTimeout: 1,
    });
    try {
      const response = await client.request({
        method: "GET",
        path: `${url.pathname}${url.search}`,
        signal: request.signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9",
          "accept-encoding": "identity",
          "user-agent": "RoamRank-EvidenceBot/1.0",
        },
        throwOnError: false,
      });
      const body = new Uint8Array(await response.body.arrayBuffer());
      if (!remoteAddress) throw new Error("Undici socket remoteAddress가 없습니다.");
      return {
        status: response.statusCode,
        headers: headersToRecord(response.headers),
        body,
        remoteAddress,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
