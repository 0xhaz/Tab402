import "server-only";
import { createAuth } from "@tab402/auth";
import { createDb, schema as s } from "@tab402/db";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (see .env.example)`);
  return v;
};

// One pool and one auth instance per server process (survives dev hot reloads).
const globals = globalThis as unknown as {
  __tab402?: { db: ReturnType<typeof createDb>["db"]; auth: ReturnType<typeof createAuth> };
};

function init() {
  const { db } = createDb(env("DATABASE_URL"), { max: 10 });
  const auth = createAuth({
    db,
    baseURL: env("BETTER_AUTH_URL"),
    secret: env("BETTER_AUTH_SECRET"),
    mcpResource: env("MCP_URL"),
    // Test-only escape hatch: browser tests sign up many users from one IP.
    rateLimit: process.env.TAB402_AUTH_RATE_LIMIT !== "off",
    extraPlugins: [nextCookies()],
  });
  return { db, auth };
}

/** Created on first use, not at import — build workers that never serve auth don't touch the database. */
function instance() {
  globals.__tab402 ??= init();
  return globals.__tab402;
}

type Db = ReturnType<typeof init>["db"];
type AuthInstance = ReturnType<typeof init>["auth"];

/** Lazy stand-in that behaves like the real object for property access and `in` checks. */
function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get: (_t, p) => Reflect.get(resolve(), p, resolve()),
    has: (_t, p) => Reflect.has(resolve(), p),
  });
}

export const db: Db = lazy(() => instance().db);
export const auth: AuthInstance = lazy(() => instance().auth);
export const getAuth = (): AuthInstance => instance().auth;

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** The signed-in user and their buyer account, or a redirect to sign-in. */
export async function requireBuyer(returnTo = "/") {
  const session = await getSession();
  if (!session) redirect(`/sign-in?callbackURL=${encodeURIComponent(returnTo)}`);
  const buyer = await db.query.buyers.findFirst({
    where: (b, { eq }) => eq(b.userId, session.user.id),
  });
  if (!buyer) throw new Error("no buyer account for this user");
  return { session, user: session.user, buyer };
}

export async function sellerFor(userId: string) {
  return (await db.select().from(s.sellers).where(eq(s.sellers.userId, userId)))[0] ?? null;
}
