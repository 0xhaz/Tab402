import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { newId } from "@tab402/core";
import { type Database, schema as s } from "@tab402/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { and, eq, isNull } from "drizzle-orm";

export interface AuthConfig {
  /** Omitted only for schema generation (Better Auth then runs in memory). */
  db?: Database;
  /** Public URL of the web app that serves /api/auth (the authorization server). */
  baseURL: string;
  secret: string;
  /** Canonical URL of the buyer MCP server — OAuth access tokens are audience-bound to it. */
  mcpResource: string;
  /** Extra origins allowed to call the auth API (e.g. the MCP server during development). */
  trustedOrigins?: string[];
  /** Better Auth's rate limiter (on by default in production). Browser tests turn it off. */
  rateLimit?: boolean;
  /** Next.js cookie helper plugin, passed in by the web app so this package stays framework-free. */
  extraPlugins?: Parameters<typeof betterAuth>[0]["plugins"];
}

/**
 * Tab402 auth: dashboard sign-in (email + password, passkeys), and the OAuth
 * 2.1 authorization server for the remote buyer MCP via `@better-auth/mcp` (RFC 9728 metadata,
 * PKCE, audience-bound tokens, Dynamic Client Registration for Claude connectors).
 * Every new user gets a buyer account with the default spending policy.
 */
export function createAuth(config: AuthConfig) {
  const web = new URL(config.baseURL);
  return betterAuth({
    appName: "Tab402",
    baseURL: config.baseURL,
    secret: config.secret,
    ...(config.db
      ? { database: drizzleAdapter(config.db, { provider: "pg", schema: s, usePlural: false }) }
      : {}),
    trustedOrigins: [config.baseURL, ...(config.trustedOrigins ?? [])],
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    ...(config.rateLimit === false ? { rateLimit: { enabled: false } } : {}),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            if (!config.db) return;
            // Claim an existing buyer with this email that has no login yet (e.g. created via the API);
            // otherwise open a new buyer account with the default spending policy.
            const claimed = await config.db
              .update(s.buyers)
              .set({ userId: user.id })
              .where(and(eq(s.buyers.email, user.email), isNull(s.buyers.userId)))
              .returning({ id: s.buyers.id });
            if (claimed.length > 0) return;
            const buyerId = newId("buyer");
            await config.db.insert(s.buyers).values({
              id: buyerId,
              userId: user.id,
              name: user.name || user.email,
              email: user.email,
            });
            await config.db.insert(s.policies).values({ buyerId });
          },
        },
      },
    },
    plugins: [
      passkey({ rpID: web.hostname, rpName: "Tab402", origin: web.origin }),
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: config.mcpResource,
        scopes: ["openid", "profile", "email", "offline_access", "tab402:pay"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultScopes: ["openid", "offline_access", "tab402:pay"],
      }),
      ...(config.extraPlugins ?? []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
