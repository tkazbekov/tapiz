DROP TABLE "account_session";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"account_id" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_google_id_unique";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "password_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_verify_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_verify_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "password_reset_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "password_reset_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_account_id_idx" ON "sessions" ("account_id");--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "google_id";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_verify_hash_unique" UNIQUE("email_verify_hash");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_password_reset_hash_unique" UNIQUE("password_reset_hash");--> statement-breakpoint
UPDATE "accounts" SET "email" = lower(trim("email")) WHERE "email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_identity_chk" CHECK (
  (NOT "is_guest" AND "email" IS NOT NULL)
  OR ("is_guest" AND "email" IS NULL AND "password_hash" IS NULL
      AND "api_token_hash" IS NULL AND "password_reset_hash" IS NULL
      AND "email_verify_hash" IS NULL AND "email_verified_at" IS NULL));
