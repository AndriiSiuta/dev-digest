#!/usr/bin/env node
/**
 * mcp-trace — a dev-only tap on the DevDigest MCP endpoint.
 *
 * Listens on 127.0.0.1:3999 and forwards to 127.0.0.1:3001/mcp, printing both
 * directions as they happen. Point a second MCP client at the proxy:
 *
 *   claude mcp add --transport http devdigest-traced http://127.0.0.1:3999/mcp
 *
 * WHY A PROXY. The MCP Inspector connects as a client — its Protocol tab shows
 * only its OWN connection, so it can never show what a different client sends.
 * Server-side logging would work but the response never passes through Fastify's
 * serializer (`routes.ts` hijacks the reply and the transport writes `reply.raw`
 * itself), so a tap in the route would have to wrap a hijacked stream. Sitting in
 * the path instead costs zero production code and sees the actual bytes.
 *
 * NOTHING IS BUFFERED ON THE WAY BACK. `devdigest_run_agent_on_pull_request`
 * blocks for minutes and reports itself through SSE progress frames; buffering
 * the response would collapse exactly the thing you launched this to watch.
 *
 * Usage:
 *   node scripts/mcp-trace.mjs [--port 3999] [--target 127.0.0.1:3001] [--full] [--keepalive]
 */

import http from 'node:http';
import process from 'node:process';

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has('help') || has('h')) {
  process.stdout.write(
    'mcp-trace — tap the DevDigest MCP endpoint\n\n' +
      '  --port <n>            listen port           (default 3999)\n' +
      '  --target <host:port>  upstream API          (default 127.0.0.1:3001)\n' +
      '  --full                do not truncate payloads\n' +
      '  --keepalive           also show SSE `: keepalive` comments\n',
  );
  process.exit(0);
}

const PORT = Number(flag('port', 3999));
const [TARGET_HOST, TARGET_PORT] = flag('target', '127.0.0.1:3001').split(':');
const FULL = has('full');
const SHOW_KEEPALIVE = has('keepalive');

/** Truncation ceilings. Findings arrays are the reason these exist. */
const ARG_MAX = FULL ? Infinity : 300;
const RESULT_MAX = FULL ? Infinity : 600;

// --- output -----------------------------------------------------------------

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, s) => (COLOR ? `[${code}m${s}[0m` : s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const cyan = (s) => paint('36', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const magenta = (s) => paint('35', s);

/** `14:22:07.114` — wall clock, because you are correlating against another terminal. */
const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return dim(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`);
};

const elapsed = (startedAt) => {
  const ms = Date.now() - startedAt;
  return dim(ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
};

/** Continuation lines align under the arrow column. */
const INDENT = ' '.repeat(21);
const emit = (line) => process.stdout.write(`${line}\n`);
const emitBlock = (text) => {
  if (text === '') return;
  for (const line of text.split('\n')) emit(INDENT + dim(line));
};

const compact = (value, max) => {
  if (value === undefined) return '';
  let s;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) return '';
  return s.length > max ? `${s.slice(0, max)}… ${dim(`(${s.length} B)`)}` : s;
};

// --- JSON-RPC summarising ---------------------------------------------------

/**
 * A tool result arrives as `content[0].text` holding our own JSON projection.
 * Unwrapping it is what turns the transcript from an envelope dump into the
 * thing you actually wanted to read.
 */
function unwrapToolResult(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeRequest(msg) {
  const { method, params } = msg;
  if (method === 'initialize') {
    const info = params?.clientInfo;
    const who = info ? `${info.name} ${info.version ?? ''}`.trim() : 'unknown client';
    return { head: cyan('initialize'), detail: dim(`(${who}, wants ${params?.protocolVersion ?? '?'})`) };
  }
  if (method === 'tools/call') {
    const token = params?._meta?.progressToken;
    return {
      head: `${cyan('tools/call')}  ${bold(params?.name ?? '?')}`,
      detail: token === undefined ? dim('(no progressToken)') : '',
      block: compact(params?.arguments, ARG_MAX),
    };
  }
  return { head: cyan(method ?? '?'), block: compact(params, ARG_MAX) };
}

function describeResponse(msg, startedAt) {
  if (msg.error !== undefined) {
    return {
      arrow: red('<-'),
      head: `${red('error')} ${msg.error.code}  ${msg.error.message ?? ''}`,
      detail: elapsed(startedAt),
    };
  }

  const result = msg.result;

  // initialize
  if (result?.protocolVersion !== undefined) {
    const caps = Object.keys(result.capabilities ?? {}).join(',');
    return {
      arrow: green('<-'),
      head: `${green(result.protocolVersion)}  ${result.serverInfo?.name ?? ''} caps=[${caps}]`,
      detail: elapsed(startedAt),
    };
  }

  // tools/list
  if (Array.isArray(result?.tools)) {
    return {
      arrow: green('<-'),
      head: `${green('tools')} ${result.tools.length}`,
      detail: elapsed(startedAt),
      block: result.tools.map((t) => t.name).join(', '),
    };
  }

  // tools/call
  const payload = unwrapToolResult(result);
  if (payload !== undefined) {
    const isError = result?.isError === true;
    const tag = isError ? red('result (isError)') : green('result');
    let head = tag;
    if (payload !== null && typeof payload === 'object') {
      const bits = [];
      if (payload.status !== undefined) bits.push(`status=${payload.status}`);
      if (payload.verdict !== undefined) bits.push(`verdict=${payload.verdict}`);
      if (payload.score !== undefined) bits.push(`score=${payload.score}`);
      if (payload.counts !== undefined) bits.push(`counts=${compact(payload.counts, 80)}`);
      if (payload.count !== undefined) bits.push(`count=${payload.count}`);
      if (payload.error !== undefined) bits.push(yellow(`guidance=${payload.error}`));
      if (bits.length > 0) head = `${tag}  ${bits.join('  ')}`;
    }
    return { arrow: green('<-'), head, detail: elapsed(startedAt), block: compact(payload, RESULT_MAX) };
  }

  return { arrow: green('<-'), head: green('result'), detail: elapsed(startedAt), block: compact(result, RESULT_MAX) };
}

function printMessage(msg, direction, startedAt) {
  if (direction === 'up') {
    const { head, detail, block } = describeRequest(msg);
    emit(`${stamp()} ${bold('->')} ${head} ${detail ?? ''}`.trimEnd());
    emitBlock(block ?? '');
    return;
  }

  // Notifications carry no id and are the live signal during a blocking call.
  if (msg.method === 'notifications/progress') {
    const p = msg.params ?? {};
    const pct = p.total ? `${Math.round((p.progress / p.total) * 100)}%` : `${p.progress ?? ''}`;
    emit(`${stamp()} ${magenta('<~')} ${magenta('progress')} ${String(pct).padStart(4)}  ${p.message ?? ''}`.trimEnd());
    return;
  }
  if (msg.method === 'notifications/message') {
    const p = msg.params ?? {};
    emit(`${stamp()} ${magenta('<~')} ${magenta(`log/${p.level ?? '?'}`)}  ${compact(p.data, ARG_MAX)}`);
    return;
  }
  if (msg.method !== undefined) {
    emit(`${stamp()} ${magenta('<~')} ${magenta(msg.method)}  ${compact(msg.params, ARG_MAX)}`);
    return;
  }

  const { arrow, head, detail, block } = describeResponse(msg, startedAt);
  emit(`${stamp()} ${arrow} ${head}  ${detail}`.trimEnd());
  emitBlock(block ?? '');
}

/** A JSON-RPC payload is a single message or a batch. */
const forEachMessage = (parsed, fn) => (Array.isArray(parsed) ? parsed.forEach(fn) : fn(parsed));

// --- SSE framing ------------------------------------------------------------

/**
 * The transport answers `text/event-stream` and emits its own `: keepalive`
 * comment every 15 s unprompted, so comments are dropped unless asked for.
 * Events are separated by a blank line; `data:` lines within one event join.
 */
function createSseParser(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8').replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) {
          if (SHOW_KEEPALIVE) emit(`${stamp()} ${dim('<~')} ${dim(line.trim() || ': keepalive')}`);
          continue;
        }
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;

      try {
        onMessage(JSON.parse(data.join('\n')));
      } catch {
        emit(`${stamp()} ${dim('<~')} ${dim(`unparsed frame (${data.join('\n').length} B)`)}`);
      }
    }
  };
}

// --- proxy ------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const startedAt = Date.now();

    if (body.length > 0) {
      try {
        forEachMessage(JSON.parse(body.toString('utf8')), (m) => printMessage(m, 'up', startedAt));
      } catch {
        emit(`${stamp()} ${bold('->')} ${req.method} ${req.url} ${dim(`(${body.length} B, not JSON)`)}`);
      }
    } else {
      emit(`${stamp()} ${bold('->')} ${req.method} ${req.url}`);
    }

    // The upstream Host allowlist (routes.ts hook 2) rejects anything that is not
    // a loopback name, so the proxy's own Host must be rewritten, never relayed.
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    delete headers['transfer-encoding'];
    if (body.length > 0) headers['content-length'] = String(body.length);

    const upstream = http.request(
      { host: TARGET_HOST, port: Number(TARGET_PORT), path: req.url, method: req.method, headers },
      (up) => {
        const contentType = up.headers['content-type'] ?? '';

        if (up.statusCode !== 200) {
          emit(`${stamp()} ${red('<-')} ${red(`HTTP ${up.statusCode}`)}  ${elapsed(startedAt)}`);
        }

        res.writeHead(up.statusCode ?? 502, up.headers);
        res.flushHeaders?.();

        // Stream through untouched; tee a copy into the parser. Anything that
        // waits for `end` here would hide every progress frame until the call
        // was already over.
        if (contentType.includes('text/event-stream')) {
          const feed = createSseParser((m) => printMessage(m, 'down', startedAt));
          up.on('data', (c) => {
            res.write(c);
            feed(c);
          });
        } else {
          const out = [];
          up.on('data', (c) => {
            res.write(c);
            out.push(c);
          });
          up.on('end', () => {
            const text = Buffer.concat(out).toString('utf8');
            if (text === '') return;
            try {
              forEachMessage(JSON.parse(text), (m) => printMessage(m, 'down', startedAt));
            } catch {
              emit(`${stamp()} ${green('<-')} ${dim(text.slice(0, RESULT_MAX))}  ${elapsed(startedAt)}`);
            }
          });
        }

        up.on('end', () => res.end());
      },
    );

    // A blocking review runs to a 10 min budget; no timer here may cut it short.
    upstream.setTimeout(0);
    upstream.on('error', (err) => {
      emit(`${stamp()} ${red('!!')} ${red('upstream')} ${err.code ?? err.message} ${dim(`${TARGET_HOST}:${TARGET_PORT}`)}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: `proxy: ${err.message}` }, id: null }));
    });

    res.on('close', () => upstream.destroy());
    upstream.end(body);
  });
});

server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.on('error', (err) => {
  emit(`${red('!!')} ${err.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  emit(`${bold('mcp-trace')} ${dim(`127.0.0.1:${PORT}  ->  ${TARGET_HOST}:${TARGET_PORT}/mcp`)}`);
  emit(dim(`  register in the other session:  claude mcp add --transport http devdigest-traced http://127.0.0.1:${PORT}/mcp`));
  emit(dim(`  ${FULL ? 'full payloads' : 'payloads truncated — pass --full for everything'}; Ctrl-C to stop`));
  emit('');
});

process.on('SIGINT', () => {
  emit(`\n${dim('mcp-trace stopped')}`);
  process.exit(0);
});
