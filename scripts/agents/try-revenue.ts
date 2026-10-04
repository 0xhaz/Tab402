/**
 * Ask the real revenue agent "Why did revenue drop on Tuesday?" against a seeded scenario (a price
 * increase that buyers' spend guards block). Same server path as the dashboard: runStudioTurn +
 * the tab402_* tools, in a minimal tool loop. Uses a scratch database; nothing touches dev data.
 *   npx tsx --env-file=.env scripts/agents/try-revenue.ts ["your question"]
 */
import Anthropic from "@anthropic-ai/sdk";
import { REVENUE_TOOLS, revenueTool, runStudioTurn, type StudioItem } from "@tab402/agents";
import { createDb } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { sql } from "drizzle-orm";
import { seedRevenueDrop } from "../../packages/agents/test/revenue-fixture";

const question = process.argv[2] ?? "Why did revenue drop on Tuesday?";
const url = await testDatabase("revenue_demo");
await runMigrations(url);
const { db, close } = createDb(url);
const tables = await db.execute<{ tablename: string }>(
  sql`select tablename from pg_tables where schemaname = 'public'`,
);
await db.execute(
  sql.raw(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`),
);
const { sellerId } = await seedRevenueDrop(db);

const client = new Anthropic();
const now = () => new Date("2026-10-04T12:00:00Z"); // a Sunday: "Tuesday" is 2026-09-29
const input: StudioItem[] = [
  { type: "message", kind: "input", role: "user", content: [{ type: "text", text: question }] },
];
let tokens = { in: 0, out: 0 };
for (let turn = 0; turn < 6; turn++) {
  const r = await runStudioTurn(
    client,
    {
      input,
      instructions:
        "You are a revenue analyst for an API seller. Answer in a short paragraph plus bullets.",
      tools: REVENUE_TOOLS.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    },
    { now },
  );
  tokens = { in: tokens.in + r.usage.inputTokens, out: tokens.out + r.usage.outputTokens };
  if (r.text) {
    input.push({
      type: "message",
      kind: "output",
      role: "assistant",
      content: [{ type: "text", text: r.text }],
    });
  }
  if (r.toolCalls.length === 0) {
    console.log(`\n${r.text}\n`);
    break;
  }
  for (const call of r.toolCalls) {
    console.log(`→ ${call.name}(${call.arguments})`);
    input.push({
      type: "function_call",
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    const out = await revenueTool(call.name)?.run(db, sellerId, JSON.parse(call.arguments));
    input.push({ type: "function_call_output", callId: call.id, output: JSON.stringify(out) });
  }
}
console.log(
  `tokens ${tokens.in}/${tokens.out} · ≈$${((tokens.in * 3 + tokens.out * 15) / 1e6).toFixed(4)}`,
);
await close();
