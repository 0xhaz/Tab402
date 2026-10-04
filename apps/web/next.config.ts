import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

// One .env at the repo root for every service. Never override what's already set — in particular
// NODE_ENV, which Next sets itself (`next dev` vs `next build`/`start`).
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnv, "utf8")))) {
    if (key !== "NODE_ENV" && process.env[key] === undefined) process.env[key] = value;
  }
}

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@tab402/agents",
    "@tab402/auth",
    "@tab402/core",
    "@tab402/db",
    "@tab402/guard",
    "@tab402/ledger",
    "@tab402/notify",
    "@tab402/paypal",
  ],
  // Native/driver packages stay on the server, unbundled.
  serverExternalPackages: ["postgres"],
};

export default withSerwist(config);
