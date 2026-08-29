CREATE TABLE "skill_context_docs" (
	"skill_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "skill_context_docs_skill_id_repo_id_path_pk" PRIMARY KEY("skill_id","repo_id","path"),
	CONSTRAINT "skill_context_docs_path_ck" CHECK ("skill_context_docs"."path" <> '' and "skill_context_docs"."path" !~ '^/' and "skill_context_docs"."path" !~ '(^|/)\.\.($|/)')
);
--> statement-breakpoint
CREATE TABLE "agent_context_docs" (
	"agent_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "agent_context_docs_agent_id_repo_id_path_pk" PRIMARY KEY("agent_id","repo_id","path"),
	CONSTRAINT "agent_context_docs_path_ck" CHECK ("agent_context_docs"."path" <> '' and "agent_context_docs"."path" !~ '^/' and "agent_context_docs"."path" !~ '(^|/)\.\.($|/)')
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "context_search_roots" jsonb;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "context_docs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_context_docs" ADD CONSTRAINT "skill_context_docs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_context_docs" ADD CONSTRAINT "skill_context_docs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_docs" ADD CONSTRAINT "agent_context_docs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_docs" ADD CONSTRAINT "agent_context_docs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_context_docs_repo_idx" ON "skill_context_docs" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "agent_context_docs_repo_idx" ON "agent_context_docs" USING btree ("repo_id");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_context_search_roots_ck" CHECK ("repos"."context_search_roots" is null or jsonb_typeof("repos"."context_search_roots") = 'array');