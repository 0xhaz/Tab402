import { newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { JOBS } from "@tab402/ledger";
import { topicFor } from "@tab402/notify";
import { PaymentError, registerAgentKey, Tab402Client } from "@tab402/sdk-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, SELLERS } from "./harness";

const h = await createHarness();
afterAll(h.close);

const DAY = 24 * 3600_000;
const body = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Notify me. Please." }),
};

/** Give an account a web user with one subscribed phone. */
async function phone(owner: { buyerId?: string; sellerId?: string }, endpoint: string) {
  const userId = `usr_${newId("agent").slice(-10)}`;
  await h.db.insert(s.user).values({ id: userId, name: "Pat", email: `${userId}@example.com` });
  if (owner.buyerId)
    await h.db.update(s.buyers).set({ userId }).where(eq(s.buyers.id, owner.buyerId));
  if (owner.sellerId)
    await h.db.update(s.sellers).set({ userId }).where(eq(s.sellers.id, owner.sellerId));
  await h.db
    .insert(s.pushSubscriptions)
    .values({ id: newId("pushSubscription"), userId, endpoint, p256dh: "p", auth: "a" });
  return userId;
}

async function agent() {
  const a = await registerAgentKey({
    apiUrl: API,
    buyerApiKey: h.buyerKey,
    agentName: "Claude Desktop",
    fetch: h.router,
  });
  return new Tab402Client({ keyId: a.keyId, privateKey: a.privateKey, fetch: h.router });
}

const policy = (approvalThreshold: string) =>
  h.router(`${API}/policy`, {
    method: "PUT",
    headers: { authorization: `Bearer ${h.buyerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ approvalThreshold }),
  });

describe("push notifications", () => {
  let ids: Awaited<ReturnType<typeof h.reset>>;
  beforeEach(async () => {
    ids = await h.reset({ mode: "postpaid" });
  });

  it("an over-threshold purchase pushes 'Approve $… for …?' to the buyer's phone, linking the approval page", async () => {
    await phone({ buyerId: ids.buyerId }, "https://fcm.googleapis.com/fcm/send/pat-phone");
    await policy("5000");
    const client = await agent();
    const err = await client
      .fetch(`${SELLERS}/v1/summarize`, body, { intent: "summarize the board deck" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    const approvalId = (err as PaymentError).approval?.id ?? "";

    await h.worker[JOBS.pushSend]();
    expect(h.push.sent).toHaveLength(1);
    const [sent] = h.push.sent;
    expect(sent?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/pat-phone");
    expect(sent?.payload).toMatchObject({
      kind: "approval.requested",
      title: "Approve $0.01 for Demo Sellers?",
      body: "Claude Desktop: summarize the board deck",
      url: `/approve/${approvalId}`,
      tag: approvalId,
    });
    expect(sent?.options).toMatchObject({ urgency: "high", topic: topicFor(approvalId) });
    expect(sent?.options.ttlSeconds).toBeLessThanOrEqual(15 * 60);

    // The agent retrying before the human answers reuses the request: no second push.
    await client
      .fetch(`${SELLERS}/v1/summarize`, body, { intent: "summarize the board deck" })
      .catch(() => {});
    await h.worker[JOBS.pushSend]();
    expect(h.push.sent).toHaveLength(1);
  });

  it("a declined PayPal charge pushes the buyer (agents paused) and each seller (retrying)", async () => {
    await phone({ buyerId: ids.buyerId }, "https://fcm.googleapis.com/fcm/send/buyer");
    await phone({ sellerId: ids.sellerId }, "https://web.push.apple.com/seller");
    const client = await agent();
    for (let i = 0; i < 3; i++) await client.fetch(`${SELLERS}/v1/summarize`, body);
    h.paypal.declineNext = 1;
    h.setClock(() => new Date(Date.now() + 31 * DAY));
    await h.worker[JOBS.scan]();
    await h.drain();
    h.setClock(undefined); // back to real time: notifications are dropped once past their TTL
    await h.worker[JOBS.pushSend]();
    const byEndpoint = Object.fromEntries(h.push.sent.map((x) => [x.endpoint, x.payload]));
    expect(byEndpoint["https://fcm.googleapis.com/fcm/send/buyer"]).toMatchObject({
      kind: "tab.capture_failed",
      title: "PayPal charge failed — agents paused",
      url: "/wallet",
    });
    expect(byEndpoint["https://web.push.apple.com/seller"]).toMatchObject({
      kind: "tab.capture_failed",
      url: "/selling",
    });
  });

  it("a payout pushes the seller; accounts without a web user (API-only) get nothing", async () => {
    await phone({ sellerId: ids.sellerId }, "https://fcm.googleapis.com/fcm/send/seller1");
    const client = await agent();
    for (let i = 0; i < 300; i++)
      await client.fetch(
        `${i % 2 ? SELLERS : SELLERS.replace("sellers", "sellers2")}/v1/summarize`,
        body,
      );
    h.setClock(() => new Date(Date.now() + DAY + 3600_000));
    await h.worker[JOBS.scan]();
    await h.drain();
    await h.worker[JOBS.payoutRun]({ kind: "weekly" });
    await h.drain(true);
    h.setClock(undefined);
    await h.worker[JOBS.pushSend]();
    const payouts = h.push.sent.filter((x) => x.payload.kind === "payout.sent");
    expect(payouts).toHaveLength(1); // Second Seller has no web user
    expect(payouts[0]?.payload.title).toMatch(/^Payout sent: \$1\.\d\d$/);
    expect(payouts[0]?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/seller1");
    const rows = await h.db.select().from(s.notifications);
    expect(rows.every((r) => r.sentAt !== null)).toBe(true);
  });
});
