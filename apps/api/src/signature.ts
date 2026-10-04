import { createPublicKey, type KeyObject, verify } from "node:crypto";
import {
  canonicalBytes,
  type P256PublicJwk,
  type TabVoucherPayload,
  voucherFields,
} from "@tab402/core";
import { base64url } from "jose";

/**
 * Server-side voucher verification with native crypto: ~0.08 ms vs ~1.9 ms for @noble/curves
 * (packages/core/bench/verify.ts). Same bytes and rules as core's `verifyVoucherSignature`,
 * which stays the portable verifier for browsers and phones.
 */
export function publicKeyObject(jwk: P256PublicJwk): KeyObject {
  return createPublicKey({ key: { ...jwk }, format: "jwk" });
}

export function verifyVoucherNative(payload: TabVoucherPayload, key: KeyObject): boolean {
  try {
    const sig = base64url.decode(payload.signature);
    if (sig.length !== 64) return false;
    return verify(
      "sha256",
      canonicalBytes(voucherFields(payload)),
      { key, dsaEncoding: "ieee-p1363" },
      sig,
    );
  } catch {
    return false;
  }
}
