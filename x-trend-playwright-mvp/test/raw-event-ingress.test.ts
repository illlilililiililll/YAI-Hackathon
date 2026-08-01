import { describe, expect, it } from "vitest";

import { InMemoryRawEventPort } from "../src/raw-event-port.js";
import {
  RawEventIngress,
  materializeSdkPublicEvent,
} from "../src/raw-event-ingress.js";

describe("RawEventIngress", () => {
  it("materializes SDK public events, redacts secrets, orders and seals once", async () => {
    const port = new InMemoryRawEventPort();
    const ingress = new RawEventIngress({
      runId: "run_00000000-0000-4000-8000-000000000001",
      secrets: ["secret", "secret-long"],
      port,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      semanticProjector: (event) =>
        typeof event === "object" && event !== null && !Array.isArray(event)
          ? { type: event.type ?? null }
          : null,
    });

    expect(await ingress.accept({
      type: "run_item_stream_event",
      name: "tool_called",
      item: {
        toJSON: () => ({
          rawItem: {
            name: "search_x_with_playwright",
            arguments: "prefix secret-long suffix",
          },
          authorization: "secret",
        }),
      },
    })).toBe(1);
    expect(await ingress.accept({
      type: "raw_model_stream_event",
      source: "openai-responses",
      data: { type: "model", token: "secret" },
    })).toBe(2);

    const sealed = await ingress.seal();
    const text = new TextDecoder().decode(sealed.fileBytes);
    expect(text).not.toContain("secret-long");
    expect(text).not.toContain('"secret"');
    expect(text).toContain("[REDACTED]");
    expect(sealed.auditIndex.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(sealed.receipt.eventCount).toBe(2);
    expect(port.lines).toHaveLength(2);
    await expect(ingress.accept({ type: "agent_updated_stream_event" })).rejects.toThrow(
      /seal/u,
    );
    await expect(ingress.seal()).rejects.toThrow(/seal/u);
  });

  it("rejects non-JSON-safe SDK values before stringify can erase them", () => {
    expect(() =>
      materializeSdkPublicEvent({
        type: "raw_model_stream_event",
        source: "openai-responses",
        data: { values: [undefined] },
      }),
    ).toThrow(/undefined/u);
  });
});
