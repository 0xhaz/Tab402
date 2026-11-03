import Anthropic from "@anthropic-ai/sdk";

export interface Completion {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The model refused this input (its safety checks); the call failed, so nobody is charged. */
export class LlmRefusal extends Error {
  override name = "LlmRefusal";
}

export interface Llm {
  complete(input: { system?: string; prompt: string; maxTokens: number }): Promise<Completion>;
}

/**
 * List prices in micro-USD per token (= $ per million tokens). Used to meter /v1/chat at
 * provider cost × 1.3. Unknown models are priced at the most expensive entry.
 */
export const PRICE_MICROS_PER_TOKEN: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  mock: { input: 1, output: 5 },
};

export const MARKUP_PERCENT = 130;

export function costMicros(c: Completion): number {
  const fallback = { input: 20, output: 100 };
  const price = PRICE_MICROS_PER_TOKEN[c.model] ?? fallback;
  const provider = c.inputTokens * price.input + c.outputTokens * price.output;
  return Math.ceil((provider * MARKUP_PERCENT) / 100);
}

/** Deterministic, offline LLM for tests and local dev without an API key. */
export class MockLlm implements Llm {
  async complete({
    prompt,
    maxTokens,
  }: {
    prompt: string;
    maxTokens: number;
  }): Promise<Completion> {
    // Lets tests exercise the refusal path the real model can take.
    if (prompt.includes("[refuse]"))
      throw new LlmRefusal("Claude declined this input. Try different text.");
    const sentences = prompt.split(/(?<=[.!?])\s+/).filter(Boolean);
    const text = sentences.slice(0, 2).join(" ") || prompt.slice(0, 200);
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.min(maxTokens, Math.ceil(text.length / 4) + 20);
    return { text: `[mock] ${text}`, model: "mock", inputTokens, outputTokens };
  }
}

export class AnthropicLlm implements Llm {
  private readonly client = new Anthropic();

  constructor(private readonly model = "claude-opus-5-5") {}

  async complete({
    system,
    prompt,
    maxTokens,
  }: {
    system?: string;
    prompt: string;
    maxTokens: number;
  }): Promise<Completion> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      // Low effort: these are short, cheap demo calls with a hard price cap.
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal")
      throw new LlmRefusal("Claude declined this input. Try different text.");
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

/** DEMO_LLM=anthropic|mock; defaults to mock unless an API key is configured. */
export function llmFromEnv(): Llm {
  const mode = process.env.DEMO_LLM ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock");
  return mode === "anthropic" ? new AnthropicLlm(process.env.DEMO_CHAT_MODEL) : new MockLlm();
}
