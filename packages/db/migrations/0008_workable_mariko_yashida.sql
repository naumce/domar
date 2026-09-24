CREATE TYPE "public"."period_kind" AS ENUM('regular', 'extraordinary');--> statement-breakpoint
CREATE TYPE "public"."contract_kind" AS ENUM('management', 'service', 'insurance', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('contract', 'minutes', 'report', 'invoice_supplier', 'photo', 'other');--> statement-breakpoint
CREATE TYPE "public"."legal_event_kind" AS ENUM('invoice_published', 'reminder_sent', 'assembly_invited', 'assembly_held', 'annual_report_issued', 'handover_report_issued', 'fund_statement_available', 'extraordinary_cost_distributed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "building_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"supplier_id" uuid,
	"kind" "contract_kind" NOT NULL,
	"title" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"notice_days" integer DEFAULT 0 NOT NULL,
	"amount_minor" bigint,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid,
	"kind" "document_kind" NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"kind" "legal_event_kind" NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"company_number" text,
	"vat_number" text,
	"email" text,
	"phone" text,
	"iban" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_periods_building_period_idx";--> statement-breakpoint
ALTER TABLE "billing_periods" ADD COLUMN "kind" "period_kind" DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD COLUMN "distribution_basis" "share_basis";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "document_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_contracts" ADD CONSTRAINT "building_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_contracts" ADD CONSTRAINT "building_contracts_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_contracts" ADD CONSTRAINT "building_contracts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_contracts" ADD CONSTRAINT "building_contracts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legal_events" ADD CONSTRAINT "legal_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legal_events" ADD CONSTRAINT "legal_events_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legal_events" ADD CONSTRAINT "legal_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "building_contracts_tenant_building_idx" ON "building_contracts" USING btree ("tenant_id","building_id","starts_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "building_contracts_tenant_kind_idx" ON "building_contracts" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_tenant_building_idx" ON "documents" USING btree ("tenant_id","building_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_tenant_kind_idx" ON "documents" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_storage_key_idx" ON "documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_events_tenant_building_idx" ON "legal_events" USING btree ("tenant_id","building_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_events_tenant_kind_idx" ON "legal_events" USING btree ("tenant_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_tenant_idx" ON "suppliers" USING btree ("tenant_id","name");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_periods_building_regular_period_idx" ON "billing_periods" USING btree ("building_id","period") WHERE "billing_periods"."kind" = 'regular';