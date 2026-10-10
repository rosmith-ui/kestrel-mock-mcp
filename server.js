#!/usr/bin/env node
/**
 * Mock Cloudera MCP server for the Kestrel demo. Node 18+, no dependencies, no auth.
 *
 *   node mock-mcp/server.js            # http://localhost:3333/mcp
 *   PORT=4000 node mock-mcp/server.js  # hosts (Fly.io, Render, Docker) set PORT; binds all interfaces
 *
 * Implements MCP Streamable HTTP (protocol 2025-06-18), tools only:
 *   POST /mcp   JSON-RPC: initialize, notifications/initialized, ping, tools/list, tools/call
 *   GET  /mcp   405 (no server-initiated stream)
 *   DELETE /mcp ends the session
 *   POST /admin/reset   the non-MCP demo reset endpoint DemoReset calls (callout:Cloudera_Admin/admin/reset)
 *   GET  /      static landing page (plain HTML, no scripts, no external requests)
 *   GET  /health
 *   GET  /debug/recent  the last 100 request log lines (synthetic data only; for checking that calls arrived)
 * Tool get-credit-decision answers for KCB-00417, KCB-00418, KCB-00419 from ./payloads; any other borrower
 * returns an MCP tool error (isError: true). Responses are plain JSON (no SSE), which the MCP client accepts.
 * Sessions are lenient: initialize always opens a new session whatever Mcp-Session-Id it carries, and a stale,
 * deleted or unknown session id is served rather than refused (the log says which). Every response carries
 * Content-Length (204 aside) and a handler error answers 500 instead of crashing the process.
 * Connections are never reused: every response says Connection: close and node closes the socket after it, so
 * each MCP call arrives on a fresh connection. A caller (or proxy) that pools keep-alive connections can
 * otherwise send a later call down a socket the host has already closed, and that call hangs until it times out.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3333);
const PROTOCOL = '2025-06-18';
const TOOL = JSON.parse(fs.readFileSync(path.join(__dirname, 'tool.json'), 'utf8'));
const PAYLOADS = {};
for (const f of fs.readdirSync(path.join(__dirname, 'payloads'))) {
  if (f.endsWith('.json')) {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'payloads', f), 'utf8'));
    PAYLOADS[p.borrower_id] = p;
  }
}
const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kestrel mock MCP server</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#222}code{background:#f2f2f2;padding:0 .25rem}</style>
</head>
<body>
<h1>Kestrel mock MCP server</h1>
<p><strong>This is a mock.</strong> Every response uses synthetic data for the Kestrel Commercial Bank demo. Kestrel Commercial Bank is a fictional bank.</p>
<p>Hello, Cloudera team. This stands in for the real credit decision service until your endpoint is ready.</p>
<ul>
<li>MCP tool: <code>get-credit-decision</code> (MCP endpoint <code>/mcp</code>)</li>
<li>Hero borrowers: <code>KCB-00417</code>, <code>KCB-00418</code>, <code>KCB-00419</code></li>
<li>Health check: <code>/health</code></li>
</ul>
</body>
</html>
`;
const STARTED = new Date();
const sessions = new Map();   // session id -> { created, lastSeen, calls }
const deleted = new Set();
const resets = [];
const recent = [];            // last 100 request log lines, for GET /debug/recent

function json(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
// Bodyless answer with explicit framing; without Content-Length node sends a 202 chunked.
function empty(res, status, headers = {}) {
  res.writeHead(status, status === 204 ? headers : { 'Content-Length': 0, ...headers });
  res.end();
}
function sessionState(sid) {
  if (!sid) return 'none';
  if (sessions.has(sid)) return 'known';
  return deleted.has(sid) ? 'deleted' : 'unknown';
}
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function callTool(name, args) {
  args = args && typeof args === 'object' ? args : {};
  if (name !== TOOL.name) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const missing = TOOL.inputSchema.required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) {
    return { content: [{ type: 'text', text: `Missing arguments: ${missing.join(', ')}` }], isError: true };
  }
  const payload = PAYLOADS[String(args.borrower_id)];
  if (!payload) {
    return { content: [{ type: 'text', text: `Unknown borrower: ${args.borrower_id}. Mock knows ${Object.keys(PAYLOADS).join(', ')}.` }], isError: true };
  }
  // Fresh as_of so lineage looks live; everything else is the frozen contract payload.
  const out = JSON.parse(JSON.stringify(payload));
  out.lineage.as_of = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false };
}

function handleRpc(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { status: 400, body: rpcError(msg && msg.id, -32600, 'Invalid Request') };
  }
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (method) {
    case 'initialize': {
      // Always a fresh session, whatever Mcp-Session-Id the request carried.
      const sid = crypto.randomUUID();
      sessions.set(sid, { created: Date.now(), lastSeen: Date.now(), calls: 0 });
      return {
        status: 200,
        headers: { 'Mcp-Session-Id': sid },
        body: rpcResult(id, {
          protocolVersion: params.protocolVersion === PROTOCOL ? PROTOCOL : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kestrel-mock-credit-decision', version: '1.0.0' },
          instructions: 'Mock of the Cloudera credit decision service. Tools only. Knows borrowers KCB-00417, KCB-00418 and KCB-00419.'
        })
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202 };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: [TOOL] }) };
    case 'tools/call':
      return { status: 200, body: rpcResult(id, callTool(params.name, params.arguments)) };
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

function route(req, res, raw, log) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(LANDING), 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    return res.end(req.method === 'HEAD' ? undefined : LANDING);
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, protocol: PROTOCOL, tools: [TOOL.name], borrowers: Object.keys(PAYLOADS), resets: resets.length, started: STARTED.toISOString(), uptime_s: Math.round(process.uptime()), sessions: sessions.size });
  if (url.pathname === '/debug/recent') return json(res, 200, { now: new Date().toISOString(), lines: recent });
  if (url.pathname === '/admin/reset') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object') body = {};
    resets.push({ at: new Date().toISOString(), ...body });
    console.log(`[reset] ${JSON.stringify(body)}`);
    return json(res, 200, { ok: true, reset: body.borrower_ids || [], at: resets[resets.length - 1].at });
  }
  if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found; MCP endpoint is /mcp' });
  const sid = req.headers['mcp-session-id'];
  log.session = `${sid ? sid.slice(0, 8) : '-'}(${sessionState(sid)})`;
  if (req.method === 'GET') return json(res, 405, { error: 'no server-initiated stream' }, { Allow: 'POST, DELETE' });
  if (req.method === 'DELETE') {
    if (sid && sessions.delete(sid)) deleted.add(sid);
    return empty(res, 204);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, { Allow: 'POST, DELETE' });
  let msg;
  try { msg = JSON.parse(raw); } catch { return json(res, 400, rpcError(null, -32700, 'Parse error')); }
  const msgs = Array.isArray(msg) ? msg : [msg];
  log.rpc = msgs.map((m) => (m && m.method) || '?').join(',');
  const call = msgs.find((m) => m && m.method === 'tools/call');
  if (call && call.params && call.params.arguments) log.rpc += `(${call.params.arguments.borrower_id})`;
  const results = msgs.map((m) => handleRpc(m));
  if (sid && sessions.has(sid)) {
    const s = sessions.get(sid);
    s.lastSeen = Date.now();
    s.calls += msgs.filter((m) => m && m.method === 'tools/call').length;
  }
  const withBody = results.filter((r) => r.body);
  const headers = Object.assign({}, ...results.map((r) => r.headers || {}));
  if (!withBody.length) return empty(res, 202, headers);
  return json(res, 200, Array.isArray(msg) ? withBody.map((r) => r.body) : withBody[0].body, headers);
}

const server = http.createServer((req, res) => {
  const t0 = process.hrtime.bigint();
  const log = { session: '-', rpc: '' };
  let raw = '';
  // Count requests per socket: with Connection: close every request should be the first on its socket.
  req.socket.kestrelRequests = (req.socket.kestrelRequests || 0) + 1;
  const conn = req.socket.kestrelRequests === 1 ? 'new' : `reused#${req.socket.kestrelRequests}`;
  res.setHeader('Connection', 'close');
  // One line per request: method path session rpc-methods conn -> status, ms. "aborted" = socket closed before we finished.
  const line = (outcome) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const text = `[http] ${req.method} ${req.url} sid=${log.session}${log.rpc ? ` rpc=${log.rpc}` : ''} conn=${conn} -> ${outcome} ${ms.toFixed(1)}ms`;
    console.log(text);
    recent.push(`${new Date().toISOString()} ${text}`);
    if (recent.length > 100) recent.shift();
  };
  res.on('finish', () => line(res.statusCode));
  res.on('close', () => { if (!res.writableFinished) line('aborted'); });
  req.on('error', (e) => console.log(`[http] request error: ${e.message}`));
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      route(req, res, raw, log);
    } catch (e) {
      console.log(`[error] ${e.stack || e}`);
      if (!res.headersSent) json(res, 500, rpcError(null, -32603, 'Internal error'));
      else res.end();
    }
  });
});
// No keep-alive: Connection: close (above) ends each socket after its response. keepAliveTimeout is a short
// backstop for any socket left idle; 0 would mean "never time out" in node, the opposite of what we want.
server.keepAliveTimeout = 2000;
server.headersTimeout = 10000;

server.listen(PORT, () => {
  console.log(`kestrel mock MCP server: http://localhost:${PORT}/mcp  (protocol ${PROTOCOL}, tool ${TOOL.name}, borrowers ${Object.keys(PAYLOADS).join(', ')})`);
  console.log(`demo reset endpoint:    POST http://localhost:${PORT}/admin/reset`);
});

// Hosts and `docker stop` send SIGTERM; node as PID 1 ignores it unless handled.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { console.log(`${sig}: shutting down`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
