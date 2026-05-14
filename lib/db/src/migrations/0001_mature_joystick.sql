ALTER TABLE "outreach_drafts" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ALTER COLUMN "facility_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "con_filing_id" uuid;