import { expect, type Page } from "@playwright/test";
import { createDb, schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";

// Spec files share a worker, and each closes the pool in afterAll. Closing swaps in a fresh pool
// (postgres.js connects lazily), and importers see it through the live `db` binding.
const connect = () => createDb(process.env.DATABASE_URL ?? "", { max: 2 });
let pool = connect();
export let db: ReturnType<typeof connect>["db"] = pool.db;

export async function close() {
  const old = pool;
  pool = connect();
  db = pool.db;
  await old.close();
}

export async function signUp(page: Page, name = "Pat Buyer") {
  const email = `pw${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${name.split(" ")[0]}` })).toBeVisible();
  const [row] = await db
    .select({ buyerId: s.buyers.id, userId: s.user.id })
    .from(s.buyers)
    .innerJoin(s.user, eq(s.user.id, s.buyers.userId))
    .where(eq(s.user.email, email));
  if (!row) throw new Error("buyer was not created on sign-up");
  return { email, ...row };
}
