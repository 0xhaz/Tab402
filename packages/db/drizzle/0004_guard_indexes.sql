CREATE INDEX "charges_buyer_created_idx" ON "charges" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "charges_key_created_idx" ON "charges" USING btree ("agent_key_id","created_at");--> statement-breakpoint
CREATE INDEX "charges_buyer_endpoint_created_idx" ON "charges" USING btree ("buyer_id","endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "charges_buyer_seller_idx" ON "charges" USING btree ("buyer_id","seller_id");