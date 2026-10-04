/**
 * Minimal typed PayPal REST client for the day-1 sandbox tests.
 * Never prints credentials or tokens. State between steps is kept in .sandbox-state.json (gitignored).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

let cached: { token: string; scope: string; appId: string; exp: number } | undefined;

export async function token() {
  if (cached && cached.exp > Date.now()) return cached;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`token failed ${res.status}: ${j.error} ${j.error_description}`);
  cached = {
    token: j.access_token,
    scope: j.scope,
    appId: j.app_id,
    exp: Date.now() + (j.expires_in - 60) * 1000,
  };
  return cached;
}

export interface CallResult {
  status: number;
  ok: boolean;
  body: any;
  debugId: string | null;
  ms: number;
}

export async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<CallResult> {
  const { token: t } = await token();
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
      Prefer: "return=representation",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return {
    status: res.status,
    ok: res.ok,
    body: parsed,
    debugId: res.headers.get("paypal-debug-id"),
    ms: Math.round(performance.now() - started),
  };
}

const STATE = new URL("./.sandbox-state.json", import.meta.url);

export function loadState(): Record<string, any> {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
}

export function saveState(patch: Record<string, unknown>) {
  writeFileSync(STATE, JSON.stringify({ ...loadState(), ...patch }, null, 2));
}

export function report(label: string, r: CallResult, pick?: (b: any) => unknown) {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label} → ${r.status} (${r.ms} ms, debug ${r.debugId})`);
  if (!r.ok) console.log(JSON.stringify(r.body, null, 2).slice(0, 2000));
  else if (pick) console.log(JSON.stringify(pick(r.body), null, 2));
}
