import { p256 } from "@noble/curves/nist.js";
import { base64url } from "jose";
import { canonicalBytes } from "./canonical";
import { type P256PublicJwk, publicJwkToRaw } from "./keys";
import type { TabVoucherFields, TabVoucherPayload } from "./scheme";

/** Only the signed fields, in a fresh object — extra properties must never leak into the signed bytes. */
export function voucherFields(v: TabVoucherFields): TabVoucherFields {
  return {
    channelId: v.channelId,
    keyId: v.keyId,
    seq: v.seq,
    cumulative: v.cumulative,
    quoteId: v.quoteId,
    expiresAt: v.expiresAt,
  };
}

export async function signVoucher(
  fields: TabVoucherFields,
  privateKey: CryptoKey,
): Promise<TabVoucherPayload> {
  const signed = voucherFields(fields);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    canonicalBytes(signed) as Uint8Array<ArrayBuffer>,
  );
  return { ...signed, signature: base64url.encode(new Uint8Array(sig)) };
}

/**
 * Verify the ES256 signature on a voucher. Hot path: synchronous, uses @noble/curves.
 * High-S signatures are accepted (WebCrypto doesn't normalize); replay is blocked by seq/quoteId.
 */
export function verifyVoucherSignature(
  payload: TabVoucherPayload,
  publicKey: P256PublicJwk | Uint8Array,
): boolean {
  try {
    const sig = base64url.decode(payload.signature);
    if (sig.length !== 64) return false;
    const raw = publicKey instanceof Uint8Array ? publicKey : publicJwkToRaw(publicKey);
    return p256.verify(sig, canonicalBytes(voucherFields(payload)), raw, { lowS: false });
  } catch {
    return false;
  }
}
