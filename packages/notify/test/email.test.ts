import { randomBytes } from "node:crypto";
import { newId } from "@tab402/core";
import { createDb, queueNotification, schema as s } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvalEmail,
  declineToken,
  deliverApprovalEmails,
  EMAIL_DAILY_LIMIT,
  type EmailMessage,
  type EmailSender,
  gmailFromEnv,
  verifyDeclineToken,
} from "../src";

const url = await testDatabase("notify");
await runMigrations(url);
const { db, close } = createDb(url, { max: 4 });
afterAll(close);

const SECRET = "test-secret";
const WEB = "https://tab402.example/";

class FakeMail implements EmailSender {
  sent: EmailMessage[] = [];
  constructor(private readonly fail = false) {}
  async send(m: EmailMessage) {
    this.sent.push(m);
    return this.fail ? { ok: false as const, error: "535 bad credentials" } : { ok: true as const };
  }
}

let userId: string;
let buyerId: string;
let fixture: { sellerId: string; agentKeyId: string; endpointId: string };
beforeEach(async () => {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  await db.execute(
    sql.raw(
      `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
    ),
  );
  userId = `usr_${randomBytes(4).toString("hex")}`;
  buyerId = newId("buyer");
  const sellerId = newId("seller");
  const agentId = newId("agent");
  const agentKeyId = newId("agentKey");
  const endpointId = newId("endpoint");
  await db.insert(s.user).values({ id: userId, name: "Pat", email: `${userId}@example.com` });
  await db.insert(s.buyers).values({
    id: buyerId,
    userId,
    name: "Pat",
    email: "p@example.com",
    approvalEmail: "pat@gmail.example",
  });
  await db.insert(s.sellers).values({ id: sellerId, name: "Acme" });
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "Agent" });
  await db.insert(s.agentKeys).values({
    id: agentKeyId,
    agentId,
    buyerId,
    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  });
  await db.insert(s.endpoints).values({
    id: endpointId,
    sellerId,
    method: "POST",
    url: "https://acme.example/v1/summarize",
    pricingMode: "fixed",
    priceMicros: 10_000,
  });
  fixture = { sellerId, agentKeyId, endpointId };
});

/** A pending approval and its notification, as the guard writes them. */
async function requestApproval(
  opts: { status?: "pending" | "approved"; expiresInMs?: number } = {},
) {
  const id = newId("approval");
  await db.insert(s.approvals).values({
    id,
    buyerId,
    ...fixture,
    amountMicros: 2_500_000,
    intent: "summarize the note",
    reason: "over your ask-first limit",
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 15 * 60_000)),
    ...(opts.status ? { status: opts.status } : {}),
  });
  const notificationId = await queueNotification(
    db,
    { buyerId },
    {
      kind: "approval.requested",
      title: "Approve $2.50 for Acme?",
      body: "Agent: summarize the note",
      url: `/approve/${id}`,
      tag: id,
      urgency: "high",
      ttlSeconds: 900,
    },
  );
  return { id, notificationId: notificationId as string };
}

const emailState = async (id: string) =>
  (
    await db
      .select({ at: s.notifications.emailSentAt, error: s.notifications.emailError })
      .from(s.notifications)
      .where(eq(s.notifications.id, id))
  )[0];

describe("decline tokens", () => {
  it("verify only for the same approval and secret", () => {
    const t = declineToken(SECRET, "apr_1");
    expect(verifyDeclineToken(SECRET, "apr_1", t)).toBe(true);
    expect(verifyDeclineToken(SECRET, "apr_2", t)).toBe(false);
    expect(verifyDeclineToken("other", "apr_1", t)).toBe(false);
    expect(verifyDeclineToken(SECRET, "apr_1", "")).toBe(false);
    expect(verifyDeclineToken(SECRET, "apr_1", `${t}x`)).toBe(false);
  });
});

describe("approval emails", () => {
  it("emails a pending request with a review link and a signed decline link, once", async () => {
    const { id, notificationId } = await requestApproval();
    const mail = new FakeMail();
    expect(await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET })).toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
    });
    const [m] = mail.sent;
    expect(m?.to).toBe("pat@gmail.example");
    expect(m?.subject).toBe("Approve $2.50 for Acme?");
    expect(m?.text).toContain(`https://tab402.example/approve/${id}`);
    expect(m?.text).toContain(`https://tab402.example/decline/${id}?t=${declineToken(SECRET, id)}`);
    expect(m?.html).toContain("Review and approve");
    expect(await emailState(notificationId)).toMatchObject({ error: null });
    expect((await emailState(notificationId))?.at).toBeInstanceOf(Date);

    await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET });
    expect(mail.sent).toHaveLength(1);
  });

  it("sends nothing to buyers who turned email off", async () => {
    await db.update(s.buyers).set({ approvalEmail: null }).where(eq(s.buyers.id, buyerId));
    const { notificationId } = await requestApproval();
    const mail = new FakeMail();
    expect(await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET })).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect((await emailState(notificationId))?.at).toBeNull();
  });

  it("skips requests already decided or expired", async () => {
    const decided = await requestApproval({ status: "approved" });
    const expired = await requestApproval({ expiresInMs: -1000 });
    const mail = new FakeMail();
    expect(await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET })).toEqual({
      sent: 0,
      skipped: 2,
      failed: 0,
    });
    expect(mail.sent).toEqual([]);
    expect((await emailState(decided.notificationId))?.error).toBe("no longer pending");
    expect((await emailState(expired.notificationId))?.error).toBe("no longer pending");
  });

  it("ignores other notification kinds", async () => {
    await queueNotification(db, { buyerId }, { kind: "test", title: "Hi", body: "x", url: "/" });
    const mail = new FakeMail();
    await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET });
    expect(mail.sent).toEqual([]);
  });

  it("records a failed send without retrying it", async () => {
    const { notificationId } = await requestApproval();
    const mail = new FakeMail(true);
    expect(await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET })).toEqual({
      sent: 0,
      skipped: 0,
      failed: 1,
    });
    expect((await emailState(notificationId))?.error).toBe("535 bad credentials");
    await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET });
    expect(mail.sent).toHaveLength(1);
  });

  it(`stops at ${EMAIL_DAILY_LIMIT} emails a day per user`, async () => {
    await db.execute(sql`
      insert into notifications (id, user_id, kind, title, body, url, email_sent_at)
      select 'ntf_old' || g, ${userId}, 'approval.requested', 't', 'b', '/', now() - interval '1 hour'
      from generate_series(1, ${EMAIL_DAILY_LIMIT}) g`);
    const { notificationId } = await requestApproval();
    const mail = new FakeMail();
    expect(await deliverApprovalEmails(db, mail, { webUrl: WEB, secret: SECRET })).toEqual({
      sent: 0,
      skipped: 1,
      failed: 0,
    });
    expect((await emailState(notificationId))?.error).toBe("daily email limit");
  });

  it("escapes what agents write before putting it in HTML", () => {
    const m = approvalEmail({
      to: "a@b.c",
      title: "Approve <b>$1</b>?",
      body: `Agent: <img src=x onerror="alert(1)">`,
      approveUrl: "https://x/approve/1",
      declineUrl: "https://x/decline/1?t=a&b",
      minutes: 15,
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(m.html).toContain('href="https://x/decline/1?t=a&amp;b"');
  });
});

describe("gmailFromEnv", () => {
  it("needs both settings and strips the spaces Google shows in app passwords", () => {
    expect(gmailFromEnv({ GMAIL_USER: "me@gmail.com" })).toBeNull();
    expect(
      gmailFromEnv({ GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }),
    ).toEqual({
      user: "me@gmail.com",
      appPassword: "abcdefghijklmnop",
    });
  });
});
