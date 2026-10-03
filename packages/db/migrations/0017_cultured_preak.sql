CREATE TABLE IF NOT EXISTS "owner_account_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_accounts" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "owner_account_identities" ADD CONSTRAINT "owner_account_identities_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "owner_account_identities_provider_subject_idx" ON "owner_account_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_account_identities_account_idx" ON "owner_account_identities" USING btree ("owner_account_id");