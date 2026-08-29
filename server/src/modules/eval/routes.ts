import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EvalBatchDetail,
  EvalBatchSummary,
  EvalCase,
  EvalDashboardView,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { EVAL_RUN_RATE_LIMIT } from './constants.js';

/**
 * eval module — regression protection for review agents.
 *
 *   POST   /findings/:id/eval-case        one-click case from a decided finding
 *   GET    /agents/:id/eval-cases         the agent's case list
 *   DELETE /eval-cases/:id                remove a case (+ its results, cascade)
 *   POST   /agents/:id/eval-runs          run the whole set synchronously
 *   GET    /agents/:id/eval-runs          batch history (summaries)
 *   GET    /agents/:id/eval-runs/:batchId one batch with per-case rows
 *   GET    /eval/dashboard                workspace-wide dashboard
 *
 * Handlers parse → resolve context → delegate to `container.eval` → map.
 * Every route declares `schema.response` — the serializer strips anything the
 * facade did not promise (an output allowlist, AC-NF-03). Errors are thrown
 * `AppError`s, mapped by the shared handler in `app.ts`.
 */

const BatchParams = z.object({ id: z.string().uuid(), batchId: z.string().uuid() });

export default async function evalRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = app.container.eval;

  app.post(
    '/findings/:id/eval-case',
    { schema: { params: IdParams, response: { 201: EvalCase } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const created = await service.createCaseFromFinding(workspaceId, req.params.id);
      return reply.status(201).send(created);
    },
  );

  app.get(
    '/agents/:id/eval-cases',
    { schema: { params: IdParams, response: { 200: z.array(EvalCase) } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.listCases(workspaceId, req.params.id);
    },
  );

  app.delete(
    '/eval-cases/:id',
    { schema: { params: IdParams, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      await service.deleteCase(workspaceId, req.params.id);
      return { ok: true as const };
    },
  );

  // Tight per-route limit: each batch is one paid model call per case. NOTE:
  // `@fastify/rate-limit` is only registered when `config.nodeEnv !== 'test'`
  // (`app.ts`), so this config is inert under the config most tests build with.
  app.post(
    '/agents/:id/eval-runs',
    {
      schema: { params: IdParams, response: { 200: EvalBatchDetail } },
      config: { rateLimit: EVAL_RUN_RATE_LIMIT },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      // req.id is the request-scoped correlation id pino already stamps on
      // every other line of this request, so the batch line joins them.
      return service.runBatch(workspaceId, req.params.id, {
        logger: req.log,
        correlationId: req.id,
      });
    },
  );

  app.get(
    '/agents/:id/eval-runs',
    { schema: { params: IdParams, response: { 200: z.array(EvalBatchSummary) } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.listBatches(workspaceId, req.params.id);
    },
  );

  app.get(
    '/agents/:id/eval-runs/:batchId',
    { schema: { params: BatchParams, response: { 200: EvalBatchDetail } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getBatch(workspaceId, req.params.id, req.params.batchId);
    },
  );

  app.get(
    '/eval/dashboard',
    { schema: { response: { 200: EvalDashboardView } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.dashboard(workspaceId);
    },
  );
}
