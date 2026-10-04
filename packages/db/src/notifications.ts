import { newId } from "@tab402/core";
import { sql } from "drizzle-orm";
import type { Database } from "./client";

/** Anything that can run a statement: the database or an open transaction. */
type Executor = Pick<Database, "execute">;

export const NOTIFY_CHANNEL = "tab402_notify";

export type NotificationKind =
  | "approval.requested"
  | "payout.sent"
  | "payout.failed"
  | "tab.capture_failed"
  | "test";

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Path on the web app, e.g. /approve/apr_… */
  url: string;
  tag?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
  ttlSeconds?: number;
}

export type NotificationTarget = { userId: string } | { sellerId: string } | { buyerId: string };

/**
 * Queue a push notification for the user behind a seller/buyer account, in the caller's transaction,
 * and wake the worker (NOTIFY is delivered on commit). Accounts without a web user (API-only
 * buyers, seeded sellers) get nothing. Returns the notification id, or null.
 */
export async function queueNotification(
  tx: Executor,
  target: NotificationTarget,
  n: NotificationInput,
): Promise<string | null> {
  if (!n.url.startsWith("/") || n.url.startsWith("//"))
    throw new Error("notification url must be a path");
  const id = newId("notification");
  const owner =
    "userId" in target
      ? sql`select ${target.userId}::text as user_id`
      : "sellerId" in target
        ? sql`select user_id from sellers where id = ${target.sellerId} and user_id is not null`
        : sql`select user_id from buyers where id = ${target.buyerId} and user_id is not null`;
  const rows = await tx.execute<{ id: string }>(sql`
    insert into notifications (id, user_id, kind, title, body, url, tag, urgency, ttl_seconds)
    select ${id}, o.user_id, ${n.kind}, ${n.title.slice(0, 120)}, ${n.body.slice(0, 300)}, ${n.url},
           ${n.tag ?? null}, ${n.urgency ?? "normal"}, ${n.ttlSeconds ?? 86_400}
    from (${owner}) o
    returning id`);
  if (rows.length === 0) return null;
  await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${id})`);
  return id;
}
