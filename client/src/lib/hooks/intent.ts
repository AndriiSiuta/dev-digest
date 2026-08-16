/* hooks/intent.ts — React Query hooks for the PR Intent Layer.
   A PR's derived intent & scope: read the persisted classification, or trigger
   a (re)classification — one cheap model call, so it is a mutation. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type { PrIntentRecord } from "@devdigest/shared";

/**
 * The PR's persisted intent. A 404 means "not classified yet" — an EMPTY state
 * the card renders a CTA for, not an error — so it maps to `null`.
 */
export function usePrIntent(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-intent", prId],
    queryFn: async (): Promise<PrIntentRecord | null> => {
      try {
        return await api.get<PrIntentRecord>(`/pulls/${prId}/intent`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!prId,
  });
}

/**
 * (Re)classify the PR's intent. Costs one model call, so it is a mutation,
 * never a query — it must not re-run on a refocus. The response is the fresh
 * record, so it seeds the query cache instead of triggering a refetch.
 */
export function useClassifyIntent(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PrIntentRecord>(`/pulls/${prId}/intent`),
    onSuccess: (record) => {
      qc.setQueryData(["pr-intent", prId], record);
    },
  });
}
