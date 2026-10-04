CREATE TYPE "public"."capture_status" AS ENUM('pending', 'captured', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."charge_state" AS ENUM('earned', 'collected', 'paid_out', 'refunded', 'disputed', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."guard_decider" AS ENUM('rule', 'cache', 'model', 'human');--> statement-breakpoint
CREATE TYPE "public"."guard_outcome" AS ENUM('approve', 'deny', 'ask');--> statement-breakpoint
CREATE TYPE "public"."key_status" AS ENUM('active', 'frozen', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."mandate_mode" AS ENUM('prepaid', 'postpaid');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('pending', 'active', 'frozen', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'success', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."pricing_mode" AS ENUM('fixed', 'metered', 'per_request_domain', 'tiered');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('issued', 'paid', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."rail" AS ENUM('paypal_wallet', 'braintree_card', 'invoicing', 'pyusd');--> statement-breakpoint
CREATE TYPE "public"."recon_state" AS ENUM('matched', 'pending', 'rejected', 'corrected', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."secret_kind" AS ENUM('paypal_client_secret', 'webhook_signing_secret', 'vault_token');--> statement-breakpoint
CREATE TYPE "public"."seller_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "agent_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"parent_key_id" text,
	"public_jwk" jsonb NOT NULL,
	"status" "key_status" DEFAULT 'active' NOT NULL,
	"daily_budget_micros" bigint,
	"budget_cap_micros" bigint,
	"scope" jsonb,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_kind" text NOT NULL,
	"subject_ids" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"input_redacted" jsonb,
	"decision" text NOT NULL,
	"reasoning" text,
	"model" text NOT NULL,
	"model_version" text,
	"latency_ms" integer NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd_micros" bigint,
	"human_override" text
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"buyer_id" text PRIMARY KEY NOT NULL,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
	"floor_micros" bigint DEFAULT 2000000 NOT NULL,
	"top_up_micros" bigint DEFAULT 10000000 NOT NULL,
	"auto_top_up" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_non_negative" CHECK ("balances"."balance_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_key_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"cumulative_authorized_micros" bigint DEFAULT 0 NOT NULL,
	"cumulative_recorded_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_recorded_le_authorized" CHECK ("channels"."cumulative_recorded_micros" <= "channels"."cumulative_authorized_micros")
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"agent_key_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"voucher_id" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"authorized_micros" bigint NOT NULL,
	"state" charge_state DEFAULT 'earned' NOT NULL,
	"prepaid" boolean DEFAULT false NOT NULL,
	"held" boolean DEFAULT false NOT NULL,
	"intent" text,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charges_amount_le_authorized" CHECK ("charges"."amount_micros" <= "charges"."authorized_micros")
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"category" text,
	"pricing_mode" "pricing_mode" NOT NULL,
	"price_micros" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events_out" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_key_id" text NOT NULL,
	"quote_id" text,
	"seller_id" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"intent" text,
	"outcome" "guard_outcome" NOT NULL,
	"decided_by" "guard_decider" NOT NULL,
	"rule" text,
	"reason" text,
	"ai_decision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"provider" text DEFAULT 'paypal' NOT NULL,
	"rail" "rail" NOT NULL,
	"mode" "mandate_mode" DEFAULT 'prepaid' NOT NULL,
	"status" "mandate_status" DEFAULT 'pending' NOT NULL,
	"vault_secret_id" text,
	"credit_limit_micros" bigint DEFAULT 10000000 NOT NULL,
	"successful_captures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" "secret_kind" NOT NULL,
	"blob" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_items" (
	"id" text PRIMARY KEY NOT NULL,
	"payout_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"fee_micros" bigint DEFAULT 0 NOT NULL,
	"paypal_item_id" text,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"recon_state" "recon_state" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_batch_id" text NOT NULL,
	"paypal_payout_batch_id" text,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"total_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_sender_batch_id_unique" UNIQUE("sender_batch_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"buyer_id" text PRIMARY KEY NOT NULL,
	"daily_budget_micros" bigint DEFAULT 10000000 NOT NULL,
	"per_call_max_micros" bigint DEFAULT 1000000 NOT NULL,
	"approval_threshold_micros" bigint DEFAULT 2000000 NOT NULL,
	"allowlist" jsonb,
	"blocklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"categories" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"pricing_mode" "pricing_mode" NOT NULL,
	"status" "quote_status" DEFAULT 'issued' NOT NULL,
	"agent_key_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"status" "seller_status" DEFAULT 'active' NOT NULL,
	"payout_receiver" text,
	"webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_items" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"gross_micros" bigint NOT NULL,
	"processor_fee_micros" bigint NOT NULL,
	"platform_fee_micros" bigint NOT NULL,
	"net_micros" bigint NOT NULL,
	"recon_state" "recon_state" DEFAULT 'pending' NOT NULL,
	"payout_item_id" text
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"rail" "rail" NOT NULL,
	"gross_micros" bigint NOT NULL,
	"processor_fee_micros" bigint DEFAULT 0 NOT NULL,
	"status" "capture_status" DEFAULT 'pending' NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "top_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"status" "capture_status" DEFAULT 'pending' NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"seq" integer NOT NULL,
	"cumulative_micros" bigint NOT NULL,
	"quote_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events_in" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_parent_key_id_agent_keys_id_fk" FOREIGN KEY ("parent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_out" ADD CONSTRAINT "events_out_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_decisions" ADD CONSTRAINT "guard_decisions_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_decisions" ADD CONSTRAINT "guard_decisions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_ups" ADD CONSTRAINT "top_ups_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_ups" ADD CONSTRAINT "top_ups_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_keys_buyer_idx" ON "agent_keys" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "agent_keys_parent_idx" ON "agent_keys" USING btree ("parent_key_id");--> statement-breakpoint
CREATE INDEX "agents_buyer_idx" ON "agents" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "ai_decisions_kind_created_idx" ON "ai_decisions" USING btree ("agent_kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_key_seller_idx" ON "channels" USING btree ("agent_key_id","seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_quote_idx" ON "charges" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "charges_buyer_state_idx" ON "charges" USING btree ("buyer_id","state");--> statement-breakpoint
CREATE INDEX "charges_seller_state_idx" ON "charges" USING btree ("seller_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoints_seller_method_url_idx" ON "endpoints" USING btree ("seller_id","method","url");--> statement-breakpoint
CREATE INDEX "events_out_seller_created_idx" ON "events_out" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX "guard_decisions_key_created_idx" ON "guard_decisions" USING btree ("agent_key_id","created_at");--> statement-breakpoint
CREATE INDEX "mandates_buyer_idx" ON "mandates" USING btree ("buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_secrets_owner_kind_idx" ON "merchant_secrets" USING btree ("owner_id","kind");--> statement-breakpoint
CREATE INDEX "payout_items_seller_idx" ON "payout_items" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "quotes_seller_created_idx" ON "quotes" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_items_charge_idx" ON "settlement_items" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "settlement_items_seller_idx" ON "settlement_items" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "settlements_buyer_idx" ON "settlements" USING btree ("buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_channel_seq_idx" ON "vouchers" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_quote_idx" ON "vouchers" USING btree ("quote_id");