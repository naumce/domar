CREATE TYPE "public"."email_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reminder_channel" AS ENUM('email', 'letter');--> statement-breakpoint
CREATE TYPE "public"."reminder_reason" AS ENUM('consecutive', 'total');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'sent', 'failed', 'printed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"template" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid,
	"status" "email_status" NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"reason" "reminder_reason" NOT NULL,
	"invoice_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"total_outstanding_minor" bigint NOT NULL,
	"channel" "reminder_channel" NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"document_html" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_log" ADD CONSTRAINT "email_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_tenant_created_idx" ON "email_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_tenant_ref_idx" ON "email_log" USING btree ("tenant_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_tenant_building_idx" ON "reminders" USING btree ("tenant_id","building_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_tenant_contact_idx" ON "reminders" USING btree ("tenant_id","contact_id","created_at");