import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig, devices } from "@playwright/test";

// Root .env for DB/PayPal settings — but never NODE_ENV, which `next start` must own.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(rootEnv, "utf8"))))
    if (k !== "NODE_ENV" && process.env[k] === undefined) process.env[k] = v;
}

/**
 * Test servers get their own ports so `pnpm dev` (3000 / 4100) can keep running alongside.
 * Every URL the apps derive from is passed explicitly; the apps never override env that is set.
 */
export const WEB = "http://localhost:3300";
export const MCP = "http://localhost:4300";
const urls = { BETTER_AUTH_URL: WEB, WEB_URL: WEB, MCP_URL: `${MCP}/mcp` };

/** Browser tests against the production build of apps/web (pnpm --filter @tab402/web build first). */
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  fullyParallel: false,
  use: { baseURL: WEB, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @tab402/web exec next start --port 3300",
      url: `${WEB}/sign-in`,
      reuseExistingServer: false,
      // Deterministic onboarding proposals; AI turns are stubbed per test with page.route.
      env: { ...urls, TAB402_AUTH_RATE_LIMIT: "off", ONBOARDING_MODEL: "mock" },
      timeout: 120_000,
    },
    {
      // Buyer MCP server, for the OAuth connector flow.
      command: "pnpm --filter @tab402/mcp-buyer start",
      url: `${MCP}/health`,
      env: { ...urls, MCP_PORT: "4300" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
