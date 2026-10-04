import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/webhooks";

const body = JSON.stringify({
  id: "evt_1",
  type: "tab.settled",
  created: 1_791_000_000,
  api_version: "2026-10-01",
  data: {},
});

describe("merchant webhook signatures", () => {
  it("matches a plain HMAC-SHA256 implementation", async () => {
    const header = await signWebhook("whsec_test", body, 1_791_000_000);
    const expected = createHmac("sha256", "whsec_test").update(`1791000000.${body}`).digest("hex");
    expect(header).toBe(`t=1791000000,v1=${expected}`);
  });

  it("verifies within the 5-minute window and rejects tampering, wrong secret and stale events", async () => {
    const header = await signWebhook("whsec_test", body, 1_791_000_000);
    expect(await verifyWebhookSignature("whsec_test", header, body, 1_791_000_100)).toBe(true);
    expect(await verifyWebhookSignature("whsec_test", header, `${body} `, 1_791_000_100)).toBe(
      false,
    );
    expect(await verifyWebhookSignature("whsec_other", header, body, 1_791_000_100)).toBe(false);
    expect(await verifyWebhookSignature("whsec_test", header, body, 1_791_000_301)).toBe(false);
    expect(await verifyWebhookSignature("whsec_test", "garbage", body, 1_791_000_000)).toBe(false);
    expect(await verifyWebhookSignature("whsec_test", null, body)).toBe(false);
  });
});
