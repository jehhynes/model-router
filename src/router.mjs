import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { messageFilter } from './websocket.mjs';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host',
]);

// The client's own login; never sent to the model upstream.
const CLIENT_CREDENTIALS = new Set(['authorization', 'x-api-key', 'chatgpt-account-id', 'cookie']);

// Subscription limit headers. Clients would apply the model upstream's account limits to their own login.
const LIMIT_HEADERS = [
  /^anthropic-ratelimit-unified-/,
  /^x-codex-(primary|secondary|credits|active-limit|rate-limit|limit-name|promo)/,
];

// Codex applies this WebSocket message to its own login's limits, as it does the headers above.
const isLimitMessage = text => parseType(text) === 'codex.rate_limits';

const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_EARLY_BYTES = 1024 * 1024;

function parseType(text) {
  try {
    return JSON.parse(text)?.type;
  } catch {
    return undefined;
  }
}

/** Picks the upstream for a request path: the model upstream when a model path matches, else the passthrough. */
export function selectRoute(listener, path) {
  const pathname = path.split('?', 1)[0];
  const isModel = listener.model.paths.some(p => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`));
  if (isModel)
    return { kind: 'model', upstream: listener.model.upstream, apiKey: listener.model.apiKey };
  if (listener.passthrough)
    return { kind: 'passthrough', upstream: listener.passthrough };
  return null;
}

/** Header names the Connection header nominates as hop-by-hop, plus the fixed set. */
function hopByHop(headers) {
  const names = new Set(HOP_BY_HOP);
  for (const token of String(headers.connection ?? '').split(','))
    if (token.trim())
      names.add(token.trim().toLowerCase());
  return names;
}

export function upstreamRequestHeaders(headers, route) {
  const drop = hopByHop(headers);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (drop.has(name))
      continue;
    if (route.kind === 'model' && CLIENT_CREDENTIALS.has(name))
      continue;
    out[name] = value;
  }
  if (route.kind === 'model')
    out.authorization = `Bearer ${route.apiKey}`;
  return out;
}

const isLimitHeader = (route, name) => route.kind === 'model' && LIMIT_HEADERS.some(re => re.test(name));

export function clientResponseHeaders(headers, route) {
  const drop = hopByHop(headers);
  const out = {};
  for (const [name, value] of Object.entries(headers))
    if (!drop.has(name) && !isLimitHeader(route, name))
      out[name] = value;
  return out;
}

// A client reads 401 or 403 as a bad login of its own and refreshes or re-prompts, so the model upstream's are 502s.
function rejectsUpstreamAuth(route, status) {
  return route.kind === 'model' && (status === 401 || status === 403);
}

function errorBody(message) {
  return JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-router: ${message}` } });
}

// The request target is forwarded as received, so routing and the upstream see the same path.
function send(route, req, headers) {
  const base = new URL(route.upstream);
  return (base.protocol === 'https:' ? https : http).request({
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port,
    method: req.method,
    path: req.url,
    headers: { ...headers, host: base.host },
  });
}

const isOriginForm = url => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');

export function createRouter(listener, log = () => {}) {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const route = isOriginForm(req.url) ? selectRoute(listener, req.url) : null;
    let logged = false;
    const done = (status, note = '') => {
      if (logged)
        return;
      logged = true;
      log(`${listener.name} ${req.method} ${String(req.url).split('?', 1)[0]} -> ${route?.kind ?? 'none'} ${status} ${Date.now() - started}ms${note}`);
    };
    const fail = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(errorBody(message));
      done(status, ` (${message})`);
    };

    if (!isOriginForm(req.url))
      return fail(400, 'the request target must be a path');
    if (!route)
      return fail(404, `no route for ${req.url}`);

    let upstream;
    try {
      upstream = send(route, req, upstreamRequestHeaders(req.headers, route));
    } catch (err) {
      return fail(502, `cannot reach ${route.upstream}: ${err.message}`);
    }

    upstream.on('response', up => {
      if (rejectsUpstreamAuth(route, up.statusCode)) {
        up.resume();
        return fail(502, `the model upstream ${route.upstream} rejected its API key with ${up.statusCode}`);
      }
      res.writeHead(up.statusCode, up.statusMessage, clientResponseHeaders(up.headers, route));
      // pipeline destroys the client response when the upstream response ends early.
      pipeline(up, res, err => done(up.statusCode, err ? ` (${err.message})` : ''));
    });

    upstream.on('error', err => {
      if (res.headersSent)
        return res.destroy(err);
      fail(502, `${route.upstream} is unreachable: ${err.message}`);
    });

    res.on('close', () => {
      if (res.writableFinished)
        return;
      done('-', ' (client closed)');
      upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const route = isOriginForm(req.url) ? selectRoute(listener, req.url) : null;
    let upstream;
    let timer;
    let negotiating = true;
    // Reading the client socket during the handshake is what reports its end; the bytes wait for the upstream.
    const early = [];
    let earlyBytes = 0;
    const hold = chunk => {
      early.push(chunk);
      earlyBytes += chunk.length;
      if (earlyBytes > MAX_EARLY_BYTES)
        reject(400, 'the client sent data before the upgrade completed');
    };
    const abandon = () => {
      if (endNegotiation())
        upstream?.destroy();
    };
    const endNegotiation = () => {
      if (!negotiating)
        return false;
      negotiating = false;
      clearTimeout(timer);
      socket.off('data', hold);
      for (const event of ['end', 'close', 'error'])
        socket.off(event, abandon);
      return true;
    };
    const reject = (status, message) => {
      if (!endNegotiation())
        return;
      upstream?.destroy();
      early.length = 0;
      const response = `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${errorBody(message)}`;
      socket.end(response, () => socket.destroy());
      log(`${listener.name} UPGRADE ${String(req.url).split('?', 1)[0]} -> ${route?.kind ?? 'none'} ${status}`);
    };

    socket.on('data', hold);
    for (const event of ['end', 'close', 'error'])
      socket.on(event, abandon);
    if (!isOriginForm(req.url))
      return reject(400, 'the request target must be a path');
    if (!route)
      return reject(404, `no route for ${req.url}`);

    const headers = { ...upstreamRequestHeaders(req.headers, route), connection: 'Upgrade', upgrade: req.headers.upgrade };
    // Without compression the router can read the messages it filters.
    if (route.kind === 'model')
      delete headers['sec-websocket-extensions'];

    try {
      upstream = send(route, req, headers);
    } catch (err) {
      return reject(502, `cannot reach ${route.upstream}: ${err.message}`);
    }
    timer = setTimeout(() => reject(504, `${route.upstream} did not complete the upgrade`), HANDSHAKE_TIMEOUT_MS);

    upstream.on('upgrade', (up, upSocket, upHead) => {
      if (!endNegotiation())
        return upSocket.destroy();
      const drop = hopByHop(up.headers);
      const lines = [`HTTP/1.1 101 ${up.statusMessage || 'Switching Protocols'}`, 'Connection: Upgrade', `Upgrade: ${up.headers.upgrade}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        const name = up.rawHeaders[i].toLowerCase();
        if (!drop.has(name) && !isLimitHeader(route, name))
          lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      socket.pause();
      for (const chunk of [head, ...early])
        if (chunk.length)
          upSocket.write(chunk);
      early.length = 0;

      // WebSocket has no half-close, and an upgraded socket stays half-open after the peer's FIN.
      for (const event of ['end', 'close']) {
        upSocket.on(event, () => socket.destroy());
        socket.on(event, () => upSocket.destroy());
      }
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());

      if (route.kind === 'model') {
        const toClient = messageFilter(isLimitMessage);
        if (upHead.length)
          toClient.write(upHead);
        pipeline(upSocket, toClient, socket, err => {
          // Either side closing the connection ends the pipeline early; only other errors are worth a line.
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE')
            log(`${listener.name} UPGRADE ${req.url.split('?', 1)[0]} closed: ${err.message}`);
        });
      } else {
        if (upHead.length)
          socket.write(upHead);
        upSocket.pipe(socket);
      }
      socket.pipe(upSocket);
      log(`${listener.name} UPGRADE ${req.url.split('?', 1)[0]} -> ${route.kind} 101`);
    });

    upstream.on('response', up => {
      up.resume();
      if (rejectsUpstreamAuth(route, up.statusCode))
        return reject(502, `the model upstream ${route.upstream} rejected its API key with ${up.statusCode}`);
      reject(up.statusCode, `${route.upstream} refused the upgrade`);
    });

    upstream.on('error', err => reject(502, `${route.upstream} is unreachable: ${err.message}`));
    upstream.end();
  });

  return server;
}
