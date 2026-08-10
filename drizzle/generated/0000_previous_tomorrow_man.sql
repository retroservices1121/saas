CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'GRANT_CREATED', 'GRANT_REVOKED', 'COMPANY_CREATED', 'OWNER_INVITED', 'WORKER_CREATED', 'INVITE_SENT', 'INVITE_OPENED', 'INVITE_VERIFY_FAILED', 'FORM_SUBMITTED', 'SIGNATURE_CAPTURED', 'RECORD_CORRECTED', 'REVEAL_TIN', 'REVEAL_BANK', 'DOCUMENT_VIEWED', 'EXPORT_CREATED', 'EXPORT_DOWNLOADED', 'REMINDER_SENT', 'RECORD_PURGED', 'SECURITY_VIOLATION');--> statement-breakpoint
CREATE TYPE "public"."bank_account_type" AS ENUM('CHECKING', 'SAVINGS');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('ARTICLES_OF_INCORPORATION', 'WC_POLICY', 'WC_EXEMPTION', 'DISABILITY_POLICY', 'VOIDED_CHECK', 'ID_DOCUMENT', 'W9', 'W4', 'I9', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."invite_subject_type" AS ENUM('OWNER', 'WORKER');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('en', 'es');--> statement-breakpoint
CREATE TYPE "public"."note_visibility" AS ENUM('COMPANY_AND_FIRM', 'FIRM_ONLY');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('PENDING', 'IN_REVIEW', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."owner_status" AS ENUM('INVITED', 'IN_PROGRESS', 'SUBMITTED');--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY');--> statement-breakpoint
CREATE TYPE "public"."pay_type" AS ENUM('HOURLY', 'SALARY');--> statement-breakpoint
CREATE TYPE "public"."reminder_channel" AS ENUM('SMS', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('COMPANY_VISIBLE', 'FIRM_ONLY');--> statement-breakpoint
CREATE TYPE "public"."signature_document_type" AS ENUM('DATA_ACCURACY', 'DIRECT_DEPOSIT_AUTH', 'COMPANY_CERTIFICATION');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('COMPANY', 'OWNER', 'WORKER');--> statement-breakpoint
CREATE TYPE "public"."submitted_via" AS ENUM('WORKER_FORM', 'FIRM_ENTRY');--> statement-breakpoint
CREATE TYPE "public"."tin_type" AS ENUM('SSN', 'ITIN');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('PLATFORM_ADMIN', 'FIRM_ADMIN', 'FIRM_STAFF', 'COMPANY_ADMIN', 'COMPANY_STAFF');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."wc_status" AS ENUM('POLICY', 'EXEMPT', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('INVITED', 'IN_PROGRESS', 'SUBMITTED', 'NEEDS_ATTENTION', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."worker_type" AS ENUM('EMPLOYEE', 'SUBCONTRACTOR');--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"firm_id" uuid,
	"company_id" uuid,
	"password_hash" text,
	"totp_secret_enc" "bytea",
	"totp_enabled_at" timestamp with time zone,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"firm_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"dba_name" text,
	"ein" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"contact_email" text,
	"contact_phone" text,
	"operating_states" text[],
	"bank_name" text,
	"bank_routing_enc" "bytea",
	"bank_routing_last4" text,
	"bank_account_enc" "bytea",
	"bank_account_last4" text,
	"wc_status" "wc_status" DEFAULT 'PENDING' NOT NULL,
	"wc_policy_number" text,
	"wc_carrier" text,
	"wc_expires_on" date,
	"disability_policy_number" text,
	"disability_carrier" text,
	"disability_expires_on" date,
	"dek_ciphertext" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"dek_destroyed_at" timestamp with time zone,
	"onboarding_status" "onboarding_status" DEFAULT 'PENDING' NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"retention_years" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_company_grants" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"firm_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_owners" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"ownership_percent" numeric(5, 2),
	"phone_e164" text NOT NULL,
	"preferred_locale" "locale" DEFAULT 'en' NOT NULL,
	"status" "owner_status" DEFAULT 'INVITED' NOT NULL,
	"legal_first_name" text,
	"legal_middle_name" text,
	"legal_last_name" text,
	"date_of_birth" date,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"email" text,
	"tin_type" "tin_type",
	"tin_enc" "bytea",
	"tin_last4" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_records" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"worker_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"legal_first_name" text NOT NULL,
	"legal_middle_name" text,
	"legal_last_name" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"email" text,
	"phone_e164" text,
	"tin_type" "tin_type" NOT NULL,
	"tin_enc" "bytea" NOT NULL,
	"tin_last4" text NOT NULL,
	"bank_name" text,
	"bank_account_type" "bank_account_type",
	"routing_enc" "bytea",
	"routing_last4" text,
	"account_enc" "bytea",
	"account_last4" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"emergency_contact_relationship" text,
	"submitted_via" "submitted_via" NOT NULL,
	"submitted_ip" "inet",
	"submitted_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"worker_type" "worker_type" NOT NULL,
	"display_name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"preferred_locale" "locale" DEFAULT 'en' NOT NULL,
	"status" "worker_status" DEFAULT 'INVITED' NOT NULL,
	"job_title" text,
	"start_date" date,
	"pay_type" "pay_type",
	"pay_frequency" "pay_frequency",
	"work_state" text,
	"submitted_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"label" text,
	"s3_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_by_role" text NOT NULL,
	"uploaded_by_user_id" uuid,
	"sensitivity" "sensitivity" DEFAULT 'FIRM_ONLY' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_role" text NOT NULL,
	"author_user_id" uuid,
	"visibility" "note_visibility" DEFAULT 'FIRM_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"channel" "reminder_channel" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"document_type" "signature_document_type" NOT NULL,
	"document_version" text NOT NULL,
	"document_locale" "locale" NOT NULL,
	"document_hash" text NOT NULL,
	"typed_name" text NOT NULL,
	"consent_to_electronic" boolean NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"ip" "inet" NOT NULL,
	"user_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"firm_id" uuid,
	"company_id" uuid,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"reason" text,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"firm_id" uuid NOT NULL,
	"company_id" uuid,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"scope" jsonb,
	"include_sensitive" boolean DEFAULT false NOT NULL,
	"s3_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"downloaded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_generate_v7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"draft" jsonb,
	"draft_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_company_grants" ADD CONSTRAINT "firm_company_grants_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_company_grants" ADD CONSTRAINT "firm_company_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_company_grants" ADD CONSTRAINT "firm_company_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_company_grants" ADD CONSTRAINT "firm_company_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_owners" ADD CONSTRAINT "company_owners_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_records" ADD CONSTRAINT "worker_records_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_records" ADD CONSTRAINT "worker_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_firm_idx" ON "users" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "users" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "companies_firm_idx" ON "companies" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "grants_firm_idx" ON "firm_company_grants" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "grants_company_idx" ON "firm_company_grants" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_live_uq" ON "firm_company_grants" USING btree ("firm_id","company_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "owners_company_idx" ON "company_owners" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "worker_records_worker_idx" ON "worker_records" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_records_company_idx" ON "worker_records" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_records_current_uq" ON "worker_records" USING btree ("worker_id") WHERE is_current;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_records_version_uq" ON "worker_records" USING btree ("worker_id","version");--> statement-breakpoint
CREATE INDEX "workers_company_idx" ON "workers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "workers_status_idx" ON "workers" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "documents_company_idx" ON "documents" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "documents_subject_idx" ON "documents" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "documents_sensitivity_idx" ON "documents" USING btree ("company_id","sensitivity");--> statement-breakpoint
CREATE INDEX "notes_company_idx" ON "notes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "notes_subject_idx" ON "notes" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("scheduled_for") WHERE sent_at is null;--> statement-breakpoint
CREATE INDEX "reminders_subject_idx" ON "reminders" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "signatures_company_idx" ON "signatures" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "signatures_subject_idx" ON "signatures" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_company_idx" ON "audit_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "exports_firm_idx" ON "exports" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "exports_expiry_idx" ON "exports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "invites_subject_idx" ON "invites" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "invites_company_idx" ON "invites" USING btree ("company_id");