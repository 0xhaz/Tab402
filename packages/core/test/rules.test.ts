import { describe, expect, it } from "vitest";
import { checkVoucherRules, meteredCharge, type VoucherCheckInput } from "../src/rules";

const NOW = 1_791_000_000;

type Overrides = Partial<Omit<VoucherCheckInput, "voucher">> & {
  voucher?: Partial<VoucherCheckInput["voucher"]>;
};

function input(over: Overrides = {}): VoucherCheckInput {
  return {
    channel: { lastSeq: 4, cumulativeRecorded: 40_000 },
    quote: { id: "q_1", amountMicros: 10_000, pricing: "fixed", expiresAt: NOW + 300, used: false },
    now: NOW,
    ...over,
    voucher: {
      channelId: "ch_1",
      keyId: "key_1",
      seq: 5,
      cumulative: "50000",
      quoteId: "q_1",
      expiresAt: NOW + 120,
      signature: "sig",
      ...over.voucher,
    },
  };
}

describe("checkVoucherRules", () => {
  it("accepts the next voucher on a channel", () => {
    expect(checkVoucherRules(input())).toEqual({
      ok: true,
      value: { cumulative: 50_000, authorized: 10_000 },
    });
  });

  it("accepts seq 1 on a new channel", () => {
    const res = checkVoucherRules(
      input({ channel: null, voucher: { seq: 1, cumulative: "10000" } }),
    );
    expect(res.ok).toBe(true);
  });

  it("allows over-authorization (metered max) and reports it", () => {
    const res = checkVoucherRules(input({ voucher: { cumulative: "90000" } }));
    expect(res).toEqual({ ok: true, value: { cumulative: 90_000, authorized: 50_000 } });
  });

  it.each<[string, Overrides, string]>([
    ["replayed seq", { voucher: { seq: 4 } }, "seq_mismatch"],
    ["skipped seq", { voucher: { seq: 6 } }, "seq_mismatch"],
    [
      "first voucher not seq 1",
      { channel: null, voucher: { seq: 2, cumulative: "10000" } },
      "seq_mismatch",
    ],
    ["cumulative too low", { voucher: { cumulative: "49999" } }, "insufficient_cumulative"],
    [
      "used quote",
      {
        quote: {
          id: "q_1",
          amountMicros: 10_000,
          pricing: "fixed",
          expiresAt: NOW + 300,
          used: true,
        },
      },
      "quote_used",
    ],
    [
      "expired quote",
      { quote: { id: "q_1", amountMicros: 10_000, pricing: "fixed", expiresAt: NOW, used: false } },
      "quote_expired",
    ],
    ["other quote", { voucher: { quoteId: "q_2" } }, "quote_mismatch"],
    ["expired voucher", { voucher: { expiresAt: NOW } }, "voucher_expired"],
    ["expiry beyond 5 min", { voucher: { expiresAt: NOW + 301 } }, "voucher_expiry_too_far"],
  ])("rejects %s", (_name, over, reason) => {
    expect(checkVoucherRules(input(over))).toMatchObject({ ok: false, reason });
  });
});

describe("meteredCharge", () => {
  it("records actual cost, capped by the quote max and the authorization", () => {
    expect(meteredCharge(12_345, 50_000, 50_000)).toBe(12_345);
    expect(meteredCharge(80_000, 50_000, 60_000)).toBe(50_000);
    expect(meteredCharge(40_000, 50_000, 30_000)).toBe(30_000);
    expect(() => meteredCharge(-1, 50_000, 50_000)).toThrow();
  });
});

describe("PAYMENT_REJECTIONS", () => {
  it("includes every voucher rejection", async () => {
    const { PAYMENT_REJECTIONS, VOUCHER_REJECTIONS } = await import("../src/rules");
    for (const r of VOUCHER_REJECTIONS) expect(PAYMENT_REJECTIONS).toContain(r);
  });
});
