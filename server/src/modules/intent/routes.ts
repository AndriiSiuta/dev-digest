import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrIntentRecord } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { IntentService } from './service.js';

/**
 * intent module — derive a PR's intent & scope before review.
 *
 *   GET  /pulls/:id/intent  → the persisted classification (404 until classified)
 *   POST /pulls/:id/intent  → (re)classify now; costs one cheap model call
 *
 * Both routes declare `schema.response` — the serializer strips anything the
 * handler did not promise (an output allowlist, not a formality).
 */
export default async function intentRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new IntentService(app.container);

  app.get(
    '/pulls/:id/intent',
    { schema: { params: IdParams, response: { 200: PrIntentRecord } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const record = await service.get(workspaceId, req.params.id);
      if (!record) throw new NotFoundError('Intent not classified yet');
      return record;
    },
  );

  // Tight per-route limit: each call is a paid model call (mirror
  // POST /pulls/:id/review).
  app.post(
    '/pulls/:id/intent',
    {
      schema: { params: IdParams, response: { 200: PrIntentRecord } },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      // req.id is the request-scoped correlation id pino already stamps on every
      // other line of this request, so the prompt line joins them.
      return service.classify(workspaceId, req.params.id, req.log, req.id);
    },
  );
}
