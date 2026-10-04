CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired', 'used');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"agent_key_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"intent" text,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"used_charge_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_cache" (
	"agent_key_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"price_band" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"outcome" "guard_outcome" NOT NULL,
	"decision_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guard_decisions" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_cache" ADD CONSTRAINT "guard_cache_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_buyer_status_idx" ON "approvals" USING btree ("buyer_id","status");--> statement-breakpoint
CREATE INDEX "approvals_key_endpoint_idx" ON "approvals" USING btree ("agent_key_id","endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guard_cache_key_idx" ON "guard_cache" USING btree ("agent_key_id","seller_id","endpoint_id","price_band","policy_version");