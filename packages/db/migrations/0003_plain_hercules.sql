CREATE TYPE "public"."match_status" AS ENUM('unmatched', 'suggested', 'matched', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'bank_transfer', 'card', 'cheque', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('completed', 'voided');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"account_number" text,
	"line_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"invoice_id" uuid,
	"contact_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"reference" text,
	"note" text,
	"statement_line_id" uuid,
	"status" "payment_status" DEFAULT 'completed' NOT NULL,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"booked_at" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"counterparty" text,
	"reference" text,
	"raw" text NOT NULL,
	"fingerprint" text NOT NULL,
	"match_status" "match_status" DEFAULT 'unmatched' NOT NULL,
	"confidence" text,
	"suggested_invoice_id" uuid,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "invoice_sequences_pk";--> statement-breakpoint
DROP INDEX IF EXISTS "postings_tenant_contact_idx";--> statement-breakpoint
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_pk" PRIMARY KEY("tenant_id","year");--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "timezone" varchar(64) DEFAULT 'Europe/Skopje' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_suggested_invoice_id_invoices_id_fk" FOREIGN KEY ("suggested_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statements_tenant_building_idx" ON "bank_statements" USING btree ("tenant_id","building_id","imported_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_tenant_building_paid_idx" ON "payments" USING btree ("tenant_id","building_id","paid_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_tenant_invoice_idx" ON "payments" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_tenant_contact_paid_idx" ON "payments" USING btree ("tenant_id","contact_id","paid_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_lines_tenant_statement_idx" ON "statement_lines" USING btree ("tenant_id","statement_id","line_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_lines_tenant_building_status_idx" ON "statement_lines" USING btree ("tenant_id","building_id","match_status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statement_lines_fingerprint_idx" ON "statement_lines" USING btree ("building_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_status_due_idx" ON "invoices" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_building_idx" ON "invoices" USING btree ("tenant_id","building_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "postings_tenant_contact_idx" ON "postings" USING btree ("tenant_id","contact_id","booked_at");