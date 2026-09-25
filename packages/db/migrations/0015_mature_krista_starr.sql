DROP INDEX IF EXISTS "notifications_pending_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_pending_idx" ON "notifications" USING btree ("seq") WHERE delivered_at is null;