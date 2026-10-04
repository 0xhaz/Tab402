/** Voucher signature verification cost: `npx tsx bench/verify.ts` (run from packages/core). */
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { base64url } from "jose";
import {
  canonicalBytes,
  generateAgentKeyPair,
  publicJwkToRaw,
  signVoucher,
  verifyVoucherSignature,
} from "../src/index";

const { privateKey, publicJwk } = await generateAgentKeyPair();
const v = await signVoucher(
  {
    channelId: "ch_1",
    keyId: "key_1",
    seq: 1,
    cumulative: "10000",
    quoteId: "q_1",
    expiresAt: 2e9,
  },
  privateKey,
);
const raw = publicJwkToRaw(publicJwk);
const N = 500;
for (let i = 0; i < 50; i++) verifyVoucherSignature(v, raw); // warm up
let t = performance.now();
for (let i = 0; i < N; i++) verifyVoucherSignature(v, raw);
console.log(`noble p256.verify: ${((performance.now() - t) / N).toFixed(3)} ms/op`);

const key = createPublicKey({ key: publicJwk, format: "jwk" });
const sig = base64url.decode(v.signature);
const { signature: _s, ...fields } = v;
const msg = canonicalBytes(fields);
for (let i = 0; i < 50; i++) nodeVerify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, sig);
t = performance.now();
for (let i = 0; i < N; i++) nodeVerify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, sig);
console.log(
  `node:crypto verify: ${((performance.now() - t) / N).toFixed(3)} ms/op  (valid=${nodeVerify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, sig)})`,
);
