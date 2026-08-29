import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PrBriefRecord } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { BRIEF_RATE_LIMIT } from './constants.js';

/**
 * brief module — the PR Brief (the Why + Risk card).
 *
 *   GET  /pulls/:id/brief   → the stored brief (404 until one is generated).
 *                             Never calls a model, even when the stored brief
 *                             is outdated: the envelope carries both head SHAs
 *                             so the card renders that state itself (AC-40).
 *   POST /pulls/:id/brief   → generate, or return the cached brief at the
 *                             current head; `?force=true` regenerates (AC-12).
 *
 * Both routes declare `schema.response` — the serializer strips anything the
 * handler did not promise (an output allowlist, not a formality).
 */

/**
 * The regenerate signal is a querystring ENUM, not a body.
 *
 * `client/src/lib/api.ts` deliberately omits `content-type` on a body-less
 * POST so Fastify does not raise "Body cannot be empty", so a required body
 * schema would 400 the first-generation call. `z.coerce.boolean()` is wrong for
 * the same job — it parses the string `"false"` as `true`.
 */
const ForceQuery = z.object({ force: z.enum(['true', 'false']).default('false') });

export default async function briefRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = app.container.brief;

  app.get(
    '/pulls/:id/brief',
    { schema: { params: IdParams, response: { 200: PrBriefRecord } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const record = await service.get(workspaceId, req.params.id);
      if (!record) throw new NotFoundError('Brief not generated yet');
      return record;
    },
  );

  // Tight per-route limit: each call is a paid model call (mirror
  // POST /pulls/:id/intent). NOTE: `@fastify/rate-limit` is only registered
  // when `config.nodeEnv !== 'test'` (`app.ts`), so this config is inert under
  // the config most tests build with.
  app.post(
    '/pulls/:id/brief',
    {
      schema: { params: IdParams, querystring: ForceQuery, response: { 200: PrBriefRecord } },
      config: { rateLimit: BRIEF_RATE_LIMIT },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      // req.id is the request-scoped correlation id pino already stamps on
      // every other line of this request, so the prompt line joins them.
      return service.generate(workspaceId, req.params.id, {
        force: req.query.force === 'true',
        logger: req.log,
        correlationId: req.id,
      });
    },
  );
}
