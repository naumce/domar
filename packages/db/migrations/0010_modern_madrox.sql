CREATE TYPE "public"."assembly_channel" AS ENUM('email', 'letter');--> statement-breakpoint
CREATE TYPE "public"."assembly_invitation_status" AS ENUM('pending', 'sent', 'failed', 'printed');--> statement-breakpoint
CREATE TYPE "public"."assembly_status" AS ENUM('draft', 'invited', 'held', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."decision_result" AS ENUM('pending', 'passed', 'rejected', 'no_quorum');--> statement-breakpoint
CREATE TYPE "public"."quorum_basis" AS ENUM('share', 'count');--> statement-breakpoint
CREATE TYPE "public"."vote_choice" AS ENUM('for', 'against', 'abstain');--> statement-breakpoint
CREATE TYPE "public"."vote_via" AS ENUM('portal', 'paper');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assemblies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"agenda" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "assembly_status" DEFAULT 'draft' NOT NULL,
	"quorum_basis" "quorum_basis" DEFAULT 'share' NOT NULL,
	"invited_at" timestamp with time zone,
	"held_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"late_invitation" boolean DEFAULT false NOT NULL,
	"late_reason" text,
	"invitation_html" text,
	"minutes_html" text,
	"minutes_document_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assembly_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assembly_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"present" boolean DEFAULT false NOT NULL,
	"proxy_name" text,
	"weight_bp" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assembly_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assembly_id" uuid NOT NULL,
	"title" text NOT NULL,
	"text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"for_weight" integer DEFAULT 0 NOT NULL,
	"against_weight" integer DEFAULT 0 NOT NULL,
	"abstain_weight" integer DEFAULT 0 NOT NULL,
	"present_weight" integer DEFAULT 0 NOT NULL,
	"basis_total" integer DEFAULT 0 NOT NULL,
	"quorum_reached" boolean DEFAULT false NOT NULL,
	"result" "decision_result" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assembly_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assembly_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" "assembly_channel" NOT NULL,
	"status" "assembly_invitation_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"email_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assembly_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assembly_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"choice" "vote_choice" NOT NULL,
	"via" "vote_via" NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assemblies" ADD CONSTRAINT "assemblies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assemblies" ADD CONSTRAINT "assemblies_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assemblies" ADD CONSTRAINT "assemblies_minutes_document_id_documents_id_fk" FOREIGN KEY ("minutes_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assemblies" ADD CONSTRAINT "assemblies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_attendance" ADD CONSTRAINT "assembly_attendance_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_attendance" ADD CONSTRAINT "assembly_attendance_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_attendance" ADD CONSTRAINT "assembly_attendance_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_decisions" ADD CONSTRAINT "assembly_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_decisions" ADD CONSTRAINT "assembly_decisions_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_invitations" ADD CONSTRAINT "assembly_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_invitations" ADD CONSTRAINT "assembly_invitations_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_invitations" ADD CONSTRAINT "assembly_invitations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_invitations" ADD CONSTRAINT "assembly_invitations_email_log_id_email_log_id_fk" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_log"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_votes" ADD CONSTRAINT "assembly_votes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_votes" ADD CONSTRAINT "assembly_votes_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_votes" ADD CONSTRAINT "assembly_votes_decision_id_assembly_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."assembly_decisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_votes" ADD CONSTRAINT "assembly_votes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assemblies_tenant_building_idx" ON "assemblies" USING btree ("tenant_id","building_id","scheduled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assemblies_tenant_status_idx" ON "assemblies" USING btree ("tenant_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assembly_attendance_tenant_assembly_idx" ON "assembly_attendance" USING btree ("tenant_id","assembly_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assembly_attendance_assembly_contact_idx" ON "assembly_attendance" USING btree ("assembly_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assembly_decisions_tenant_assembly_idx" ON "assembly_decisions" USING btree ("tenant_id","assembly_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assembly_invitations_tenant_assembly_idx" ON "assembly_invitations" USING btree ("tenant_id","assembly_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assembly_invitations_assembly_contact_idx" ON "assembly_invitations" USING btree ("assembly_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assembly_votes_tenant_assembly_idx" ON "assembly_votes" USING btree ("tenant_id","assembly_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assembly_votes_decision_contact_idx" ON "assembly_votes" USING btree ("decision_id","contact_id");