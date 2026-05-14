ALTER TYPE "public"."signal_type" ADD VALUE 'system_signal_propagated';--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "parent_system_id" uuid;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "fiscal_year_end_month" integer;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "fiscal_year_end_source" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_parent_system_id_facilities_id_fk" FOREIGN KEY ("parent_system_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;