/* hooks/brief.ts — React Query hooks for the PR Brief card (the Why + Risk
   summary). Read the stored brief, or spend one structured model call to
   generate/regenerate it — so the write is a mutation, never a query. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type { PrBriefRecord } from "@devdigest/shared";

/**
 * The PR's stored brief. A 404 means "never generated" — an EMPTY state the
 * card renders a generate CTA for, not an error — so it maps to `null`
 * (the `usePrIntent` precedent). Anything else rethrows.
 *
 * The key is deliberately its OWN `["pr-brief", prId]` top-level key, NOT the
 * `["reviews", prId]` prefix `useSmartDiff` piggybacks on for free
 * invalidation: a stored brief stays current while the PR's head SHA is
 * unchanged, regardless of a new review, a re-classified intent or a changed
 * document set. Riding review invalidations would therefore be WRONG
 * behaviour, not merely a wasted refetch.
 */
export function usePrBrief(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-brief", prId],
    queryFn: async (): Promise<PrBriefRecord | null> => {
      try {
        return await api.get<PrBriefRecord>(`/pulls/${prId}/brief`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!prId,
  });
}

/**
 * Generate or regenerate the brief. One paid model call, so it is a mutation
 * — it must not re-run on a refocus. `force` is what separates regeneration
 * from first generation on the wire; one hook serves both controls, and the
 * card differentiates them, not the data layer.
 *
 * The response IS the fresh record, so it seeds the cache directly; a refetch
 * would be a second round trip for data already in hand.
 */
export function useGenerateBrief(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { force?: boolean }) =>
      api.post<PrBriefRecord>(`/pulls/${prId}/brief${vars?.force ? "?force=true" : ""}`),
    onSuccess: (record) => {
      qc.setQueryData(["pr-brief", prId], record);
    },
  });
}
