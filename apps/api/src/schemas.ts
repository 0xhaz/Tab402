import { z } from "@hono/zod-openapi";
import type { Network, PaymentRequirements } from "@tab402/core";

const micros = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .openapi({ description: "Micro-USD (6 decimals) as a string", example: "10000" });

export const PaymentRequirementsSchema = z
  .object({
    scheme: z.string(),
    network: z
      .string()
      .regex(/^[^:]+:.+$/)
      .openapi({ description: "CAIP-2 style network", example: "tab402:sandbox" }),
    asset: z.string(),
    amount: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number(),
    extra: z.record(z.string(), z.unknown()),
  })
  .openapi("PaymentRequirements");

export const PaymentPayloadSchema = z
  .object({
    x402Version: z.number(),
    accepted: PaymentRequirementsSchema,
    payload: z.record(z.string(), z.unknown()),
    resource: z.record(z.string(), z.unknown()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PaymentPayload");

export const VerifyRequestSchema = z
  .object({
    x402Version: z.literal(2),
    paymentPayload: PaymentPayloadSchema,
    paymentRequirements: PaymentRequirementsSchema,
  })
  .openapi("VerifyRequest");

export const SettleRequestSchema = VerifyRequestSchema.extend({
  amount: micros
    .optional()
    .openapi({ description: "Tab402 extension: actual cost for metered pricing" }),
}).openapi("SettleRequest");

export const VerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    payer: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("VerifyResponse");

export const SettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: z.string(),
    amount: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SettleResponse");

export const QuoteRequestSchema = z
  .object({
    method: z.string().openapi({ example: "POST" }),
    url: z.url().openapi({ example: "http://localhost:4200/v1/summarize" }),
  })
  .openapi("QuoteRequest");

export const PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    error: z.string().optional(),
    resource: z.object({
      url: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    }),
    accepts: z.array(PaymentRequirementsSchema),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PaymentRequired");

export const EndpointInputSchema = z
  .object({
    method: z.string(),
    url: z.url(),
    pricing: z.enum(["fixed", "metered"]),
    price: micros.openapi({ description: "Fixed price, or the maximum authorization for metered" }),
    description: z.string().optional(),
    category: z.string().optional(),
  })
  .openapi("EndpointInput");

export const AgentKeyRequestSchema = z
  .object({
    agentName: z.string().min(1).openapi({ example: "Claude Code" }),
    publicJwk: z.object({
      kty: z.literal("EC"),
      crv: z.literal("P-256"),
      x: z.string(),
      y: z.string(),
    }),
    dailyBudget: micros.optional(),
  })
  .openapi("AgentKeyRequest");

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

/** Zod validates the `ns:ref` network format; this narrows the type to x402's template literal. */
export function asRequirements(r: z.infer<typeof PaymentRequirementsSchema>): PaymentRequirements {
  return { ...r, network: r.network as Network };
}
