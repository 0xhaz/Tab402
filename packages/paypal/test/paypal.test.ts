import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  floorToCents,
  microsToPayPal,
  PAYPAL_BASE,
  PayPalClient,
  PayPalError,
  PayPalPayouts,
  PayPalWalletFunding,
  payPalToMicros,
  toCentLines,
  verifyWebhook,
} from "../src";

const BASE = PAYPAL_BASE.sandbox;
const seen: { method: string; path: string; headers: Headers; body: unknown }[] = [];
let tokenCalls = 0;

const server = setupServer(
  http.post(`${BASE}/v1/oauth2/token`, () => {
    tokenCalls++;
    return HttpResponse.json({ access_token: "A21-test", expires_in: 32400 });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

function record(method: string) {
  return async ({ request }: { request: Request }) => {
    seen.push({
      method,
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: await request
        .clone()
        .json()
        .catch(() => null),
    });
  };
}

const client = () => new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" });

describe("money", () => {
  it("converts whole cents both ways", () => {
    expect(microsToPayPal(10_000_000)).toBe("10.00");
    expect(microsToPayPal(10_000)).toBe("0.01");
    expect(microsToPayPal(1_234_560_000)).toBe("1234.56");
    expect(payPalToMicros("9.16")).toBe(9_160_000);
    expect(payPalToMicros("0.84")).toBe(840_000);
    expect(payPalToMicros("12")).toBe(12_000_000);
  });
  it("refuses sub-cent amounts and floors with a remainder", () => {
    expect(() => microsToPayPal(10_000_579)).toThrow();
    expect(floorToCents(10_030_579)).toEqual({ cents: 10_030_000, remainder: 579 });
  });
  it("builds item lines that sum exactly to the total", () => {
    const lines = toCentLines(
      [
        { description: "a", amountMicros: 6_004_321 },
        { description: "b", amountMicros: 4_026_258 },
      ],
      10_030_000,
    );
    expect(lines.reduce((a, l) => a + l.amountMicros, 0)).toBe(10_030_000);
    expect(lines.every((l) => l.amountMicros % 10_000 === 0)).toBe(true);
  });
});

describe("PayPalWalletFunding", () => {
  it("creates a setup token with MERCHANT usage and returns the approve link", async () => {
    server.use(
      http.post(`${BASE}/v3/vault/setup-tokens`, async (ctx) => {
        await record("POST")(ctx);
        return HttpResponse.json({
          id: "01K43991WG2869346",
          status: "PAYER_ACTION_REQUIRED",
          links: [
            {
              rel: "approve",
              href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=01K43991WG2869346",
            },
          ],
        });
      }),
    );
    const r = await new PayPalWalletFunding(client()).beginMandate({
      returnUrl: "http://x/r",
      cancelUrl: "http://x/c",
      description: "d",
    });
    expect(r.setupToken).toBe("01K43991WG2869346");
    expect(r.approveUrl).toContain("approval_session_id");
    expect(seen[0]?.body).toMatchObject({
      payment_source: { paypal: { usage_type: "MERCHANT", customer_type: "CONSUMER" } },
    });
  });

  it("exchanges an approved setup token for a vault token", async () => {
    server.use(
      http.post(`${BASE}/v3/vault/payment-tokens`, () =>
        HttpResponse.json({
          id: "39n06898mj1507128",
          customer: { id: "FqagOlEUrS" },
          payment_source: { paypal: { email_address: "buyer@personal.example.com" } },
        }),
      ),
    );
    expect(await new PayPalWalletFunding(client()).completeMandate("st")).toEqual({
      vaultToken: "39n06898mj1507128",
      payerEmail: "buyer@personal.example.com",
      customerId: "FqagOlEUrS",
    });
  });

  it("captures with vault_id, stored credential, risk header and an idempotency key", async () => {
    server.use(
      http.post(`${BASE}/v2/checkout/orders`, async (ctx) => {
        await record("POST")(ctx);
        return HttpResponse.json({
          id: "67Y40639UR069301W",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "5FD60598XT3223813",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "10.00" },
                    seller_receivable_breakdown: {
                      paypal_fee: { currency_code: "USD", value: "0.84" },
                      net_amount: { currency_code: "USD", value: "9.16" },
                    },
                  },
                ],
              },
            },
          ],
        });
      }),
    );
    const r = await new PayPalWalletFunding(client()).capture({
      vaultToken: "vault_1",
      amountMicros: 10_000_000,
      reference: "stl_1",
      description: "Tab402 tab",
      lines: [{ description: "Demo Sellers", amountMicros: 10_000_000 }],
      idempotencyKey: "stl_1",
    });
    expect(r).toEqual({
      status: "captured",
      orderId: "67Y40639UR069301W",
      captureId: "5FD60598XT3223813",
      grossMicros: 10_000_000,
      feeMicros: 840_000,
    });
    const call = seen[0];
    expect(call?.headers.get("paypal-request-id")).toBe("stl_1");
    expect(call?.headers.get("paypal-client-metadata-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(call?.body).toMatchObject({
      intent: "CAPTURE",
      payment_source: {
        paypal: {
          vault_id: "vault_1",
          stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" },
        },
      },
      purchase_units: [
        {
          reference_id: "stl_1",
          amount: { value: "10.00", breakdown: { item_total: { value: "10.00" } } },
        },
      ],
    });
  });

  it("maps a 422 INSTRUMENT_DECLINED to a declined result", async () => {
    server.use(
      http.post(`${BASE}/v2/checkout/orders`, () =>
        HttpResponse.json(
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] },
          { status: 422, headers: { "paypal-debug-id": "dbg1" } },
        ),
      ),
    );
    const r = await new PayPalWalletFunding(client()).capture({
      vaultToken: "v",
      amountMicros: 10_000,
      reference: "stl_2",
      description: "d",
      lines: [],
      idempotencyKey: "stl_2",
    });
    expect(r).toEqual({ status: "declined", orderId: null, reason: "INSTRUMENT_DECLINED" });
  });

  it("surfaces 5xx as PayPalError so the job retries", async () => {
    server.use(
      http.post(`${BASE}/v2/checkout/orders`, () =>
        HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
      ),
    );
    await expect(
      new PayPalWalletFunding(client()).capture({
        vaultToken: "v",
        amountMicros: 10_000,
        reference: "r",
        description: "d",
        lines: [],
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(PayPalError);
  });

  it("reuses the OAuth token across calls", async () => {
    tokenCalls = 0;
    server.use(
      http.get(`${BASE}/v1/payments/payouts/B1`, () =>
        HttpResponse.json({
          batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" },
          items: [],
        }),
      ),
    );
    const c = client();
    const p = new PayPalPayouts(c);
    await p.getBatch("B1");
    await p.getBatch("B1");
    expect(tokenCalls).toBe(1);
  });
});

describe("PayPalPayouts", () => {
  it("submits one batch with sender_item_ids and maps statuses and fees", async () => {
    server.use(
      http.post(`${BASE}/v1/payments/payouts`, async (ctx) => {
        await record("POST")(ctx);
        return HttpResponse.json(
          { batch_header: { payout_batch_id: "8HDUSKLDEZ7M8", batch_status: "PENDING" } },
          { status: 201 },
        );
      }),
      http.get(`${BASE}/v1/payments/payouts/8HDUSKLDEZ7M8`, () =>
        HttpResponse.json({
          batch_header: { payout_batch_id: "8HDUSKLDEZ7M8", batch_status: "SUCCESS" },
          items: [
            {
              payout_item_id: "PI1",
              transaction_status: "SUCCESS",
              payout_item_fee: { value: "0.25" },
              payout_item: { sender_item_id: "poi_1" },
            },
            {
              payout_item_id: "PI2",
              transaction_status: "UNCLAIMED",
              payout_item: { sender_item_id: "poi_2" },
            },
          ],
        }),
      ),
    );
    const p = new PayPalPayouts(client());
    const { batchId } = await p.payout("tab402-2026-10-05", [
      { itemId: "poi_1", receiver: "a@example.com", amountMicros: 5_900_000 },
      { itemId: "poi_2", receiver: "b@example.com", amountMicros: 20_000_000 },
    ]);
    expect(batchId).toBe("8HDUSKLDEZ7M8");
    expect(seen[0]?.headers.get("paypal-request-id")).toBe("tab402-2026-10-05");
    expect(seen[0]?.body).toMatchObject({
      sender_batch_header: { sender_batch_id: "tab402-2026-10-05" },
      items: [
        { receiver: "a@example.com", amount: { value: "5.90" }, sender_item_id: "poi_1" },
        { amount: { value: "20.00" } },
      ],
    });
    expect(await p.getBatch(batchId)).toEqual({
      batchId,
      status: "success",
      items: [
        { itemId: "poi_1", providerItemId: "PI1", status: "success", feeMicros: 250_000 },
        { itemId: "poi_2", providerItemId: "PI2", status: "unclaimed", feeMicros: 0 },
      ],
    });
  });
});

describe("verifyWebhook", () => {
  const headers = new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
    "paypal-transmission-id": "t1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-04T00:00:00Z",
  });

  it("asks PayPal to verify and trusts only SUCCESS", async () => {
    let status = "SUCCESS";
    server.use(
      http.post(`${BASE}/v1/notifications/verify-webhook-signature`, async (ctx) => {
        await record("POST")(ctx);
        return HttpResponse.json({ verification_status: status });
      }),
    );
    const body = JSON.stringify({
      id: "WH-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {},
    });
    expect(await verifyWebhook(client(), "WHID", headers, body)).toBe(true);
    expect(seen[0]?.body).toMatchObject({
      webhook_id: "WHID",
      transmission_id: "t1",
      webhook_event: { id: "WH-1" },
    });
    status = "FAILURE";
    expect(await verifyWebhook(client(), "WHID", headers, body)).toBe(false);
  });

  it("rejects without calling PayPal when signature headers are missing", async () => {
    expect(await verifyWebhook(client(), "WHID", new Headers(), "{}")).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
