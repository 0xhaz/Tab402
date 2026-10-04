import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { runStudioTurn, type StudioTurnRequest, turnCostMicros } from "@tab402/agents";
import { newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { db, getSession } from "@/lib/server";

/** AI turns per user per hour (each is a Sonnet call on Tab402's key). */
const TURNS_PER_HOUR = 120;
const MAX_BODY = 1_000_000;

let client: Anthropic | undefined;

/** AG Studio's LLM adapter calls this once per turn; the API key never reaches the browser. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "sign in first" }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY)
    return Response.json({ error: "AI is not configured on this server" }, { status: 503 });

  const raw = await request.text();
  if (raw.length > MAX_BODY)
    return Response.json({ error: "conversation too long" }, { status: 413 });
  let body: StudioTurnRequest;
  try {
    body = JSON.parse(raw) as StudioTurnRequest;
    if (
      !Array.isArray(body.input) ||
      (body.tools && !Array.isArray(body.tools)) ||
      (body.tools?.length ?? 0) > 64
    )
      throw new Error();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const userId = session.user.id;
  const [used] = await db
    .select({ n: count() })
    .from(s.aiDecisions)
    .where(
      and(
        eq(s.aiDecisions.agentKind, "studio"),
        sql`${s.aiDecisions.subjectIds}->>'userId' = ${userId}`,
        gte(s.aiDecisions.createdAt, new Date(Date.now() - 3600_000)),
      ),
    );
  if ((used?.n ?? 0) >= TURNS_PER_HOUR)
    return Response.json({ error: "AI limit reached for this hour" }, { status: 429 });

  client ??= new Anthropic();
  const started = performance.now();
  try {
    const result = await runStudioTurn(client, body, {
      model: process.env.REVENUE_AGENT_MODEL || undefined,
      signal: request.signal,
    });
    const tokensIn = result.usage.inputTokens;
    const tokensOut = result.usage.outputTokens;
    await db.insert(s.aiDecisions).values({
      id: newId("aiDecision"),
      agentKind: "studio",
      subjectIds: { userId },
      inputDigest: createHash("sha256").update(raw).digest("hex"),
      decision: result.toolCalls.length
        ? `tools: ${result.toolCalls.map((t) => t.name).join(", ")}`.slice(0, 500)
        : `answer (${result.stopReason})`,
      reasoning: result.text.slice(0, 2000) || null,
      model: result.model,
      modelVersion: result.model,
      latencyMs: Math.round(performance.now() - started),
      tokensIn,
      tokensOut,
      costUsdMicros: turnCostMicros(result.usage),
    });
    return Response.json(result);
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("studio turn failed", err);
    const status = err instanceof Anthropic.APIError && err.status === 429 ? 429 : 502;
    return Response.json({ error: "The AI model is unavailable right now." }, { status });
  }
}
