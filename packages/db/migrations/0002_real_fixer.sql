CREATE TYPE "public"."fund" AS ENUM('regular', 'reserve');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'published', 'partially_paid', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."line_kind" AS ENUM('service', 'manual', 'reserve_fund', 'management_fee');--> statement-breakpoint
CREATE TYPE "public"."line_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('open', 'generated', 'published');--> statement-breakpoint
CREATE TYPE "public"."posting_account" AS ENUM('owner', 'fund');--> statement-breakpoint
CREATE TYPE "public"."posting_kind" AS ENUM('charge', 'payment', 'expense', 'adjustment', 'opening');--> statement-breakpoint
CREATE TYPE "public"."pricing_model" AS ENUM('fixed_per_unit', 'per_m2', 'shared_total');--> statement-breakpoint
CREATE TYPE "public"."reserve_basis" AS ENUM('per_unit', 'per_m2');--> statement-breakpoint
CREATE TYPE "public"."service_frequency" AS ENUM('monthly', 'every_n_months');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"period" char(7) NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"management_fee_minor" bigint DEFAULT 0 NOT NULL,
	"management_fee_tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"management_fee_applies_to" text[] DEFAULT '{apartment,commercial}'::text[] NOT NULL,
	"number_prefix" text DEFAULT 'INV-' NOT NULL,
	"number_suffix" text DEFAULT '/{year}' NOT NULL,
	"currency" char(3) NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"generated_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "building_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"price_minor" bigint,
	"pricing" "pricing_model",
	"frequency" "service_frequency" DEFAULT 'monthly' NOT NULL,
	"interval_months" integer DEFAULT 1 NOT NULL,
	"starts_period" char(7) NOT NULL,
	"ends_period" char(7),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"fund" "fund" NOT NULL,
	"description" text NOT NULL,
	"supplier_text" text,
	"amount_minor" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"period_line_id" uuid,
	"kind" "line_kind" NOT NULL,
	"description" text NOT NULL,
	"fund" "fund" NOT NULL,
	"unit_id" uuid,
	"unit_label" text DEFAULT '' NOT NULL,
	"building_wide_net_minor" bigint NOT NULL,
	"owner_net_minor" bigint NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"owner_tax_minor" bigint NOT NULL,
	"owner_gross_minor" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_sequences" (
	"tenant_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"number" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"currency" char(3) NOT NULL,
	"unit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"previous_balance_minor" bigint DEFAULT 0 NOT NULL,
	"amount_due_minor" bigint NOT NULL,
	"reserve_fund_building_balance_minor" bigint DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "period_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"pricing" "pricing_model" NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"applies_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"fund" "fund" DEFAULT 'regular' NOT NULL,
	"source" "line_source" DEFAULT 'manual' NOT NULL,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"account" "posting_account" NOT NULL,
	"fund" "fund" NOT NULL,
	"contact_id" uuid,
	"kind" "posting_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid,
	"period" char(7),
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reserve_fund_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"basis" "reserve_basis" DEFAULT 'per_unit' NOT NULL,
	"amount_minor" bigint DEFAULT 0 NOT NULL,
	"applies_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"pricing" "pricing_model" NOT NULL,
	"default_price_minor" bigint DEFAULT 0 NOT NULL,
	"tax_rate_id" uuid,
	"applies_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"recurring" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_services" ADD CONSTRAINT "building_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_services" ADD CONSTRAINT "building_services_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "building_services" ADD CONSTRAINT "building_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_period_line_id_period_lines_id_fk" FOREIGN KEY ("period_line_id") REFERENCES "public"."period_lines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "period_lines" ADD CONSTRAINT "period_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "period_lines" ADD CONSTRAINT "period_lines_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "period_lines" ADD CONSTRAINT "period_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "postings" ADD CONSTRAINT "postings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "postings" ADD CONSTRAINT "postings_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "postings" ADD CONSTRAINT "postings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reserve_fund_settings" ADD CONSTRAINT "reserve_fund_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reserve_fund_settings" ADD CONSTRAINT "reserve_fund_settings_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_periods_tenant_idx" ON "billing_periods" USING btree ("tenant_id","building_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_periods_building_period_idx" ON "billing_periods" USING btree ("building_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "building_services_tenant_building_idx" ON "building_services" USING btree ("tenant_id","building_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "building_services_unique_idx" ON "building_services" USING btree ("building_id","service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_tenant_building_idx" ON "expenses" USING btree ("tenant_id","building_id","paid_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_lines_tenant_invoice_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_sequences_pk" ON "invoice_sequences" USING btree ("tenant_id","year");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_period_idx" ON "invoices" USING btree ("tenant_id","period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_contact_idx" ON "invoices" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_tenant_number_idx" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "period_lines_tenant_period_idx" ON "period_lines" USING btree ("tenant_id","period_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "postings_tenant_building_fund_idx" ON "postings" USING btree ("tenant_id","building_id","fund","account");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "postings_tenant_contact_idx" ON "postings" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "postings_tenant_ref_idx" ON "postings" USING btree ("tenant_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reserve_fund_settings_tenant_idx" ON "reserve_fund_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reserve_fund_settings_building_idx" ON "reserve_fund_settings" USING btree ("building_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_tenant_idx" ON "services" USING btree ("tenant_id","name");