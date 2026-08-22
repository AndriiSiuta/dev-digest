/* hooks/blast.ts — React Query hook for the Blast Radius panel. Computed
   fresh on every request server-side (no model call, nothing persisted), so
   this is a plain GET with no mutation counterpart. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { BlastPanel } from "@devdigest/shared";

/**
 * A PR's blast radius: changed symbols → callers → endpoint/cron facts, plus
 * the prior-PR overlap history.
 *
 * Query key is deliberately its OWN `["pr-blast", prId]` (mirroring
 * `usePrIntent`'s `["pr-intent", prId]`), NOT the `["reviews", prId]` prefix
 * `useSmartDiff` piggybacks on: that piggyback exists because smart-diff data
 * is review-derived and must refetch on every review invalidation — blast is
 * derived from `pr_files` + the repo-intel index and does not change on
 * review events, so riding those invalidations would only cause pointless
 * refetches.
 */
export function useBlastPanel(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-blast", prId],
    queryFn: () => api.get<BlastPanel>(`/pulls/${prId}/blast`),
    enabled: !!prId,
  });
}
