import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { type Database, schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import type { Caller, McpDeps } from "./context";

export const PAY_SCOPE = "tab402:pay";

/** RFC 9728 protected resource metadata: tells MCP clients which authorization server to use. */
export function protectedResourceMetadata(oauth: NonNullable<McpDeps["oauth"]>) {
  return {
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    scopes_supported: [PAY_SCOPE, "openid", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Tab402 — one agent wallet, any paid API",
  };
}

/**
 * Verify an OAuth access token (JWT via the authorization server's JWKS: signature, issuer,
 * audience = this MCP resource, `tab402:pay` scope) and map it to a Caller: the token's user is
 * the buyer; the connecting app (OAuth client) is the agent.
 */
export function oauthHandler(
  db: Database,
  oauth: NonNullable<McpDeps["oauth"]>,
  serve: (req: Request, authInfo: AuthInfo) => Promise<Response>,
) {
  const clientNames = new Map<string, string>();
  return createMcpProtectedRequestHandler(
    {
      issuer: oauth.issuer,
      audience: oauth.resource,
      jwksUrl: oauth.jwksUrl,
      requiredScopes: [PAY_SCOPE],
    },
    async (req, claims) => {
      const userId = typeof claims.sub === "string" ? claims.sub : "";
      const buyer = userId
        ? await db.query.buyers.findFirst({ where: (b, { eq }) => eq(b.userId, userId) })
        : undefined;
      if (!buyer)
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "No Tab402 buyer account for this user" },
            id: null,
          },
          { status: 403 },
        );

      const clientId = String(claims.azp ?? claims.client_id ?? "oauth-client");
      let name = clientNames.get(clientId);
      if (!name) {
        const [client] = await db
          .select({ name: s.oauthClient.name })
          .from(s.oauthClient)
          .where(eq(s.oauthClient.clientId, clientId));
        name = (client?.name ?? clientId).slice(0, 64);
        clientNames.set(clientId, name);
      }
      const caller: Caller = { buyerId: buyer.id, agentName: name };
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
      return serve(req, { token, clientId, scopes, expiresAt: claims.exp, extra: { caller } });
    },
  );
}
