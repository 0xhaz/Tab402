import { createHmac, timingSafeEqual } from "node:crypto";
import { type Database, schema as s } from "@tab402/db";
import { eq, sql } from "drizzle-orm";
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface GmailConfig {
  user: string;
  /** A Google App Password (16 characters), not the account password. */
  appPassword: string;
}

/** Gmail SMTP credentials from the environment, or null when email isn't configured. */
export function gmailFromEnv(env: NodeJS.ProcessEnv = process.env): GmailConfig | null {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  return { user: GMAIL_USER, appPassword: GMAIL_APP_PASSWORD.replace(/\s+/g, "") };
}

/** Sends through Gmail's SMTP server with an App Password. Fine for a demo; Gmail caps daily volume. */
export class GmailSender implements EmailSender {
  private readonly transport;
  constructor(private readonly cfg: GmailConfig) {
    this.transport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: cfg.user, pass: cfg.appPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(m: EmailMessage) {
    try {
      await this.transport.sendMail({ from: `Tab402 <${this.cfg.user}>`, ...m });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message.slice(0, 200) };
    }
  }
}

// ── Decline links ──────────────────────────────────────────────────────────
// A decline link works without signing in, so it carries an HMAC of the approval id. It can only
// stop money moving, and an approval is decided once, so the link is single use by construction.

const mac = (secret: string, approvalId: string) =>
  createHmac("sha256", secret).update(`decline:${approvalId}`).digest("base64url");

export const declineToken = (secret: string, approvalId: string): string => mac(secret, approvalId);

export function verifyDeclineToken(secret: string, approvalId: string, token: string): boolean {
  const want = Buffer.from(mac(secret, approvalId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Emails per user per day, so a mistyped or hostile address can't turn the demo into a spam relay. */
export const EMAIL_DAILY_LIMIT = 30;

const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export function approvalEmail(n: {
  to: string;
  title: string;
  body: string;
  approveUrl: string;
  declineUrl: string;
  minutes: number;
}): EmailMessage {
  const text = [
    n.body,
    "",
    `Review and approve (you'll confirm with your passkey): ${n.approveUrl}`,
    `Decline: ${n.declineUrl}`,
    "",
    `The request expires in ${n.minutes} minutes. Nothing is charged unless you approve.`,
  ].join("\n");
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;${
      primary
        ? "background:#0f172a;color:#ffffff;"
        : "background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;"
    }">${label}</a>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#64748b">Tab402 approval request</p>
<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(n.title)}</h1>
<p style="margin:0 0 20px;font-size:15px">${escapeHtml(n.body)}</p>
<p style="margin:0 0 20px">${button(n.approveUrl, "Review and approve", true)}&nbsp;&nbsp;${button(n.declineUrl, "Decline", false)}</p>
<p style="margin:0;font-size:12px;color:#64748b">You'll confirm an approval with your passkey. The request expires in ${n.minutes} minutes, and nothing is charged unless you approve.</p>
</div></body></html>`;
  return { to: n.to, subject: n.title, text, html };
}

/**
 * Email pending approval requests to buyers who turned email on. Rows are claimed with SKIP LOCKED
 * like push delivery. Requests already decided, or expired, are marked handled without sending.
 * A failed send is not retried: the push and the in-app Approvals page still reach the buyer.
 */
export async function deliverApprovalEmails(
  db: Database,
  sender: EmailSender,
  opts: { webUrl: string; secret: string; now?: () => Date; limit?: number },
): Promise<{ sent: number; skipped: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  const base = opts.webUrl.replace(/\/+$/, "");
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      user_id: string;
      title: string;
      body: string;
      tag: string | null;
      approval_email: string;
      status: string | null;
      expires_at: string | null;
    }>(sql`
      select n.id, n.user_id, n.title, n.body, n.tag, b.approval_email,
             a.status, a.expires_at::text
      from notifications n
      join buyers b on b.user_id = n.user_id and b.approval_email is not null
      left join approvals a on a.id = n.tag
      where n.kind = 'approval.requested' and n.email_sent_at is null
        and n.created_at > ${now().toISOString()}::timestamptz - make_interval(secs => n.ttl_seconds)
      order by n.created_at
      limit ${opts.limit ?? 50}
      for update of n skip locked`);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const done = (id: string, error: string | null) =>
      tx
        .update(s.notifications)
        .set({ emailSentAt: now(), emailError: error })
        .where(eq(s.notifications.id, id));
    for (const r of rows) {
      const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
      if (!r.tag || r.status !== "pending" || !expiresAt || expiresAt <= now()) {
        await done(r.id, "no longer pending");
        skipped++;
        continue;
      }
      const [today] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from notifications
        where user_id = ${r.user_id} and email_sent_at > ${now().toISOString()}::timestamptz - interval '1 day'
          and email_error is null`);
      if ((today?.n ?? 0) >= EMAIL_DAILY_LIMIT) {
        await done(r.id, "daily email limit");
        skipped++;
        continue;
      }
      const result = await sender.send(
        approvalEmail({
          to: r.approval_email,
          title: r.title,
          body: r.body,
          approveUrl: `${base}/approve/${r.tag}`,
          declineUrl: `${base}/decline/${r.tag}?t=${declineToken(opts.secret, r.tag)}`,
          minutes: Math.max(1, Math.round((expiresAt.getTime() - now().getTime()) / 60_000)),
        }),
      );
      await done(r.id, result.ok ? null : result.error);
      if (result.ok) sent++;
      else failed++;
    }
    return { sent, skipped, failed };
  });
}
