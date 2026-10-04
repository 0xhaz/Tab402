import { createDb } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revenueTool, type StudioItem, ToolInputError, today, toMessages } from "../src";
import { BASELINE_DAY, DROP_DAY, seedRevenueDrop } from "./revenue-fixture";

const url = await testDatabase("agents_revenue");
await runMigrations(url);
const { db, close } = createDb(url, { max: 4 });
afterAll(close);

let sellerId: string;
let otherSellerId: string;
beforeAll(async () => {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  await db.execute(
    sql.raw(
      `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
    ),
  );
  ({ sellerId } = await seedRevenueDrop(db));
  ({ sellerId: otherSellerId } = await seedRevenueDrop(db));
});

type Change = {
  totals: { revenueUsd: number; baselineRevenueUsd: number; changePct: number };
  drivers: { endpoint: string; revenueDeltaUsd: number; paidCallsDelta: number }[];
  day: {
    endpoints: {
      endpoint: string;
      conversion: number;
      walkedAway: number;
      avgQuotedPriceUsd: number;
    }[];
    blockedByBuyerGuards: { rule: string; count: number; amountUsd: number }[];
    activeBuyers: number;
  };
};

describe("revenue tools", () => {
  it("revenue_change finds the drop, its endpoint, and the guard rule behind it", async () => {
    const r = (await revenueTool("tab402_revenue_change")?.run(db, sellerId, {
      day: DROP_DAY,
    })) as Change;
    // Baseline: 100 × $0.01 + 40 × $0.03 = $2.20. Drop day: 96 × $0.01 + 8 × $0.03 = $1.20.
    expect(r.totals).toEqual({ revenueUsd: 1.2, baselineRevenueUsd: 2.2, changePct: -45.5 });
    expect(r.drivers[0]).toEqual({
      endpoint: "POST https://api.acme.example/v1/chat",
      revenueDeltaUsd: -0.96,
      paidCallsDelta: -32,
      quotesDelta: -2,
    });
    expect(r.day.blockedByBuyerGuards).toEqual([
      {
        endpoint: "POST https://api.acme.example/v1/chat",
        rule: "deny.per_call_max",
        outcome: "deny",
        count: 30,
        amountUsd: 45,
      },
    ]);
    const chat = r.day.endpoints.find((e) => e.endpoint.endsWith("/chat"));
    expect(chat?.conversion).toBeCloseTo(8 / 42);
    expect(chat?.avgQuotedPriceUsd).toBe(1.5); // the price increase, visible to the agent
    expect(r.day.activeBuyers).toBe(4);
  });

  it("explicit baseline and input validation", async () => {
    const tool = revenueTool("tab402_revenue_change");
    const same = (await tool?.run(db, sellerId, { day: DROP_DAY, compare_to: DROP_DAY })) as Change;
    expect(same.totals.changePct).toBe(0);
    await expect(tool?.run(db, sellerId, { day: "Tuesday" })).rejects.toThrow(ToolInputError);
    await expect(tool?.run(db, sellerId, { day: "2026-02-31" })).resolves.toBeDefined(); // JS rolls over; still a date
    await expect(tool?.run(db, sellerId, { day: BASELINE_DAY, compare_to: "x" })).rejects.toThrow(
      /compare_to/,
    );
  });

  it("money_states splits by state and only ever reads the given seller", async () => {
    const m = (await revenueTool("tab402_money_states")?.run(db, sellerId, {})) as Record<
      string,
      unknown
    >;
    expect(m).toMatchObject({
      earnedUsd: 1.2,
      collectedUsd: 3.1,
      paidOutUsd: 0,
      openDisputes: 0,
      lastPayout: null,
    });
    const other = (await revenueTool("tab402_money_states")?.run(db, otherSellerId, {})) as Record<
      string,
      unknown
    >;
    expect(other.earnedUsd).toBe(1.2); // same fixture, separate seller — not 2.4
  });
});

describe("AG Studio → Messages mapping", () => {
  it("merges same-role items, maps tool calls/results, lifts system messages, drops reasoning", () => {
    const input: StudioItem[] = [
      {
        type: "message",
        kind: "input",
        role: "system",
        content: [{ type: "text", text: "be brief" }],
      },
      {
        type: "message",
        kind: "input",
        role: "user",
        content: [{ type: "text", text: "Why did revenue drop?" }],
      },
      { type: "reasoning" },
      {
        type: "message",
        kind: "output",
        role: "assistant",
        content: [{ type: "text", text: "Checking." }],
      },
      {
        type: "function_call",
        callId: "c1",
        name: "tab402_revenue_change",
        arguments: '{"day":"2026-09-29"}',
      },
      { type: "function_call", callId: "c2", name: "view_schema", arguments: "not json" },
      { type: "function_call_output", callId: "c1", output: '{"success":true}' },
      { type: "function_call_output", callId: "c2", output: '{"success":false}' },
    ];
    const { system, messages } = toMessages(input);
    expect(system).toEqual(["be brief"]);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Why did revenue drop?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_use",
            id: "c1",
            name: "tab402_revenue_change",
            input: { day: "2026-09-29" },
          },
          { type: "tool_use", id: "c2", name: "view_schema", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: '{"success":true}' },
          { type: "tool_result", tool_use_id: "c2", content: '{"success":false}' },
        ],
      },
    ]);
  });

  it("starts with a user turn and tells the model today's date", () => {
    const { messages } = toMessages([
      {
        type: "message",
        kind: "output",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    ]);
    expect(messages[0]?.role).toBe("user");
    expect(today(new Date("2026-10-04T12:00:00Z"))).toBe("Today is Sunday 2026-10-04 (UTC).");
  });
});
