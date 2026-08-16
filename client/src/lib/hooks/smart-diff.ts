/* hooks/smart-diff.ts — React Query hook for the Smart Diff "Files changed"
   view. Computed fresh on every request server-side (no model call, nothing
   persisted), so this is a plain GET with no mutation counterpart. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SmartDiffResponse } from "@devdigest/shared";

/**
 * A PR's Smart Diff: files classified core/wiring/boilerplate, overlaid with
 * the latest review's findings.
 *
 * Query key is deliberately `["reviews", prId, "smart-diff"]` — prefixed with
 * the same `["reviews", prId]` key `usePrReviews` uses — so every existing
 * `invalidateQueries({ queryKey: ["reviews", prId] })` call (run done,
 * delete-run, delete-review, finding accept/dismiss) already invalidates this
 * query too by TanStack Query's default prefix matching. No new invalidation
 * call is needed at any of those call sites.
 */
export function useSmartDiff(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["reviews", prId, "smart-diff"],
    queryFn: () => api.get<SmartDiffResponse>(`/pulls/${prId}/smart-diff`),
    enabled: !!prId,
  });
}
