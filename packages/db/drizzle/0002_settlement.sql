CREATE TYPE "public"."settlement_kind" AS ENUM('capture', 'prepaid');--> statement-breakpoint
CREATE TABLE "seller_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"charge_id" text,
	"amount_micros" bigint NOT NULL,
	"reason" text NOT NULL,
	"payout_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "carry_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "setup_token" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "payer_email" text;--> statement-breakpoint
ALTER TABLE "payout_items" ADD COLUMN "carry_in_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_items" ADD COLUMN "carry_out_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "payout_carry_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "kind" "settlement_kind" DEFAULT 'capture' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "carry_in_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "carry_out_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "captured_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "top_ups" ADD COLUMN "fee_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "top_ups" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "seller_adjustments" ADD CONSTRAINT "seller_adjustments_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_adjustments" ADD CONSTRAINT "seller_adjustments_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_adjustments_seller_idx" ON "seller_adjustments" USING btree ("seller_id");