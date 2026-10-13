CREATE TYPE "public"."role" AS ENUM('admin', 'member', 'guest');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" varchar(256) PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"email" varchar(320),
	"picture" varchar,
	"password_hash" varchar(255),
	"is_guest" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"email_verify_hash" varchar(64),
	"email_verify_expires_at" timestamp with time zone,
	"password_reset_hash" varchar(64),
	"password_reset_expires_at" timestamp with time zone,
	"api_token_hash" varchar(64),
	"api_token_created_at" timestamp,
	"settings" json DEFAULT '{"wheelInputMode":"auto","noteDefaults":{"backgroundColor":"#fbb980","textColor":"#000000","fontFamily":"\"Inter\", -apple-system, system-ui, sans-serif","bold":false,"italic":false}}'::json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email"),
	CONSTRAINT "accounts_email_verify_hash_unique" UNIQUE("email_verify_hash"),
	CONSTRAINT "accounts_password_reset_hash_unique" UNIQUE("password_reset_hash"),
	CONSTRAINT "accounts_api_token_hash_unique" UNIQUE("api_token_hash"),
	CONSTRAINT "accounts_identity_chk" CHECK ((NOT "accounts"."is_guest" AND "accounts"."email" IS NOT NULL)
        OR ("accounts"."is_guest" AND "accounts"."email" IS NULL AND "accounts"."password_hash" IS NULL
            AND "accounts"."api_token_hash" IS NULL AND "accounts"."password_reset_hash" IS NULL
            AND "accounts"."email_verify_hash" IS NULL AND "accounts"."email_verified_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "accounts_boards" (
	"account_id" varchar NOT NULL,
	"board_id" uuid NOT NULL,
	"private_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"last_accessed_at" timestamp,
	CONSTRAINT "accounts_boards_account_id_board_id" PRIMARY KEY("account_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "board_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(256) NOT NULL,
	"board" json NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"team_id" uuid,
	"public" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320),
	"user_id" varchar,
	"team_id" uuid,
	"board_id" uuid,
	"inviter_id" varchar NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_team_id_user_id_unique" UNIQUE("team_id","user_id"),
	CONSTRAINT "invitations_board_id_user_id_unique" UNIQUE("board_id","user_id"),
	CONSTRAINT "invitations_team_id_email_unique" UNIQUE("team_id","email"),
	CONSTRAINT "invitations_board_id_email_unique" UNIQUE("board_id","email")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(256) NOT NULL,
	"board_id" uuid,
	"user_id" varchar,
	"node_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"account_id" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_boards" (
	"space_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	CONSTRAINT "space_boards_space_id_board_id" PRIMARY KEY("space_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(256) NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "starreds" (
	"account_id" varchar NOT NULL,
	"board_id" uuid NOT NULL,
	CONSTRAINT "starreds_account_id_board_id" PRIMARY KEY("account_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"account_id" varchar NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	CONSTRAINT "team_members_team_id_account_id" PRIMARY KEY("team_id","account_id"),
	CONSTRAINT "team_members_role_chk" CHECK ("team_members"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(256) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts_boards" ADD CONSTRAINT "accounts_boards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts_boards" ADD CONSTRAINT "accounts_boards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_files" ADD CONSTRAINT "board_files_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_accounts_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_boards" ADD CONSTRAINT "space_boards_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_boards" ADD CONSTRAINT "space_boards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starreds" ADD CONSTRAINT "starreds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starreds" ADD CONSTRAINT "starreds_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_account_id_idx" ON "sessions" USING btree ("account_id");