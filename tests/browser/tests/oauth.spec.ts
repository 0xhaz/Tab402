import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import { close, signUp } from "./helpers";

test.afterAll(close);

const MCP = "http://localhost:4300/mcp";
// What claude.ai registers; Playwright intercepts the navigation, nothing reaches claude.ai.
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const b64url = (b: Buffer) => b.toString("base64url");

test("an MCP connector connects with OAuth 2.1 (discovery → DCR → PKCE → consent → token) and pays via MCP", async ({
  page,
  request,
}) => {
  // 1. Unauthenticated call → RFC 9728 challenge pointing at the protected resource metadata.
  const challenge = await request.post(MCP, {
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: {},
    failOnStatusCode: false,
  });
  expect(challenge.status()).toBe(401);
  expect(challenge.headers()["www-authenticate"]).toMatch(
    /resource_metadata="?http:\/\/localhost:4300\/\.well-known\/oauth-protected-resource/,
  );

  const prm = await (
    await request.get("http://localhost:4300/.well-known/oauth-protected-resource/mcp")
  ).json();
  expect(prm).toMatchObject({
    resource: MCP,
    authorization_servers: ["http://localhost:3300/api/auth"],
  });

  // 2. Authorization server metadata (RFC 8414, path-insertion form for issuer /api/auth).
  const as = await (
    await request.get("http://localhost:3300/.well-known/oauth-authorization-server/api/auth")
  ).json();
  expect(as.issuer).toBe("http://localhost:3300/api/auth");
  expect(as.code_challenge_methods_supported).toContain("S256");

  // 3. Dynamic Client Registration, unauthenticated — what Claude's connectors do.
  const reg = await request.post(as.registration_endpoint, {
    data: {
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid offline_access tab402:pay",
    },
  });
  expect(reg.status()).toBeLessThan(300);
  const { client_id } = await reg.json();

  // 4. The buyer signs in and approves on the consent page.
  await signUp(page, "Olivia OAuth");
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(12));
  const authorize = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    scope: "openid offline_access tab402:pay",
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: MCP,
  }))
    authorize.searchParams.set(k, v);

  let callback = "";
  await page.route(`${REDIRECT}**`, (route) => {
    callback = route.request().url();
    return route.fulfill({ body: "connected" });
  });
  await page.goto(authorize.toString());
  await expect(page.getByText("Claude wants to use your Tab402 wallet")).toBeVisible();
  await expect(page.getByText("Pay for API calls on your tab")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback, { timeout: 15_000 }).toContain("code=");
  const cb = new URL(callback);
  expect(cb.searchParams.get("state")).toBe(state);

  // 5. Code → access token, bound to the MCP resource.
  const tokenRes = await request.post(as.token_endpoint, {
    form: {
      grant_type: "authorization_code",
      code: cb.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
      resource: MCP,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const tokens = await tokenRes.json();
  expect(tokens.access_token).toBeTruthy();

  // 6. The MCP server accepts it; the agent is named after the connecting app.
  const client = new Client({ name: "claude-connector", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("call_paid");
  const budget = JSON.parse(
    (
      (await client.callTool({ name: "get_budget", arguments: {} })) as {
        content: { text: string }[];
      }
    ).content[0]?.text ?? "{}",
  );
  expect(budget).toMatchObject({ agent: { name: "Claude" }, buyer: { daily_budget: "$10.00" } });
  await client.close();

  // A token for another audience is refused.
  const bad = await request.post(MCP, {
    headers: {
      authorization: "Bearer not-a-real-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    failOnStatusCode: false,
  });
  expect(bad.status()).toBe(401);
});

test("native MCP clients (Claude Code, Cursor) can register loopback callbacks; plain http elsewhere is refused", async ({
  request,
}) => {
  const register = (redirect: string) =>
    request.post("/api/auth/oauth2/register", {
      data: {
        client_name: "Claude Code",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
  for (const loopback of ["http://localhost:54321/callback", "http://127.0.0.1:54321/callback"]) {
    const res = await register(loopback);
    expect(res.status(), loopback).toBeLessThan(300);
    expect((await res.json()).application_type).toBe("native");
  }
  expect(
    (await (await register("https://claude.ai/api/mcp/auth_callback")).json()).application_type,
  ).toBe("web");
  expect((await register("http://evil.example/callback")).status()).toBe(400);
});
