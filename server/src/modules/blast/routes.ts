import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BlastPanel } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';

/**
 * blast module — the Blast Radius panel for a PR.
 *
 *   GET /pulls/:id/blast → changed symbols, callers grouped per symbol with
 *   endpoint/cron attribution, plus the prior-PR overlap history. No model
 *   call, nothing persisted: computed fresh on every request from `pr_files`
 *   + the repo-intel index.
 */
export default async function blastRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = app.container.blast;

  app.get(
    '/pulls/:id/blast',
    { schema: { params: IdParams, response: { 200: BlastPanel } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.get(workspaceId, req.params.id);
    },
  );
}
