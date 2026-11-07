/**
 * Take the Text Tools demo API back to "not onboarded", so the seller scene of the video can be
 * recorded again from a clean start. Its routes are switched off, not deleted, so past receipts
 * keep their endpoint; confirming onboarding again switches them back on.
 *
 *   npx tsx --env-file=.env scripts/demo/reset-text-tools.ts
 * For the hosted demo, set DATABASE_URL to the tab402-db External Database URL and
 * DEMO_SELLERS_URL to https://tab402-sellers.onrender.com.
 */
import { createDb, schema as s } from "@tab402/db";
import { and, eq, like } from "drizzle-orm";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is not set");
const base = (process.env.DEMO_SELLERS_URL ?? "http://localhost:4200").replace(/\/+$/, "");

const { db, close } = createDb(dbUrl);
try {
  const off = await db
    .update(s.endpoints)
    .set({ active: false })
    .where(and(eq(s.endpoints.active, true), like(s.endpoints.url, `${base}/tools/%`)))
    .returning({ method: s.endpoints.method, url: s.endpoints.url });
  if (off.length === 0)
    console.log(`Text Tools at ${base}/tools has no live routes. Nothing to do.`);
  else {
    console.log(`Switched off ${off.length} Text Tools route(s):`);
    for (const e of off) console.log(`  ${e.method} ${e.url}`);
  }
} finally {
  await close();
}
