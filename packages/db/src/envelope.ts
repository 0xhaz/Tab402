import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope encryption for merchant secrets and vault tokens.
 * A fresh data key per secret, wrapped by the master key. The owner id and kind are bound as
 * additional authenticated data, so a blob can't be moved to another merchant or slot.
 *
 * Blob: v1.<iv>.<tag>.<ciphertext>.<wrapIv>.<wrapTag>.<wrappedKey> (base64url parts)
 * Rotation: re-wrap the data key under a new master key; the ciphertext doesn't change.
 */

const VERSION = "v1";

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64(s: string | undefined): Buffer {
  if (!s) throw new Error("malformed secret blob");
  return Buffer.from(s, "base64url");
}

export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("TAB402_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aadFor(ownerId: string, kind: string): Buffer {
  return Buffer.from(`tab402:${ownerId}:${kind}`, "utf8");
}

export function sealSecret(
  masterKey: Buffer,
  ownerId: string,
  kind: string,
  plaintext: string,
): string {
  const aad = aadFor(ownerId, kind);
  const dataKey = randomBytes(32);
  try {
    const data = gcmEncrypt(dataKey, Buffer.from(plaintext, "utf8"), aad);
    const wrap = gcmEncrypt(masterKey, dataKey, aad);
    return [VERSION, data.iv, data.tag, data.ciphertext, wrap.iv, wrap.tag, wrap.ciphertext]
      .map((p) => (typeof p === "string" ? p : b64(p)))
      .join(".");
  } finally {
    dataKey.fill(0);
  }
}

export function openSecret(masterKey: Buffer, ownerId: string, kind: string, blob: string): string {
  const [version, iv, tag, ct, wrapIv, wrapTag, wrapped] = blob.split(".");
  if (version !== VERSION) throw new Error("unsupported secret blob version");
  const aad = aadFor(ownerId, kind);
  const dataKey = gcmDecrypt(masterKey, unb64(wrapIv), unb64(wrapTag), unb64(wrapped), aad);
  try {
    return gcmDecrypt(dataKey, unb64(iv), unb64(tag), unb64(ct), aad).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** Re-wrap a blob's data key under a new master key without touching the ciphertext. */
export function rewrapSecret(
  oldKey: Buffer,
  newKey: Buffer,
  ownerId: string,
  kind: string,
  blob: string,
): string {
  const parts = blob.split(".");
  const [version, iv, tag, ct, wrapIv, wrapTag, wrapped] = parts;
  if (version !== VERSION || parts.length !== 7) throw new Error("unsupported secret blob version");
  const aad = aadFor(ownerId, kind);
  const dataKey = gcmDecrypt(oldKey, unb64(wrapIv), unb64(wrapTag), unb64(wrapped), aad);
  try {
    const wrap = gcmEncrypt(newKey, dataKey, aad);
    return [VERSION, iv, tag, ct, b64(wrap.iv), b64(wrap.tag), b64(wrap.ciphertext)].join(".");
  } finally {
    dataKey.fill(0);
  }
}
