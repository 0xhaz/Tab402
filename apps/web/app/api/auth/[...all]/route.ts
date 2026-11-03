import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/server";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * MCP clients (Claude Code, Cursor, …) register dynamically with http loopback callbacks and often
 * omit `application_type`. Better Auth then treats them as `web` clients, which can't use http
 * loopback, and rejects the registration. Per RFC 8252 such a client is native: say so for it.
 */
async function nativeLoopbackRegistration(req: Request): Promise<Request> {
  if (!new URL(req.url).pathname.endsWith("/oauth2/register")) return req;
  const raw = await req.text();
  // A plain Request: Next's request subclass can't be cloned with a new body.
  const rebuild = (body: string) =>
    new Request(req.url, { method: req.method, headers: req.headers, body });
  let body: { application_type?: unknown; redirect_uris?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return rebuild(raw);
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const loopbackOnly =
    uris.length > 0 &&
    uris.every((u) => {
      try {
        const url = new URL(String(u));
        return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
      } catch {
        return false;
      }
    });
  if (body.application_type === undefined && loopbackOnly) body.application_type = "native";
  return rebuild(JSON.stringify(body));
}

// Resolved per request so importing this route (e.g. during build) doesn't start Better Auth.
export const GET = (req: Request) => toNextJsHandler(getAuth()).GET(req);
export const POST = async (req: Request) =>
  toNextJsHandler(getAuth()).POST(await nativeLoopbackRegistration(req));
