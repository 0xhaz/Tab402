import { createECDH, randomBytes } from "node:crypto";
import { newId } from "@tab402/core";
import { createDb, NOTIFY_CHANNEL, queueNotification, schema as s } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import {
  deliverNotifications,
  type PushSender,
  type PushTarget,
  type SendResult,
  topicFor,
  WebPushSender,
} from "../src";

const url = await testDatabase("notify");
await runMigrations(url);
const { db, sql: pg, close } = createDb(url, { max: 6 });
afterAll(close);

class FakeSender implements PushSender {
  calls: { target: PushTarget; payload: Record<string, unknown>; ttl: number; topic?: string }[] =
    [];
  constructor(private readonly result: (endpoint: string) => SendResult = () => ({ ok: true })) {}
  async send(target: PushTarget, payload: string, o: { ttlSeconds: number; topic?: string }) {
    this.calls.push({ target, payload: JSON.parse(payload), ttl: o.ttlSeconds, topic: o.topic });
    return this.result(target.endpoint);
  }
}

let userId: string;
let sellerId: string;
let buyerId: string;
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
  await db.insert(s.user).values({ id: userId, name: "Pat", email: `${userId}@example.com` });
  sellerId = newId("seller");
  buyerId = newId("buyer");
  await db.insert(s.sellers).values({ id: sellerId, userId, name: "Acme" });
  await db.insert(s.buyers).values({ id: buyerId, userId, name: "Pat", email: "p@example.com" });
});

const subscribe = async (endpoint: string) =>
  db.insert(s.pushSubscriptions).values({
    id: newId("pushSubscription"),
    userId,
    endpoint,
    p256dh: "p",
    auth: "a",
  });

const note = { kind: "test" as const, title: "Hi", body: "There", url: "/selling" };

describe("notification outbox", () => {
  it("resolves the user behind a seller or buyer; accounts without a web user get nothing", async () => {
    expect(await queueNotification(db, { sellerId }, note)).toMatch(/^ntf_/);
    expect(await queueNotification(db, { buyerId }, note)).toMatch(/^ntf_/);
    const apiOnly = newId("buyer");
    await db.insert(s.buyers).values({ id: apiOnly, name: "API", email: "api@example.com" });
    expect(await queueNotification(db, { buyerId: apiOnly }, note)).toBeNull();
    await expect(
      queueNotification(db, { userId }, { ...note, url: "https://evil.example" }),
    ).rejects.toThrow();
    await expect(
      queueNotification(db, { userId }, { ...note, url: "//evil.example" }),
    ).rejects.toThrow();
  });

  it("wakes listeners on commit (NOTIFY), not before", async () => {
    const heard: string[] = [];
    const sub = await pg.listen(NOTIFY_CHANNEL, (id) => heard.push(id));
    let id: string | null = null;
    await db.transaction(async (tx) => {
      id = await queueNotification(tx, { sellerId }, note);
      await new Promise((r) => setTimeout(r, 100));
      expect(heard).toEqual([]);
    });
    await expect.poll(() => heard).toEqual([id]);
    await sub.unlisten();
  });
});

describe("delivery", () => {
  it("sends to every device, deletes gone subscriptions, and marks the notification sent", async () => {
    await subscribe("https://push.example/a");
    await subscribe("https://push.example/gone");
    const id = await queueNotification(
      db,
      { buyerId },
      { ...note, tag: "apr_1", urgency: "high", ttlSeconds: 900 },
    );
    const sender = new FakeSender((e) =>
      e.endsWith("/gone") ? { ok: false, gone: true, error: "HTTP 410" } : { ok: true },
    );
    expect(await deliverNotifications(db, sender)).toEqual({ sent: 1, devices: 1, failed: 0 });
    expect(sender.calls).toHaveLength(2);
    expect(sender.calls[0]?.payload).toEqual({
      id,
      kind: "test",
      title: "Hi",
      body: "There",
      url: "/selling",
      tag: "apr_1",
    });
    expect(sender.calls[0]?.topic).toBe(topicFor("apr_1"));
    expect(sender.calls[0]?.ttl).toBeLessThanOrEqual(900);
    const subs = await db.select().from(s.pushSubscriptions);
    expect(subs.map((x) => x.endpoint)).toEqual(["https://push.example/a"]);
    expect(subs[0]?.lastSuccessAt).not.toBeNull();
    const [row] = await db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.id, id ?? ""));
    expect(row).toMatchObject({ devices: 1, attempts: 1 });
    expect(row?.sentAt).not.toBeNull();
    // Nothing left to send.
    expect(await deliverNotifications(db, sender)).toEqual({ sent: 0, devices: 0, failed: 0 });
  });

  it("retries when every device fails transiently, up to 5 attempts", async () => {
    await subscribe("https://push.example/down");
    await queueNotification(db, { userId }, note);
    const sender = new FakeSender(() => ({ ok: false, gone: false, error: "HTTP 503" }));
    for (let i = 0; i < 7; i++) await deliverNotifications(db, sender);
    expect(sender.calls).toHaveLength(5);
    const [row] = await db.select().from(s.notifications);
    expect(row).toMatchObject({ attempts: 5, sentAt: null, lastError: "HTTP 503" });
    const [sub] = await db.select().from(s.pushSubscriptions);
    expect(sub?.failureCount).toBe(5);
  });

  it("drops notifications that expired before delivery and handles users with no devices", async () => {
    const stale = await queueNotification(db, { userId }, { ...note, ttlSeconds: 60 });
    const none = await queueNotification(db, { sellerId }, note);
    const sender = new FakeSender();
    const later = () => new Date(Date.now() + 120_000);
    await deliverNotifications(db, sender, { now: later });
    expect(sender.calls).toEqual([]);
    const rows = await db.select().from(s.notifications);
    expect(rows.find((r) => r.id === stale)).toMatchObject({
      devices: 0,
      lastError: "expired before delivery",
    });
    expect(rows.find((r) => r.id === none)).toMatchObject({ devices: 0, lastError: null });
  });

  it("never sends one notification twice when deliveries run concurrently", async () => {
    await subscribe("https://push.example/a");
    for (let i = 0; i < 20; i++)
      await queueNotification(db, { userId }, { ...note, title: `n${i}` });
    const sender = new FakeSender();
    const slow: PushSender = {
      send: async (...args) => {
        await new Promise((r) => setTimeout(r, 2));
        return sender.send(...args);
      },
    };
    await Promise.all([1, 2, 3].map(() => deliverNotifications(db, slow, { limit: 7 })));
    while ((await deliverNotifications(db, slow)).sent) {}
    const titles = sender.calls.map((c) => c.payload.title);
    expect(titles).toHaveLength(20);
    expect(new Set(titles).size).toBe(20);
  });
});

describe("WebPushSender (web-push)", () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  const vapid = { subject: "mailto:ops@tab402.dev", ...webpush.generateVAPIDKeys() };
  const target = { endpoint: "https://push.example/sub", keys };

  it("the request it makes: aes128gcm ciphertext, VAPID auth, TTL, urgency, topic", () => {
    const d = webpush.generateRequestDetails(target, '{"title":"Approve $2.50?"}', {
      vapidDetails: vapid,
      TTL: 900,
      urgency: "high",
      topic: topicFor("apr_1"),
    });
    expect(d.method).toBe("POST");
    expect(d.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(d.headers.TTL).toBe(900);
    expect(d.headers.Urgency).toBe("high");
    expect(d.headers.Topic).toBe(topicFor("apr_1"));
    expect(String(d.headers.Authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect((d.body as Buffer).length).toBeGreaterThan(100); // ciphertext, not the 26-byte plaintext
    expect(topicFor("apr_1")).toMatch(/^[\w-]{32}$/);
  });

  it("passes our options through and maps 404/410 to gone, others to retry", async () => {
    const spy = vi.spyOn(webpush, "sendNotification");
    const sender = new WebPushSender(vapid);
    spy.mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });
    expect(
      await sender.send(target, "{}", { ttlSeconds: 60, urgency: "normal", topic: "t" }),
    ).toEqual({ ok: true });
    expect(spy.mock.calls[0]?.[2]).toMatchObject({
      vapidDetails: vapid,
      TTL: 60,
      urgency: "normal",
      topic: "t",
    });
    for (const [statusCode, gone] of [
      [410, true],
      [404, true],
      [429, false],
      [500, false],
    ] as const) {
      spy.mockRejectedValueOnce(new webpush.WebPushError("x", statusCode, {}, "", target.endpoint));
      expect(await sender.send(target, "{}", { ttlSeconds: 60, urgency: "normal" })).toEqual({
        ok: false,
        gone,
        error: `HTTP ${statusCode}`,
      });
    }
    spy.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sender.send(target, "{}", { ttlSeconds: 60, urgency: "normal" })).toEqual({
      ok: false,
      gone: false,
      error: "socket hang up",
    });
    spy.mockRestore();
  });
});

describe("push endpoint allowlist (SSRF)", () => {
  it("accepts the browsers' push services only, over https", async () => {
    const { isAllowedPushEndpoint } = await import("../src");
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ])
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/push",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil.example/fcm.googleapis.com",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "not a url",
    ])
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    expect(isAllowedPushEndpoint("https://push.test/x", ["push.test"])).toBe(true);
  });
});
