import { createHash, randomBytes } from "node:crypto";

export type ApiKeyOwner = "seller" | "buyer";

const PREFIX: Record<ApiKeyOwner, string> = { seller: "t402_sk_", buyer: "t402_bk_" };

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function apiKeyOwnerOf(key: string): ApiKeyOwner | null {
  if (key.startsWith(PREFIX.seller)) return "seller";
  if (key.startsWith(PREFIX.buyer)) return "buyer";
  return null;
}

/** New random key. The plaintext is shown once; store only `hash` and `prefix`. */
export function generateApiKey(owner: ApiKeyOwner): { key: string; hash: string; prefix: string } {
  const key = `${PREFIX[owner]}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: displayPrefix(key) };
}

export function displayPrefix(key: string): string {
  return `${key.slice(0, 12)}…`;
}
