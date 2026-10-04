import type { AuthInfo } from "@modelcontextprotocol/server";
import { apiKeyOwnerOf, type Database, hashApiKey } from "@tab402/db";
import type { Caller } from "./context";

export const AGENT_HEADER = "x-tab402-agent";
const DEFAULT_AGENT = "MCP agent";

/**
 * Resolve the bearer token. Today: a buyer API key (`t402_bk_…`) plus an optional agent name
 * header — what `claude mcp add --header` sends. OAuth 2.1 access tokens (Phase 5, Better Auth)
 * resolve to the same Caller.
 */
export async function authenticate(db: Database, req: Request): Promise<AuthInfo | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (apiKeyOwnerOf(token) !== "buyer") return null;
  const row = await db.query.apiKeys.findFirst({
    where: (k, { eq }) => eq(k.hash, hashApiKey(token)),
  });
  if (!row || row.revokedAt || row.ownerType !== "buyer") return null;
  const agentName =
    (req.headers.get(AGENT_HEADER) ?? DEFAULT_AGENT).trim().slice(0, 64) || DEFAULT_AGENT;
  const caller: Caller = { buyerId: row.ownerId, agentName };
  return { token, clientId: agentName, scopes: ["tab402:pay"], extra: { caller } };
}

export function callerOf(authInfo: AuthInfo | undefined): Caller {
  const caller = (authInfo?.extra as { caller?: Caller } | undefined)?.caller;
  if (!caller) throw new Error("unauthenticated");
  return caller;
}
