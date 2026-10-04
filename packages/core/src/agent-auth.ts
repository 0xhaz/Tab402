import { base64url } from "jose";

/**
 * Agent-signed API requests (e.g. POST /guard/decide): the agent proves it holds its key by signing
 *   `${t}.${body}` with ES256, sent as `Tab402-Agent-Signature: keyId=<id>,t=<unix>,sig=<base64url r||s>`.
 */
export const AGENT_SIGNATURE_HEADER = "Tab402-Agent-Signature";
export const AGENT_SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

export async function signAgentRequest(
  privateKey: CryptoKey,
  keyId: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(`${timestamp}.${body}`),
  );
  return `keyId=${keyId},t=${timestamp},sig=${base64url.encode(new Uint8Array(sig))}`;
}

export function parseAgentSignature(
  header: string | null | undefined,
): { keyId: string; t: number; sig: string } | null {
  if (!header) return null;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!parts.keyId || !parts.sig || !Number.isSafeInteger(t)) return null;
  return { keyId: parts.keyId, t, sig: parts.sig };
}
