import { describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "../src/headers";
import { generateAgentKeyPair, isP256PublicJwk, publicJwkToRaw, toPublicJwk } from "../src/keys";
import { parseTabPaymentPayload } from "../src/rules";
import {
  buildTabRequirements,
  isTabRequirements,
  TAB_NETWORKS,
  type TabVoucherFields,
} from "../src/scheme";
import { signVoucher, verifyVoucherSignature } from "../src/voucher";

const fields: TabVoucherFields = {
  channelId: "ch_7d1e",
  keyId: "key_3f9a",
  seq: 42,
  cumulative: "4210000",
  quoteId: "q_01JABC",
  expiresAt: 1_791_100_000,
};

const requirements = buildTabRequirements({
  network: TAB_NETWORKS.sandbox,
  amountMicros: 10_000,
  sellerId: "sel_8f2c",
  quoteId: "q_01JABC",
  pricing: "fixed",
  facilitatorUrl: "http://localhost:4000",
});

describe("voucher signatures", () => {
  it("round-trips sign → verify with JWK and raw keys", async () => {
    const { privateKey, publicJwk } = await generateAgentKeyPair();
    const voucher = await signVoucher(fields, privateKey);
    expect(verifyVoucherSignature(voucher, publicJwk)).toBe(true);
    expect(verifyVoucherSignature(voucher, publicJwkToRaw(publicJwk))).toBe(true);
  });

  it("verifies many signatures (covers WebCrypto high-S outputs)", async () => {
    const { privateKey, publicJwk } = await generateAgentKeyPair();
    for (let seq = 1; seq <= 40; seq++) {
      const v = await signVoucher({ ...fields, seq }, privateKey);
      expect(verifyVoucherSignature(v, publicJwk)).toBe(true);
    }
  });

  it.each<[keyof TabVoucherFields, unknown]>([
    ["seq", 43],
    ["cumulative", "4210001"],
    ["quoteId", "q_other"],
    ["channelId", "ch_other"],
    ["keyId", "key_other"],
    ["expiresAt", 1_791_100_001],
  ])("rejects a tampered %s", async (field, value) => {
    const { privateKey, publicJwk } = await generateAgentKeyPair();
    const voucher = await signVoucher(fields, privateKey);
    expect(verifyVoucherSignature({ ...voucher, [field]: value }, publicJwk)).toBe(false);
  });

  it("ignores unsigned extra properties but signs only the voucher fields", async () => {
    const { privateKey, publicJwk } = await generateAgentKeyPair();
    const voucher = await signVoucher({ ...fields, extra: "x" } as TabVoucherFields, privateKey);
    expect("extra" in voucher).toBe(false);
    expect(verifyVoucherSignature(voucher, publicJwk)).toBe(true);
  });

  it("rejects a signature from another key and garbage signatures", async () => {
    const a = await generateAgentKeyPair();
    const b = await generateAgentKeyPair();
    const voucher = await signVoucher(fields, a.privateKey);
    expect(verifyVoucherSignature(voucher, b.publicJwk)).toBe(false);
    expect(verifyVoucherSignature({ ...voucher, signature: "AAAA" }, a.publicJwk)).toBe(false);
    expect(verifyVoucherSignature({ ...voucher, signature: "!!not-base64!!" }, a.publicJwk)).toBe(
      false,
    );
  });
});

describe("keys", () => {
  it("strips private members and validates P-256", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = toPublicJwk(jwk);
    expect(pub).toEqual({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
    expect(isP256PublicJwk({ ...pub, crv: "P-384" })).toBe(false);
    expect(isP256PublicJwk({ ...pub, x: "short" })).toBe(false);
  });
});

describe("x402 v2 headers", () => {
  it("round-trips PAYMENT-REQUIRED with a tab entry", () => {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: "http://localhost:4200/v1/summarize", description: "Summarize text" },
      accepts: [requirements],
    });
    const decoded = decodePaymentRequiredHeader(header);
    expect(decoded.accepts[0]).toEqual(requirements);
    const [first] = decoded.accepts;
    expect(first && isTabRequirements(first)).toBe(true);
  });

  it("round-trips PAYMENT-SIGNATURE and parses it as a tab payload", async () => {
    const { privateKey } = await generateAgentKeyPair();
    const voucher = await signVoucher(fields, privateKey);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: requirements,
      payload: { ...voucher },
    });
    const parsed = parseTabPaymentPayload(decodePaymentSignatureHeader(header));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.payload).toEqual(voucher);
  });

  it("rejects payloads for other schemes or with mismatched quote", async () => {
    expect(
      parseTabPaymentPayload({
        x402Version: 2,
        accepted: { ...requirements, scheme: "exact" },
        payload: {},
      }).ok,
    ).toBe(false);
    const { privateKey } = await generateAgentKeyPair();
    const voucher = await signVoucher({ ...fields, quoteId: "q_other" }, privateKey);
    const res = parseTabPaymentPayload({
      x402Version: 2,
      accepted: requirements,
      payload: { ...voucher },
    });
    expect(res).toMatchObject({ ok: false, reason: "quote_mismatch" });
  });
});
