import { createHash } from "node:crypto";
import { type Database, schema as s } from "@tab402/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushOptions {
  ttlSeconds: number;
  urgency: "very-low" | "low" | "normal" | "high";
  /** Replaces an undelivered message with the same topic at the push service (≤ 32 url-safe chars). */
  topic?: string;
}

/** What the service worker receives (JSON). */
export interface PushPayload {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  send(target: PushTarget, payload: string, options: PushOptions): Promise<SendResult>;
}

export interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** VAPID keys from the environment, or null when push isn't configured. */
export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): Vapid | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  return {
    subject: VAPID_SUBJECT || "mailto:ops@tab402.dev",
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
  };
}

/** Web Push (RFC 8030 + VAPID RFC 8292, aes128gcm payload encryption) via `web-push`. */
export class WebPushSender implements PushSender {
  constructor(private readonly vapid: Vapid) {}

  async send(target: PushTarget, payload: string, options: PushOptions): Promise<SendResult> {
    try {
      await webpush.sendNotification(target, payload, {
        vapidDetails: this.vapid,
        TTL: options.ttlSeconds,
        urgency: options.urgency,
        ...(options.topic ? { topic: options.topic } : {}),
        timeout: 10_000,
      });
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the subscription is gone for good (unsubscribed, expired, app removed).
      return {
        ok: false,
        gone: status === 404 || status === 410,
        error: status ? `HTTP ${status}` : (err as Error).message.slice(0, 200),
      };
    }
  }
}

/** Push topics are ≤ 32 chars of the url-safe base64 alphabet: derive one from the tag. */
export const topicFor = (tag: string): string =>
  createHash("sha256").update(tag).digest("base64url").slice(0, 32);

const MAX_ATTEMPTS = 5;

/**
 * Deliver queued notifications to every device of their user. Rows are claimed with SKIP LOCKED,
 * so several workers (or the LISTEN path and the sweep) never send one twice. Gone subscriptions
 * are deleted; a notification is done once any device accepted it (or the user has no devices).
 */
export async function deliverNotifications(
  db: Database,
  sender: PushSender,
  opts: { limit?: number; now?: () => Date; ids?: string[] } = {},
): Promise<{ sent: number; devices: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      id: string;
      user_id: string;
      kind: string;
      title: string;
      body: string;
      url: string;
      tag: string | null;
      urgency: PushOptions["urgency"];
      ttl_seconds: number;
      created_at: string;
      attempts: number;
    }>(sql`
      select id, user_id, kind, title, body, url, tag, urgency, ttl_seconds, created_at::text, attempts
      from notifications
      where sent_at is null and attempts < ${MAX_ATTEMPTS}
        ${opts.ids?.length ? sql`and id in ${opts.ids}` : sql``}
      order by created_at
      limit ${opts.limit ?? 100}
      for update skip locked`);
    let sent = 0;
    let devices = 0;
    let failed = 0;
    for (const n of claimed) {
      // Expired before we got to it (e.g. a 15-minute approval): drop instead of sending stale.
      const age = (now().getTime() - new Date(n.created_at).getTime()) / 1000;
      if (age > n.ttl_seconds) {
        await tx
          .update(s.notifications)
          .set({ sentAt: now(), devices: 0, lastError: "expired before delivery" })
          .where(eq(s.notifications.id, n.id));
        continue;
      }
      const subs = await tx
        .select()
        .from(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.userId, n.user_id));
      const payload: PushPayload = {
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        url: n.url,
        ...(n.tag ? { tag: n.tag } : {}),
      };
      const options: PushOptions = {
        ttlSeconds: Math.max(0, Math.floor(n.ttl_seconds - age)),
        urgency: n.urgency,
        ...(n.tag ? { topic: topicFor(n.tag) } : {}),
      };
      const results = await Promise.all(
        subs.map(async (sub) => ({
          sub,
          r: await sender.send(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            options,
          ),
        })),
      );
      const ok = results.filter((x) => x.r.ok).map((x) => x.sub.id);
      const gone = results.filter((x) => !x.r.ok && x.r.gone).map((x) => x.sub.id);
      const flaky = results.filter((x) => !x.r.ok && !x.r.gone).map((x) => x.sub.id);
      if (ok.length)
        await tx
          .update(s.pushSubscriptions)
          .set({ lastSuccessAt: now(), failureCount: 0 })
          .where(inArray(s.pushSubscriptions.id, ok));
      if (gone.length)
        await tx.delete(s.pushSubscriptions).where(inArray(s.pushSubscriptions.id, gone));
      if (flaky.length)
        await tx
          .update(s.pushSubscriptions)
          .set({ failureCount: sql`${s.pushSubscriptions.failureCount} + 1` })
          .where(inArray(s.pushSubscriptions.id, flaky));

      const firstError = results.find((x) => !x.r.ok)?.r;
      const error = firstError && !firstError.ok ? firstError.error : null;
      if (ok.length > 0 || subs.length === 0 || flaky.length === 0) {
        // Done: someone got it, nobody to send to, or every device is gone.
        await tx
          .update(s.notifications)
          .set({ sentAt: now(), devices: ok.length, attempts: n.attempts + 1, lastError: error })
          .where(eq(s.notifications.id, n.id));
        sent++;
        devices += ok.length;
      } else {
        await tx
          .update(s.notifications)
          .set({ attempts: n.attempts + 1, lastError: error })
          .where(and(eq(s.notifications.id, n.id)));
        failed++;
      }
    }
    return { sent, devices, failed };
  });
}

/**
 * Push services of the browsers we support. The worker POSTs to subscription endpoints, so an
 * open endpoint would let any user point our servers at internal URLs (SSRF): only these hosts.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Android
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari / iOS 16.4+ home-screen apps
  ".notify.windows.com", // legacy Edge
  ".push.apple.com",
];

export function isAllowedPushEndpoint(endpoint: string, extraHosts: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443"))
    return false;
  return [...PUSH_HOSTS, ...extraHosts].some((h) =>
    h.startsWith(".") ? u.hostname.endsWith(h) : u.hostname === h,
  );
}
export * from "./email";
