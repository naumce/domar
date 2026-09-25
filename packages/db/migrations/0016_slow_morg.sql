CREATE TYPE "public"."account_slot" AS ENUM('owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund', 'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slot" "account_slot" NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" char(7) NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"debit_total_minor" bigint DEFAULT 0 NOT NULL,
	"credit_total_minor" bigint DEFAULT 0 NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_code_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_codes" ADD CONSTRAINT "account_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_codes_tenant_slot_idx" ON "account_codes" USING btree ("tenant_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_periods_tenant_period_idx" ON "accounting_periods" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_periods_tenant_closed_idx" ON "accounting_periods" USING btree ("tenant_id","closed_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_account_code_id_account_codes_id_fk" FOREIGN KEY ("account_code_id") REFERENCES "public"."account_codes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
