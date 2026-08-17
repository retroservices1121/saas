ALTER TABLE "worker_records" ALTER COLUMN "tin_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_records" ALTER COLUMN "tin_last4" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_owners" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_records" ADD COLUMN "purged_at" timestamp with time zone;