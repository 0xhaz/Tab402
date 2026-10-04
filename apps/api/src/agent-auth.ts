import { verify } from "node:crypto";
import {
  AGENT_SIGNATURE_HEADER,
  AGENT_SIGNATURE_TOLERANCE_SECONDS,
  parseAgentSignature,
} from "@tab402/core";
import { apiKeyOwnerOf } from "@tab402/db";
import { createMiddleware } from "hono/factory";
import { base64url } from "jose";
import { apiKeyAuth } from "./auth";
import type { Deps, Env } from "./context";

/**
 * Accepts either an agent-signed request (the agent proves it holds its key) or a buyer API key
 * (server-side callers such as the buyer MCP). Sets `principal` to the buyer and `agentKeyId`.
 */
export function agentOrBuyerAuth(deps: Deps) {
  const buyerAuth = apiKeyAuth(deps.db, ["buyer"]);
  return createMiddleware<Env & { Variables: { agentKeyId?: string } }>(async (c, next) => {
    const header = c.req.header(AGENT_SIGNATURE_HEADER);
    if (!header) {
      if (!apiKeyOwnerOf((c.req.header("authorization") ?? "").replace(/^Bearer\s+/, ""))) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return buyerAuth(c, next);
    }
    const parsed = parseAgentSignature(header);
    const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    if (!parsed || Math.abs(nowSec - parsed.t) > AGENT_SIGNATURE_TOLERANCE_SECONDS)
      return c.json({ error: "unauthorized" }, 401);
    const key = await deps.keys.get(parsed.keyId);
    if (key?.status !== "active") return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.text();
    let ok = false;
    try {
      ok = verify(
        "sha256",
        Buffer.from(`${parsed.t}.${body}`),
        { key: key.publicKey, dsaEncoding: "ieee-p1363" },
        base64url.decode(parsed.sig),
      );
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", { ownerType: "buyer", ownerId: key.buyerId });
    c.set("agentKeyId", key.id);
    await next();
  });
}
