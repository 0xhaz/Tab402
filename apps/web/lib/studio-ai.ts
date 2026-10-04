"use client";

import { REVENUE_TOOL_SCHEMAS } from "@tab402/agents/revenue-schema";
import {
  type AgAiEvent,
  type AgAiHarness,
  type AgAiOutputItem,
  type AgAiTool,
  type AgLlmAdapter,
  type AgLlmResponse,
  type AgStudioApi,
  createAiHarness,
  directLlmRunner,
} from "ag-studio";

type TurnResult = {
  id: string;
  model: string;
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
};

/**
 * AG Studio → Claude: each turn goes to our server (/api/ai/turn), which calls the Messages API.
 * AG Studio reads tool calls from `complete`; the stream only drives the chat UI.
 */
export const claudeAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    let resolve!: (r: AgLlmResponse) => void;
    let reject!: (e: unknown) => void;
    const complete = new Promise<AgLlmResponse>((a, b) => {
      resolve = a;
      reject = b;
    });
    async function* stream(): AsyncGenerator<AgAiEvent> {
      try {
        const res = await fetch("/api/ai/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: options?.signal,
        });
        const body = (await res.json().catch(() => ({}))) as TurnResult & { error?: string };
        if (!res.ok) {
          const message = body.error ?? `AI request failed (${res.status})`;
          yield { type: "RUN_ERROR", message, code: String(res.status) };
          resolve({
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            status: "failed",
            error: { code: String(res.status), message },
            output: [],
          });
          return;
        }
        const output: AgAiOutputItem[] = [];
        if (body.text) {
          const messageId = `${body.id}-text`;
          yield { type: "TEXT_MESSAGE_CHUNK", messageId, role: "assistant", delta: body.text };
          output.push({
            id: messageId,
            kind: "output",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "text", text: body.text, annotations: [] }],
          });
        }
        for (const call of body.toolCalls) {
          yield {
            type: "TOOL_CALL_CHUNK",
            toolCallId: call.id,
            toolCallName: call.name,
            delta: call.arguments,
          };
          output.push({
            id: call.id,
            kind: "output",
            type: "function_call",
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            status: "completed",
          });
        }
        const truncated = body.stopReason === "max_tokens";
        resolve({
          id: body.id,
          createdAt: Date.now(),
          model: body.model,
          status: truncated ? "incomplete" : "completed",
          ...(truncated ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
          output,
          usage: {
            inputTokens: body.usage.inputTokens,
            outputTokens: body.usage.outputTokens,
            totalTokens: body.usage.inputTokens + body.usage.outputTokens,
            cachedInputTokens: body.usage.cachedInputTokens,
          },
        });
      } catch (err) {
        reject(err);
        throw err;
      }
    }
    return { stream: stream(), complete };
  },
};

/** The revenue agent's ledger tools, run server-side against the signed-in seller's own data. */
const revenueTools: AgAiTool[] = Object.values(REVENUE_TOOL_SCHEMAS).map((t) => ({
  name: t.name,
  description: t.description,
  kind: "client",
  schema: () => ({ name: t.name, description: t.description, parameters: t.parameters }),
  async execute(call, ctx) {
    const res = await fetch(`/api/ai/tools/${t.name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call.args ?? {}),
      signal: ctx.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return ctx.error(body.error ?? `tool failed (${res.status})`);
    return ctx.success(JSON.stringify(body), body);
  },
}));

const SELLER_STARTERS = [
  { label: "Why did revenue drop?", prompt: "Why did revenue drop on Tuesday?" },
  { label: "Where's my money?", prompt: "How much have I earned, collected and been paid out?" },
  {
    label: "Best endpoint",
    prompt: "Which endpoint makes the most money, and how is it trending?",
  },
];
const BUYER_STARTERS = [
  { label: "Biggest spend", prompt: "Which seller and agent did I spend the most with this week?" },
  { label: "Blocked purchases", prompt: "What did the spend guard deny or ask about, and why?" },
];

/**
 * AG Studio harness: the built-in agents (report building, queries, widgets) on Claude, plus — for
 * sellers — the revenue tools on the lead and data agents.
 */
export function studioHarness(api: AgStudioApi, role: "seller" | "buyer"): AgAiHarness {
  return createAiHarness(api, ({ builtIn }) => {
    const withRevenue = (id: "lead" | "data") => {
      const def = builtIn[id];
      return directLlmRunner({
        ...def,
        adapter: claudeAdapter,
        tools: (ctx, params) => [...(def.tools?.(ctx, params) ?? []), ...revenueTools],
      });
    };
    const plain = (id: "lead" | "data" | "page" | "planning" | "widget") =>
      directLlmRunner({ ...builtIn[id], adapter: claudeAdapter });
    return {
      agents:
        role === "seller"
          ? [
              withRevenue("lead"),
              withRevenue("data"),
              plain("page"),
              plain("planning"),
              plain("widget"),
            ]
          : (["lead", "data", "page", "planning", "widget"] as const).map(plain),
      primary: "lead",
      promptStarters: role === "seller" ? SELLER_STARTERS : BUYER_STARTERS,
    };
  });
}
