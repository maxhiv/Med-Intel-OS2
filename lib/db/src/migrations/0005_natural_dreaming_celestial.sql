CREATE TABLE "national_ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"job_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"signals_inserted" integer DEFAULT 0 NOT NULL,
	"facilities_scanned" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limit_per_source" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "national_ingest_runs_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE INDEX "idx_national_ingest_runs_started" ON "national_ingest_runs" USING btree ("started_at");