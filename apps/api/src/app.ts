import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Deps, Env } from "./context";
import { buyerRoutes } from "./routes/buyers";
import { chargeRoutes } from "./routes/charges";
import { directoryRoutes } from "./routes/directory";
import { facilitatorRoutes } from "./routes/facilitator";
import { guardRoutes } from "./routes/guard";
import { merchantRoutes } from "./routes/merchant";
import { payPalWebhookRoutes } from "./routes/paypal-webhooks";
import { sellerRoutes } from "./routes/sellers";
import { walletRoutes } from "./routes/wallet";

export function createApp(deps: Deps): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>();

  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description: "Tab402 API key: t402_sk_… (seller) or t402_bk_… (buyer)",
  });

  app.onError((err, c) => {
    (deps.onError ?? console.error)(err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "api" }));
  app.route("/", facilitatorRoutes(deps));
  app.route("/", sellerRoutes(deps));
  app.route("/", buyerRoutes(deps));
  app.route("/", walletRoutes(deps));
  app.route("/", guardRoutes(deps));
  app.route("/", chargeRoutes(deps));
  app.route("/", merchantRoutes(deps));
  app.route("/", directoryRoutes(deps));
  app.route("/", payPalWebhookRoutes(deps));

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Tab402 API",
      version: "0.1.0",
      description: "x402 facilitator for fiat tabs, plus seller and buyer APIs.",
    },
  });
  app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Tab402 API" }));
  return app;
}
