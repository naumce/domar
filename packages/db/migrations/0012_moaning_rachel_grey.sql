CREATE TYPE "public"."maintenance_category" AS ENUM('plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other');--> statement-breakpoint
CREATE TYPE "public"."maintenance_event_kind" AS ENUM('created', 'status_changed', 'assigned', 'comment', 'photo_added');--> statement-breakpoint
CREATE TYPE "public"."maintenance_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."maintenance_status" AS ENUM('new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."maintenance_visibility" AS ENUM('internal', 'owner');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "maintenance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"kind" "maintenance_event_kind" NOT NULL,
	"from_status" "maintenance_status",
	"to_status" "maintenance_status",
	"note" text DEFAULT '' NOT NULL,
	"visibility" "maintenance_visibility" DEFAULT 'internal' NOT NULL,
	"author_user_id" uuid,
	"author_contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_events_author_chk" CHECK (num_nonnulls("maintenance_events"."author_user_id", "maintenance_events"."author_contact_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "maintenance_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"uploaded_by_contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "maintenance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"unit_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" "maintenance_category" NOT NULL,
	"priority" "maintenance_priority" DEFAULT 'normal' NOT NULL,
	"status" "maintenance_status" DEFAULT 'new' NOT NULL,
	"reported_by_user_id" uuid,
	"reported_by_contact_id" uuid,
	"assignee_user_id" uuid,
	"supplier_id" uuid,
	"fund" "fund",
	"cost_minor" bigint,
	"expense_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_requests_reporter_chk" CHECK (num_nonnulls("maintenance_requests"."reported_by_user_id", "maintenance_requests"."reported_by_contact_id") = 1)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_author_contact_id_contacts_id_fk" FOREIGN KEY ("author_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_uploaded_by_contact_id_contacts_id_fk" FOREIGN KEY ("uploaded_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_reported_by_contact_id_contacts_id_fk" FOREIGN KEY ("reported_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_events_tenant_request_idx" ON "maintenance_events" USING btree ("tenant_id","maintenance_request_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_photos_tenant_request_idx" ON "maintenance_photos" USING btree ("tenant_id","maintenance_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "maintenance_photos_document_idx" ON "maintenance_photos" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_requests_tenant_building_idx" ON "maintenance_requests" USING btree ("tenant_id","building_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_requests_tenant_status_idx" ON "maintenance_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_requests_tenant_assignee_idx" ON "maintenance_requests" USING btree ("tenant_id","assignee_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_requests_tenant_contact_idx" ON "maintenance_requests" USING btree ("tenant_id","reported_by_contact_id","created_at");