import { serve } from "@hono/node-server";
import { createDb, parseMasterKey } from "@tab402/db";
import { createMcpApp } from "./app";
import { logger } from "./logger";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const port = Number(process.env.MCP_PORT ?? 4100);
const web = (process.env.BETTER_AUTH_URL ?? process.env.WEB_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const { db } = createDb(env("DATABASE_URL"));

const app = createMcpApp({
  db,
  masterKey: parseMasterKey(env("TAB402_MASTER_KEY")),
  approvalBaseUrl: `${process.env.WEB_URL ?? "http://localhost:3000"}/approve`,
  allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()),
  // OAuth 2.1 for connectors: tokens from the web app's authorization server, bound to this URL.
  oauth: {
    issuer: `${web}/api/auth`,
    resource: process.env.MCP_URL ?? `http://localhost:${port}/mcp`,
    jwksUrl: `${web}/api/auth/jwks`,
  },
});

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, url: `http://localhost:${info.port}/mcp` }, "mcp-buyer listening");
});
