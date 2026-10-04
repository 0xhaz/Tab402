/**
 * Send a captured AG Studio turn (tests/browser/test-results/ag-studio-turn.json, written by
 * ai.spec.ts) to the real Claude API through runStudioTurn — proves AG Studio's own tool schemas
 * and instructions are accepted by the Messages API.
 *   npx tsx --env-file=.env scripts/agents/replay-studio-turn.ts
 */
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { runStudioTurn, type StudioTurnRequest, turnCostMicros } from "@tab402/agents";

const req = JSON.parse(
  await readFile(
    new URL("../../tests/browser/test-results/ag-studio-turn.json", import.meta.url),
    "utf8",
  ),
) as StudioTurnRequest;
console.log(`${req.tools?.length} tools · instructions ${req.instructions?.length} chars`);
const r = await runStudioTurn(new Anthropic(), req);
console.log(
  `stop ${r.stopReason} · tokens in ${r.usage.inputTokens} (cache read ${r.usage.cachedInputTokens ?? 0}, write ${r.usage.cacheWriteTokens ?? 0}) out ${r.usage.outputTokens} · ≈$${(turnCostMicros(r.usage) / 1e6).toFixed(4)} · ${r.model}`,
);
console.log("text:", r.text.slice(0, 400) || "—");
console.log("tool calls:", r.toolCalls.map((t) => `${t.name}(${t.arguments})`).join(", ") || "—");
