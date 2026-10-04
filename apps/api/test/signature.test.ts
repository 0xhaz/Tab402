import { generateAgentKeyPair, signVoucher, verifyVoucherSignature } from "@tab402/core";
import { describe, expect, it } from "vitest";
import { publicKeyObject, verifyVoucherNative } from "../src/signature";

const fields = {
  channelId: "ch_1",
  keyId: "key_1",
  seq: 7,
  cumulative: "70000",
  quoteId: "q_1",
  expiresAt: 2_000_000_000,
};

describe("native voucher verification", () => {
  it("agrees with core's portable verifier on valid, tampered and foreign signatures", async () => {
    const a = await generateAgentKeyPair();
    const b = await generateAgentKeyPair();
    const keyA = publicKeyObject(a.publicJwk);
    for (let seq = 1; seq <= 30; seq++) {
      const v = await signVoucher({ ...fields, seq }, a.privateKey);
      const tampered = { ...v, cumulative: "1" };
      const foreign = await signVoucher({ ...fields, seq }, b.privateKey);
      for (const candidate of [v, tampered, foreign]) {
        expect(verifyVoucherNative(candidate, keyA)).toBe(
          verifyVoucherSignature(candidate, a.publicJwk),
        );
      }
      expect(verifyVoucherNative(v, keyA)).toBe(true);
    }
  });

  it("rejects malformed signatures", async () => {
    const a = await generateAgentKeyPair();
    const v = await signVoucher(fields, a.privateKey);
    const key = publicKeyObject(a.publicJwk);
    expect(verifyVoucherNative({ ...v, signature: "AAAA" }, key)).toBe(false);
    expect(verifyVoucherNative({ ...v, signature: "%%%" }, key)).toBe(false);
  });
});
