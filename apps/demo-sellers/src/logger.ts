import pino from "pino";

/** Never log secrets, vault tokens or keys. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "*.authorization",
      "*.Authorization",
      "*.signature",
      "*.vaultToken",
      "*.vault_id",
      "*.clientSecret",
      "*.privateKey",
      "*.password",
      'headers["payment-signature"]',
    ],
    censor: "[redacted]",
  },
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});
