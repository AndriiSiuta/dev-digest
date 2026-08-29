import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ProjectContextDoc,
  ProjectContextDocContent,
  RepoContextSettings,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { ProjectContextService } from './service.js';

/**
 * project-context module — the editor-facing half.
 *
 *   GET /repos/:repoId/context/documents          → discovered documents
 *   GET /repos/:repoId/context/documents/content  → one document, read-only
 *   GET /repos/:repoId/context/search-roots       → resolved roots
 *   PUT /repos/:repoId/context/search-roots       → set this repo's roots
 *
 * Attachment lives with its aggregate, not here: `PUT /agents/:id/context-docs`
 * and `PUT /skills/:id/context-docs` are in those modules, because those
 * repositories own the link tables and therefore the version snapshots.
 *
 * Every handler resolves tenancy through `getContext` and passes `workspaceId`
 * down; the service 404s a repo outside the workspace before any checkout is
 * touched (AC-NF-03).
 */

const RepoParams = z.object({ repoId: z.string().uuid() });
const ContentQuery = z.object({ path: z.string().min(1) });

export default async function projectContextRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new ProjectContextService(app.container);

  app.get(
    '/repos/:repoId/context/documents',
    {
      schema: {
        params: RepoParams,
        // An output ALLOWLIST, not decoration: it is what makes it impossible
        // for a document body to leak through the list endpoint by accident.
        response: { 200: z.array(ProjectContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.listDocuments(workspaceId, req.params.repoId);
    },
  );

  // Read-only preview of ONE document. It must not write an attachment row —
  // previewing is not attaching (AC-06).
  app.get(
    '/repos/:repoId/context/documents/content',
    {
      schema: {
        params: RepoParams,
        querystring: ContentQuery,
        response: { 200: ProjectContextDocContent },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.readDocument(workspaceId, req.params.repoId, req.query.path);
    },
  );

  app.get(
    '/repos/:repoId/context/search-roots',
    { schema: { params: RepoParams, response: { 200: RepoContextSettings } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getSearchRoots(workspaceId, req.params.repoId);
    },
  );

  app.put(
    '/repos/:repoId/context/search-roots',
    {
      schema: {
        params: RepoParams,
        body: RepoContextSettings,
        response: { 200: RepoContextSettings },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.setSearchRoots(workspaceId, req.params.repoId, req.body.search_roots);
    },
  );
}
