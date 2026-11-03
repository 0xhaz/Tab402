/**
 * The browser tests' own database (never the dev one): created if missing, migrated, then seeded
 * with the demo seller and buyer. Run by playwright.config.ts before any server starts.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { sql } from "drizzle-orm";

const target = process.env.DATABASE_URL;
if (!target) throw new Error("DATABASE_URL is not set");
const name = new URL(target).pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);

const admin = new URL(target);
admin.pathname = "/postgres";
const { db, close } = createDb(admin.toString(), { max: 1 });
const exists = await db.execute(sql`select 1 from pg_database where datname = ${name}`);
if (exists.length === 0) await db.execute(sql.raw(`create database "${name}"`));
await close();

await runMigrations(target);
const seed = fileURLToPath(new URL("../../packages/db/src/seed.ts", import.meta.url));
execFileSync(process.execPath, ["--import", "tsx", seed], { stdio: "inherit", env: process.env });
