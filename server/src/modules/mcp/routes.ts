/**
 * mcp module — the single Streamable HTTP endpoint.
 *
 *   POST   /mcp   the JSON-RPC entry point (stateless, one transport per request)
 *   GET    /mcp   405 — no standalone SSE stream
 *   DELETE /mcp   405 — no sessions to terminate
 *
 * THIS ROUTE IS UNAUTHENTICATED AND IT SPENDS MONEY. `run_agent_on_pull_request`
 * starts a real LLM review, and the app binds `0.0.0.0` (unchanged here, on
 * purpose — Docker and the dev script depend on it). Three `onRequest` guards,
 * scoped to this plugin by Fastify's encapsulation, are what keep it local:
 *
 *   1. PEER ADDRESS — `request.socket.remoteAddress` must be loopback. The only
 *      one of the three a header cannot spoof, and therefore the load-bearing
 *      one. The other two are defence in depth against DNS-rebinding, which is
 *      exactly what the MCP spec's Host/Origin advice targets.
 *   2. HOST — an allowlist of loopback hosts plus the configured web origin.
 *   3. ORIGIN — same allowlist, but only WHEN PRESENT: CLI clients (Claude Code
 *      included) send no Origin, and rejecting its absence would reject them.
 *
 * NO `schema.response` on any of these. The POST hijacks the reply and the
 * transport writes `reply.raw` itself, so a serializer would never see the body;
 * the 405s and the 403s are literals built here.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { getContext } from '../_shared/context.js';
import { MCP_ROUTE } from './constants.js';
import { buildMcpServer } from './server.js';
import type { McpDeps } from './types.js';

/** Hostnames that mean "this machine". `[::1]` is how a Host header spells `::1`. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Own bucket: an MCP call is expensive but a session legitimately makes several. */
const MCP_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

export default async function mcpRoutes(app: FastifyInstance) {
  const { container } = app;
  const webHost = hostOf(container.config.webOrigin);

  const forbidden = (reply: FastifyReply, message: string) =>
    reply.code(403).send({ error: { code: 'forbidden', message } });

  // ---- 1. peer address ----------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    const peer = req.socket.remoteAddress;
    if (isLoopbackAddress(peer)) return;
    req.log.warn({ peer, url: req.url }, 'mcp: rejected non-loopback peer');
    return forbidden(reply, 'The DevDigest MCP endpoint accepts loopback connections only');
  });

  // ---- 2. Host allowlist --------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    const host = hostnameOf(req.headers.host);
    if (host !== undefined && (LOOPBACK_HOSTNAMES.has(host) || host === webHost)) return;
    req.log.warn({ host: req.headers.host }, 'mcp: rejected foreign Host header');
    return forbidden(reply, 'Host is not allowed for the DevDigest MCP endpoint');
  });

  // ---- 3. Origin, only when present ---------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    const raw = req.headers.origin;
    if (raw === undefined || raw === 'null') return; // CLI clients send none.
    const origin = hostnameOf(raw);
    if (origin !== undefined && (LOOPBACK_HOSTNAMES.has(origin) || origin === webHost)) return;
    req.log.warn({ origin: raw }, 'mcp: rejected foreign Origin header');
    return forbidden(reply, 'Origin is not allowed for the DevDigest MCP endpoint');
  });

  // ---- POST /mcp ----------------------------------------------------------
  app.post(MCP_ROUTE, { config: { rateLimit: MCP_RATE_LIMIT } }, async (req, reply) => {
    // Tenancy resolves here, at the edge, exactly like every other route; the
    // server below closes over the value, so a per-request build is what keeps
    // one workspace's context out of another's request.
    const { workspaceId } = await getContext(container, req);

    const deps: McpDeps = {
      agentsRepo: container.agentsRepo,
      reposRepo: container.reposRepo,
      pullsRepo: container.pullsRepo,
      conventionsRepo: container.conventionsRepo,
      reviewRunner: container.reviewRunner,
      // Wired although only the blast-radius STUB reads it, so switching that
      // tool to the real facade stays a one-line change in one file.
      repoIntel: container.repoIntel,
      runBus: container.runBus,
    };

    const server = buildMcpServer(deps, { workspaceId, logger: req.log });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Both die with the response. A blocking tool call can outlive the client,
    // and a leaked transport keeps a subscription and a socket handle alive.
    reply.raw.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    /**
     * `reply.hijack()` hands the socket to the transport. MEASURED: it is not
     * load-bearing here — the transport ends `reply.raw` itself, Fastify 5
     * derives `sent` from that, `onResponse` fires and `app.inject()` returns
     * either way. It is kept because it costs nothing, states the intent, and is
     * the guard the day a path leaves `reply.raw` un-ended.
     */
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp: transport failed');
      // Past hijack the app's error handler is out of the loop, so the JSON-RPC
      // error envelope is written by hand — and only if nothing was sent yet.
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  // ---- GET / DELETE /mcp → 405 -------------------------------------------
  // Not required — MEASURED: Claude Code 2.1.2 probes `GET /mcp`, takes the bare
  // 404 and still reports `✔ Connected`. 405 is the spec's answer for "no
  // standalone SSE stream", it is cheaper than falling through to the app's
  // generic 404, and it keeps the loopback guards applied to the probe.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({
        error: {
          code: 'method_not_allowed',
          message: 'The DevDigest MCP endpoint speaks POST only (no standalone SSE stream)',
        },
      });

  app.get(MCP_ROUTE, { config: { rateLimit: MCP_RATE_LIMIT } }, methodNotAllowed);
  app.delete(MCP_ROUTE, { config: { rateLimit: MCP_RATE_LIMIT } }, methodNotAllowed);
}

/**
 * IPv4 `127.0.0.0/8`, IPv6 `::1`, and the IPv4-mapped form Node reports on a
 * dual-stack socket (`::ffff:127.0.0.1`). An undefined address means the socket
 * is already gone — treated as not loopback.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (addr === '::1' || addr === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** `host:port` / an absolute origin → its hostname, lowercased. */
function hostnameOf(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const withScheme = value.includes('://') ? value : `http://${value}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The configured web origin's hostname — the one non-loopback name allowed. */
function hostOf(origin: string): string | undefined {
  return hostnameOf(origin);
}
