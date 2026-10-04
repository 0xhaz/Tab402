import { type AgentKeyPair, generateAgentKeyPair } from "@tab402/core";

export interface RegisterAgentKeyOptions {
  /** Tab402 API base URL. */
  apiUrl: string;
  /** Buyer API key (t402_bk_…). */
  buyerApiKey: string;
  agentName: string;
  /** Bring your own key pair (e.g. hardware-backed); generated if omitted. */
  keyPair?: AgentKeyPair;
  dailyBudgetMicros?: number;
  fetch?: typeof fetch;
}

/** Generate a P-256 key locally and register only its public half. */
export async function registerAgentKey(
  options: RegisterAgentKeyOptions,
): Promise<AgentKeyPair & { keyId: string; agentId: string }> {
  const keyPair = options.keyPair ?? (await generateAgentKeyPair());
  const res = await (options.fetch ?? fetch)(`${options.apiUrl.replace(/\/+$/, "")}/agent-keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.buyerApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      agentName: options.agentName,
      publicJwk: keyPair.publicJwk,
      dailyBudget:
        options.dailyBudgetMicros === undefined ? undefined : String(options.dailyBudgetMicros),
    }),
  });
  const body = (await res.json()) as { keyId?: string; agentId?: string; error?: string };
  if (res.status !== 201 || !body.keyId || !body.agentId) {
    throw new Error(
      `agent key registration failed (${res.status}): ${body.error ?? "unknown error"}`,
    );
  }
  return { ...keyPair, keyId: body.keyId, agentId: body.agentId };
}
