import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { AgentKeys } from "./agents";
import { authenticate } from "./auth";
import type { McpDeps } from "./context";
import { oauthHandler, protectedResourceMetadata } from "./oauth";
import { registerTools } from "./tools";

export const SERVER_INFO = {
  name: "tab402",
  title: "Tab402 — one agent wallet, any paid API",
  version: "0.1.0",
};

const INSTRUCTIONS = `Tab402 lets you pay for APIs per call on the user's tab.
1. search_services to find a paid API, 2. call_paid with a one-line intent, 3. get_budget / list_receipts to explain spending.
You can spend within the user's budget but never change it. Big or unusual purchases ask the user first.`;

/**
 * Remote buyer MCP server: Streamable HTTP at /mcp, one stateless server instance per request
 * (2026-07-28 spec; 2025 clients are served statelessly too). Accepts a buyer API key (Claude Code
 * `--header`) or an OAuth 2.1 access token from Tab402's authorization server (connectors).
 */
export function createMcpApp(deps: McpDeps) {
  const keys = new AgentKeys(deps.db, deps.masterKey);
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(SERVER_INFO, {
        instructions: INSTRUCTIONS,
        capabilities: { tools: {} },
      });
      registerTools(server, deps, keys);
      return server;
    },
    { legacy: "stateless" },
  );

  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: deps.allowedHosts ?? ["localhost", "127.0.0.1"],
  });
  app.get("/health", (c) => c.json({ ok: true, service: "mcp-buyer" }));

  if (deps.oauth) {
    const metadata = protectedResourceMetadata(deps.oauth);
    // RFC 9728: at the root and with the resource path appended.
    app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata));
    app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(metadata));
  }

  app.all("/mcp", async (c) => {
    const parsedBody = c.get("parsedBody" as never);
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (bearer.startsWith("t402_")) {
      const authInfo = await authenticate(deps.db, c.req.raw);
      if (authInfo) return handler.fetch(c.req.raw, { authInfo, parsedBody });
    }
    if (deps.oauth) {
      // OAuth access tokens; anything else gets the RFC 9728 challenge pointing at the metadata.
      const viaOAuth = oauthHandler(deps.db, deps.oauth, (req, authInfo) =>
        handler.fetch(req, { authInfo, parsedBody }),
      );
      return viaOAuth(c.req.raw);
    }
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized: send a Tab402 buyer API key as a Bearer token",
        },
        id: null,
      },
      401,
      { "WWW-Authenticate": 'Bearer realm="tab402"' },
    );
  });
  return app;
}
