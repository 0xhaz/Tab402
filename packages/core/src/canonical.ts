import canonicalize from "canonicalize";

/** RFC 8785 (JCS) canonical JSON — the exact bytes a voucher signature covers. */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError("value cannot be canonicalized");
  return out;
}

const encoder = new TextEncoder();

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}
