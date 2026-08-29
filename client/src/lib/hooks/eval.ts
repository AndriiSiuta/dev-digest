/* hooks/eval.ts — React Query hooks for the eval pipeline: finding → frozen
   case → synchronous batch run → comparable numbers. Every key here is its
   OWN top level ("eval-cases" / "eval-batches" / "eval-batch" /
   "eval-dashboard") — nothing rides the ["reviews", …] prefix, because eval
   data must not churn on review activity (a new review changes no frozen
   case and no persisted batch). */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  EvalBatchDetail,
  EvalBatchSummary,
  EvalCase,
  EvalDashboardView,
} from "@devdigest/shared";

/** The agent's frozen case set (the Evals tab's list). */
export function useAgentEvalCases(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval-cases", agentId],
    queryFn: () => api.get<EvalCase[]>(`/agents/${agentId}/eval-cases`),
    enabled: !!agentId,
  });
}

/**
 * One-click case creation from a decided finding. The 409 `eval_case_exists`
 * outcome is surfaced to the caller (read `ApiError.code`), never retried —
 * the duplicate IS the answer. Body-less POST: `api.ts` omits content-type
 * when no body is sent, so Fastify accepts it.
 */
export function useCreateEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) =>
      api.post<EvalCase>(`/findings/${findingId}/eval-case`),
    onSuccess: () => {
      // Prefix invalidation: the finding card does not know which agent owns
      // the review, so every agent's case list is fair game.
      void qc.invalidateQueries({ queryKey: ["eval-cases"] });
    },
  });
}

export function useDeleteEvalCase(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) => api.del<{ ok: boolean }>(`/eval-cases/${caseId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["eval-cases", agentId] });
    },
  });
}

/**
 * Run the whole case set synchronously — one paid model call per case, so a
 * mutation, never a query. The response IS the fresh batch record: seed the
 * batch-detail cache with it instead of a second round trip, then invalidate
 * the history and dashboard lists it now belongs in.
 */
export function useRunEvalBatch(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvalBatchDetail>(`/agents/${agentId}/eval-runs`),
    onSuccess: (detail) => {
      qc.setQueryData(["eval-batch", agentId, detail.batch_id], detail);
      void qc.invalidateQueries({ queryKey: ["eval-batches", agentId] });
      void qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

/** The agent's batch history, newest first (AC-34). */
export function useEvalBatches(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval-batches", agentId],
    queryFn: () => api.get<EvalBatchSummary[]>(`/agents/${agentId}/eval-runs`),
    enabled: !!agentId,
  });
}

/**
 * One batch with its per-case rows. The comparison view mounts this twice
 * with two ids; `batchId: null` keeps the slot idle until a row is selected.
 */
export function useEvalBatch(
  agentId: string | null | undefined,
  batchId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["eval-batch", agentId, batchId],
    queryFn: () => api.get<EvalBatchDetail>(`/agents/${agentId}/eval-runs/${batchId}`),
    enabled: !!agentId && batchId != null,
  });
}

/** Workspace-wide case count + recent batches across all agents (AC-36). */
export function useEvalDashboard() {
  return useQuery({
    queryKey: ["eval-dashboard"],
    queryFn: () => api.get<EvalDashboardView>(`/eval/dashboard`),
  });
}
