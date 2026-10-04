import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { generateAgentKeyPair, newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

type Turn = {
  input: { type: string; callId?: string; output?: string }[];
  tools?: { name: string }[];
  instructions?: string;
};

/**
 * The AG Studio AI panel runs on Claude through /api/ai/turn. Here the model is stubbed (no API
 * cost, deterministic) but everything else is real: AG Studio's agent loop, our adapter, and the
 * revenue tool route reading this seller's ledger.
 */
test("seller asks the AI assistant; it calls a Tab402 revenue tool and answers from the ledger", async ({
  page,
}) => {
  const { userId, buyerId } = await signUp(page, "Ana Seller");
  const sellerId = newId("seller");
  await db.insert(s.sellers).values({ id: sellerId, userId, name: "Ana's API" });
  // One earned charge of $0.25 so the tool has something to report.
  const endpointId = newId("endpoint");
  await db.insert(s.endpoints).values({
    id: endpointId,
    sellerId,
    method: "POST",
    url: "https://ana.example/v1/x",
    pricingMode: "fixed",
    priceMicros: 250_000,
  });
  const agentId = newId("agent");
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "Bot" });
  const keyId = newId("agentKey");
  await db
    .insert(s.agentKeys)
    .values({ id: keyId, agentId, buyerId, publicJwk: (await generateAgentKeyPair()).publicJwk });
  const channelId = newId("channel");
  await db
    .insert(s.channels)
    .values({ id: channelId, agentKeyId: keyId, sellerId, cumulativeAuthorizedMicros: 1e9 });
  const quoteId = newId("quote");
  await db.insert(s.quotes).values({
    id: quoteId,
    endpointId,
    sellerId,
    amountMicros: 250_000,
    pricingMode: "fixed",
    status: "paid",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const voucherId = newId("voucher");
  await db.insert(s.vouchers).values({
    id: voucherId,
    channelId,
    seq: 1,
    cumulativeMicros: 250_000,
    quoteId,
    expiresAt: new Date(),
    signature: "x",
  });
  await db.insert(s.charges).values({
    id: newId("charge"),
    buyerId,
    agentKeyId: keyId,
    sellerId,
    endpointId,
    quoteId,
    channelId,
    voucherId,
    amountMicros: 250_000,
    authorizedMicros: 250_000,
  });

  const turns: Turn[] = [];
  await page.route("**/api/ai/turn", async (route) => {
    const req = route.request().postDataJSON() as Turn;
    turns.push(req);
    const result = req.input.find(
      (i) => i.type === "function_call_output" && i.callId === "call_1",
    );
    const body = result
      ? {
          id: "msg_2",
          model: "stub",
          text: `You have $${(JSON.parse(JSON.parse(result.output ?? "{}").response ?? "{}") as { earnedUsd?: number }).earnedUsd} earned on buyers' tabs, not charged yet.`,
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 10 },
        }
      : {
          id: "msg_1",
          model: "stub",
          text: "",
          toolCalls: [{ id: "call_1", name: "tab402_money_states", arguments: "{}" }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 10 },
        };
    await route.fulfill({ json: body });
  });

  await page.goto("/selling/analytics");
  await page.getByRole("button", { name: "Edit / Ask AI" }).click();
  await page.getByRole("button", { name: "Where's my money?" }).click();
  await expect(
    page.getByText("You have $0.25 earned on buyers' tabs, not charged yet."),
  ).toBeVisible({
    timeout: 20_000,
  });

  // The lead agent's first turn offered Claude AG Studio's tools (queries go via delegate_to → data agent) and ours.
  // Saved for scripts/agents/replay-studio-turn.ts (checks AG Studio's schemas against the real API).
  await writeFile("test-results/ag-studio-turn.json", JSON.stringify(turns[0]));
  const names = turns[0]?.tools?.map((t) => t.name) ?? [];
  expect(names).toEqual(
    expect.arrayContaining([
      "tab402_revenue_change",
      "tab402_money_states",
      "view_schema",
      "delegate_to",
    ]),
  );
  expect(turns[0]?.instructions?.length).toBeGreaterThan(100);
});

test("the AI routes need a session, and tools only read the caller's own seller data", async ({
  request,
  page,
}) => {
  expect(
    (await request.post("/api/ai/turn", { data: { input: [] }, maxRedirects: 0 })).status(),
  ).not.toBe(200);
  // A signed-in buyer who doesn't sell gets 403 from the revenue tools.
  await signUp(page, "Bo Buyer");
  const res = await page.request.post("/api/ai/tools/tab402_money_states", { data: {} });
  expect(res.status()).toBe(403);
  expect((await page.request.post("/api/ai/tools/drop_tables", { data: {} })).status()).toBe(404);
});
