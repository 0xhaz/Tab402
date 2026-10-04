import { z } from "zod";

/** Env fragments shared by services. Each app composes the ones it needs with `createEnv`. */

export const nodeEnv = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
};

export const database = {
  DATABASE_URL: z.url(),
};

/** 32-byte AES key, base64. Wraps per-merchant data keys. */
export const masterKey = {
  TAB402_MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
};

export const paypal = {
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().min(1).optional(),
};

export const anthropic = {
  ANTHROPIC_API_KEY: z.string().min(1),
};

export const port = (name: string, fallback: number) => ({
  [name]: z.coerce.number().int().positive().default(fallback),
});
