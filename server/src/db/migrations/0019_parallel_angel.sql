ALTER TABLE "pr_brief" ADD COLUMN "head_sha" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "generated_at" timestamp with time zone DEFAULT now() NOT NULL;