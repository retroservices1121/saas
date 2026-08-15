CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"identifier" text NOT NULL,
	"ip" "inet",
	"succeeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_keys" (
	"purpose" text PRIMARY KEY NOT NULL,
	"dek_ciphertext" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"totp_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reauth_at" timestamp with time zone,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_setup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_counter" bigint;--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_idx" ON "login_attempts" USING btree ("identifier","created_at");--> statement-breakpoint
CREATE INDEX "staff_sessions_user_idx" ON "staff_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_sessions_expiry_idx" ON "staff_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_setup_tokens_user_idx" ON "user_setup_tokens" USING btree ("user_id");