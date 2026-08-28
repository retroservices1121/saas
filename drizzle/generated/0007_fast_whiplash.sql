ALTER TABLE "company_owners" ALTER COLUMN "phone_e164" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "phone_e164" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_owners" ADD COLUMN "invite_email" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "invite_email" text;