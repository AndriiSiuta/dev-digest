/* hooks/project-context.ts — React Query hooks for the agent editor's Context
   tab and the skill editor's "Project context to use" section.

   Project context is a set of markdown documents that live in the repository
   being reviewed. The studio stores only their PATHS; the text is read from the
   checkout at review time. Nothing here imports, indexes or edits a document. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  AgentContextDocLink,
  ProjectContextDoc,
  ProjectContextDocContent,
  RepoContextSettings,
  SkillContextDocLink,
} from "@devdigest/shared";

/**
 * Every document discoverable in a repository's checkout.
 *
 * Keyed under the existing `["context", repoId]` prefix so it rides the
 * invalidations that key already has, rather than opening a new top-level key
 * (`client/INSIGHTS.md`, 2026-08-16).
 */
export function useContextDocuments(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["context", repoId, "documents"],
    queryFn: () => api.get<ProjectContextDoc[]>(`/repos/${repoId}/context/documents`),
    enabled: !!repoId,
  });
}

/**
 * One document's content, for the read-only preview. `enabled` on a selected
 * path is what makes the preview strictly one-at-a-time: nothing is fetched
 * until a row is chosen, and choosing a row never attaches it.
 */
export function useContextDocumentContent(
  repoId: string | null | undefined,
  path: string | null | undefined,
) {
  return useQuery({
    queryKey: ["context", repoId, "document", path],
    queryFn: () =>
      api.get<ProjectContextDocContent>(
        `/repos/${repoId}/context/documents/content?path=${encodeURIComponent(path!)}`,
      ),
    enabled: !!repoId && !!path,
  });
}

/** The roots this repository is scanned under (its own, or the default). */
export function useContextSearchRoots(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["context", repoId, "search-roots"],
    queryFn: () => api.get<RepoContextSettings>(`/repos/${repoId}/context/search-roots`),
    enabled: !!repoId,
  });
}

/** An agent's attached documents across every repository. */
export function useAgentContextDocs(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-context-docs", agentId],
    queryFn: () => api.get<AgentContextDocLink[]>(`/agents/${agentId}/context-docs`),
    enabled: !!agentId,
  });
}

export interface SetContextDocsInput {
  /** Scopes the replacement. Sending the wrong repo wipes THAT repo's set. */
  repoId: string;
  docs: Array<{ path: string; enabled?: boolean }>;
}

/**
 * Replace the agent's attached documents FOR ONE REPOSITORY.
 *
 * `repo_id` is not decoration: the body replaces the set for that repository
 * only, so moving the Context tab's repo picker never disturbs what is attached
 * elsewhere. An attachment change bumps the agent's config version, so the
 * agent itself is invalidated too.
 */
export function useSetAgentContextDocs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, repoId, docs }: SetContextDocsInput & { agentId: string }) =>
      api.put<AgentContextDocLink[]>(`/agents/${agentId}/context-docs`, {
        repo_id: repoId,
        docs,
      }),
    onSuccess: (_d, { agentId }) => {
      qc.invalidateQueries({ queryKey: ["agent-context-docs", agentId] });
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/** A skill's attached documents across every repository. */
export function useSkillContextDocs(skillId: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-context-docs", skillId],
    queryFn: () => api.get<SkillContextDocLink[]>(`/skills/${skillId}/context-docs`),
    enabled: !!skillId,
  });
}

/**
 * Replace the skill's attached documents FOR ONE REPOSITORY. A change bumps the
 * skill's version, and it changes what every agent linking the skill sends.
 */
export function useSetSkillContextDocs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, repoId, docs }: SetContextDocsInput & { skillId: string }) =>
      api.put<SkillContextDocLink[]>(`/skills/${skillId}/context-docs`, {
        repo_id: repoId,
        docs,
      }),
    onSuccess: (_d, { skillId }) => {
      qc.invalidateQueries({ queryKey: ["skill-context-docs", skillId] });
      qc.invalidateQueries({ queryKey: ["skill-versions", skillId] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });
}
