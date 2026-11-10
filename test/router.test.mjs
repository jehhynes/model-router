import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import zlib from 'node:zlib';
import { createRouter, hideModels, modelMatcher, selectRoute } from '../src/router.mjs';

const KEY = 'proxy-key';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(...servers) {
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
}

/** Upstream that records each request and answers with the handler for its path. */
function upstream(handlers = {}) {
  const seen = [];
  const arrived = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req)
      body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    arrived.shift()?.();
    const handler = handlers[req.url.split('?', 1)[0]];
    if (handler)
      return handler(req, res);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const nextArrival = () => new Promise(resolve => arrived.push(resolve));
  return { server, seen, nextArrival };
}

function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers }, res => {
      let text = '';
      res.on('data', c => text += c).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function rawRequest(base, text) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const socket = net.connect(Number(port), '127.0.0.1', () => socket.end(text));
    let reply = '';
    socket.on('data', d => reply += d).on('close', () => resolve(reply)).on('error', reject);
  });
}

describe('selectRoute', () => {
  const claude = { model: { upstream: 'http://m', apiKey: KEY, paths: ['/v1/messages'] }, passthrough: 'https://p' };
  const codex = { model: { upstream: 'http://m', apiKey: KEY, paths: ['/v1/'] }, passthrough: null };

  it('routes the model path and its subpaths to the model upstream', () => {
    assert.equal(selectRoute(claude, '/v1/messages?beta=true').kind, 'model');
    assert.equal(selectRoute(claude, '/v1/messages/count_tokens').kind, 'model');
  });

  it('passes through paths that only share a prefix with a model path', () => {
    assert.equal(selectRoute(claude, '/v1/messagesx').kind, 'passthrough');
    assert.equal(selectRoute(claude, '/api/hello').kind, 'passthrough');
  });

  it('matches every path under a model path that ends with a slash', () => {
    assert.equal(selectRoute(codex, '/v1/responses').kind, 'model');
    assert.equal(selectRoute(codex, '/v1/models?client_version=1').kind, 'model');
  });

  it('has no route outside the model paths when passthrough is null', () => {
    assert.equal(selectRoute(codex, '/backend-api/x'), null);
  });
});

describe('router', () => {
  const model = upstream({
    '/v1/messages/denied': (req, res) => res.writeHead(401).end('{"error":"bad key"}'),
    '/v1/messages/forbidden': (req, res) => res.writeHead(403).end('{"error":"forbidden"}'),
    '/v1/messages/stream': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      model.release = () => res.end('data: last\n\n');
    },
    '/v1/messages/truncate': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n', () => setTimeout(() => res.socket.destroy(), 20));
    },
    '/v1/messages/hang': (req, res) => {
      res.on('close', () => model.hangClosed?.());
    },
    '/v1/messages/connection': (req, res) => {
      res.setHeader('connection', 'x-secret');
      res.setHeader('x-secret', '1');
      res.setHeader('x-kept', '1');
      res.end('{}');
    },
    '/v1/messages': (req, res) => res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.99',
      'x-codex-primary-used-percent': '99',
      'x-codex-limit-name': 'codex',
      'request-id': 'req_1',
    }).end('{"model":true}'),
  });
  const pass = upstream({
    '/api/hello': (req, res) => res.writeHead(401, { 'anthropic-ratelimit-unified-5h-utilization': '0.5' }).end('nope'),
  });
  let router, base, modelUrl, passUrl;

  before(async () => {
    modelUrl = await listen(model.server);
    passUrl = await listen(pass.server);
    router = createRouter({
      name: 'test',
      passthrough: passUrl,
      model: { upstream: modelUrl, apiKey: KEY, paths: ['/v1/messages'] },
    });
    base = await listen(router);
  });

  after(() => close(router, model.server, pass.server));

  it('sends a model call to the model upstream with its key in place of the client credentials', async () => {
    const res = await request(base, '/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-oauth',
        'x-api-key': 'client-key',
        'chatgpt-account-id': 'acct',
        cookie: 'c=1',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: '{"prompt":"hi"}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"model":true}');
    const got = model.seen.at(-1);
    assert.equal(got.url, '/v1/messages?beta=true');
    assert.equal(got.body, '{"prompt":"hi"}');
    assert.equal(got.headers.authorization, `Bearer ${KEY}`);
    assert.equal(got.headers['x-api-key'], undefined);
    assert.equal(got.headers['chatgpt-account-id'], undefined);
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(got.headers.host, new URL(modelUrl).host);
  });

  it('forwards the request target exactly as received', async () => {
    const { port } = new URL(base);
    await new Promise((resolve, reject) =>
      http.request({ host: '127.0.0.1', port, path: '/v1/messages/%2e%2e/x?q=%20' }, res => res.resume().on('end', resolve)).on('error', reject).end());
    assert.equal(model.seen.at(-1).url, '/v1/messages/%2e%2e/x?q=%20');
  });

  it('strips subscription limit headers from model responses and keeps the others', async () => {
    const res = await request(base, '/v1/messages', { method: 'POST', body: '{}' });
    assert.equal(res.headers['anthropic-ratelimit-unified-5h-utilization'], undefined);
    assert.equal(res.headers['x-codex-primary-used-percent'], undefined);
    assert.equal(res.headers['x-codex-limit-name'], undefined);
    assert.equal(res.headers['request-id'], 'req_1');
  });

  it('drops headers that a Connection header names, in both directions', async () => {
    const res = await request(base, '/v1/messages/connection', { headers: { connection: 'x-private', 'x-private': '1' } });
    assert.equal(model.seen.at(-1).headers['x-private'], undefined);
    assert.equal(res.headers['x-secret'], undefined);
    assert.equal(res.headers['x-kept'], '1');
  });

  it('passes other calls through unchanged, including the client login, status and limit headers', async () => {
    const res = await request(base, '/api/hello', { method: 'HEAD', headers: { authorization: 'Bearer client-oauth' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers['anthropic-ratelimit-unified-5h-utilization'], '0.5');
    const got = pass.seen.at(-1);
    assert.equal(got.headers.authorization, 'Bearer client-oauth');
    assert.equal(got.headers.host, new URL(passUrl).host);
  });

  for (const [path, status] of [['/v1/messages/denied', 401], ['/v1/messages/forbidden', 403]]) {
    it(`turns a model upstream ${status} into a 502 that names the upstream`, async () => {
      const res = await request(base, path, { method: 'POST', body: '{}' });
      assert.equal(res.status, 502);
      assert.match(JSON.parse(res.body).error.message, new RegExp(`rejected its API key with ${status}`));
    });
  }

  it('forwards a streamed response before the upstream finishes', { timeout: 2000 }, async () => {
    const res = await new Promise((resolve, reject) => {
      http.request(new URL('/v1/messages/stream', base), { method: 'POST' }, resolve).on('error', reject).end('{}');
    });
    const [first] = await once(res, 'data');
    assert.equal(first.toString(), 'data: first\n\n');
    model.release();
    let rest = '';
    for await (const chunk of res)
      rest += chunk;
    assert.equal(rest, 'data: last\n\n');
  });

  it('closes the client response when the upstream response ends early', { timeout: 2000 }, async () => {
    const res = await new Promise((resolve, reject) => {
      http.request(new URL('/v1/messages/truncate', base), { method: 'POST' }, resolve).on('error', reject).end('{}');
    });
    const closed = new Promise(resolve => res.on('close', resolve));
    res.on('error', () => {});
    res.resume();
    await closed;
    assert.equal(res.complete, false);
  });

  it('closes the upstream request when the client disconnects', { timeout: 2000 }, async () => {
    const closed = new Promise(resolve => model.hangClosed = resolve);
    const arrived = model.nextArrival();
    const req = http.request(new URL('/v1/messages/hang', base), { method: 'POST' });
    req.on('error', () => {});
    req.end('{}');
    await arrived;
    req.destroy();
    await closed;
  });

  it('answers 400 for a request target that is not a path, and keeps serving', async () => {
    const reply = await rawRequest(base, 'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(reply, /^HTTP\/1\.1 400/);
    const res = await request(base, '/v1/messages', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
  });

  it('answers 502 when the model upstream is unreachable', async () => {
    const dead = http.createServer();
    const deadUrl = await listen(dead);
    dead.close();
    await once(dead, 'close');
    const r = createRouter({ name: 'dead', passthrough: null, model: { upstream: deadUrl, apiKey: KEY, paths: ['/v1/'] } });
    const url = await listen(r);
    try {
      const res = await request(url, '/v1/responses', { method: 'POST', body: '{}' });
      assert.equal(res.status, 502);
      assert.match(JSON.parse(res.body).error.message, /is unreachable/);
    } finally {
      close(r);
    }
  });

  it('answers 404 for a path with no route', async () => {
    const r = createRouter({ name: 'codex', passthrough: null, model: { upstream: modelUrl, apiKey: KEY, paths: ['/v1/'] } });
    const url = await listen(r);
    try {
      const res = await request(url, '/backend-api/x');
      assert.equal(res.status, 404);
    } finally {
      close(r);
    }
  });
});

describe('modelMatcher', () => {
  it('matches whole names, with * for any characters', () => {
    const isHidden = modelMatcher(['claude-*', 'gpt-6.1-sol']);
    assert.equal(isHidden('claude-opus-5-5'), true);
    assert.equal(isHidden('gpt-6.1-sol'), true);
    assert.equal(isHidden('gpt-6x1-sol'), false, 'a dot is literal');
    assert.equal(isHidden('my-claude-model'), false);
    assert.equal(isHidden('gpt-6.1-sol-mini'), false);
    assert.equal(isHidden(undefined), false);
  });

  it('matches nothing without patterns', () => {
    assert.equal(modelMatcher([])('claude-opus-5-5'), false);
  });
});

describe('hideModels', () => {
  const isHidden = modelMatcher(['claude-*']);

  it('removes hidden models from both list formats and keeps other fields', () => {
    const body = JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-6-sol' }, { id: 'claude-opus-5-5' }],
      models: [{ slug: 'claude-fable-5-2' }, { slug: 'gpt-6-luna', priority: 1 }],
    });
    assert.deepEqual(JSON.parse(hideModels(body, isHidden)), {
      object: 'list',
      data: [{ id: 'gpt-6-sol' }],
      models: [{ slug: 'gpt-6-luna', priority: 1 }],
    });
  });

  it('returns null for a body that is not a JSON object', () => {
    assert.equal(hideModels('not json', isHidden), null);
    assert.equal(hideModels('[]', isHidden), null);
    assert.equal(hideModels('null', isHidden), null);
  });
});

describe('model list', () => {
  const LIST = { data: [{ id: 'gpt-6-sol' }, { id: 'claude-opus-5-5' }], models: [{ slug: 'gpt-6-luna' }, { slug: 'claude-fable-5-2' }] };
  const model = upstream({
    '/v1/models': (req, res) => {
      const headers = { 'content-type': 'application/json', etag: '"full"', 'x-codex-primary-used-percent': '99' };
      if (req.headers['accept-encoding'] === 'gzip')
        return res.writeHead(200, { ...headers, 'content-encoding': 'gzip' }).end(zlib.gzipSync(JSON.stringify(LIST)));
      res.writeHead(200, headers).end(JSON.stringify(LIST));
    },
    '/v1/bad/models': (req, res) => res.writeHead(200).end('oops'),
    '/v1/gzip/models': (req, res) => res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(JSON.stringify(LIST))),
    '/v1/missing/models': (req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"none"}'),
  });
  const lines = [];
  let router, plain, base, plainBase;

  before(async () => {
    const modelUrl = await listen(model.server);
    const listener = { name: 'codex', passthrough: null, model: { upstream: modelUrl, apiKey: KEY, paths: ['/v1/'] } };
    router = createRouter({ ...listener, model: { ...listener.model, hiddenModels: ['claude-*'] } }, line => lines.push(line));
    plain = createRouter(listener);
    base = await listen(router);
    plainBase = await listen(plain);
  });

  after(() => close(router, plain, model.server));

  it('removes hidden models, asks for the list uncompressed and in full, and drops the ETag', async () => {
    const res = await request(base, '/v1/models?client_version=0.167.0', { headers: { 'accept-encoding': 'gzip', 'if-none-match': '"old"' } });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { data: [{ id: 'gpt-6-sol' }], models: [{ slug: 'gpt-6-luna' }] });
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)));
    assert.equal(res.headers.etag, undefined);
    assert.equal(res.headers['x-codex-primary-used-percent'], undefined);
    const seen = model.seen.at(-1);
    assert.equal(seen.url, '/v1/models?client_version=0.167.0');
    assert.equal(seen.headers['accept-encoding'], 'identity');
    assert.equal(seen.headers['if-none-match'], undefined);
  });

  it('sends the list unchanged without hidden models', async () => {
    const res = await request(plainBase, '/v1/models', { headers: { 'if-none-match': '"old"' } });
    assert.deepEqual(JSON.parse(res.body), LIST);
    assert.equal(res.headers.etag, '"full"');
    assert.equal(model.seen.at(-1).headers['if-none-match'], '"old"');
  });

  it('leaves other paths and methods alone', async () => {
    await request(base, '/v1/responses', { method: 'POST', headers: { 'accept-encoding': 'gzip' }, body: '{}' });
    assert.equal(model.seen.at(-1).headers['accept-encoding'], 'gzip');
    const res = await request(base, '/v1/models', { method: 'POST', body: '{}' });
    assert.deepEqual(JSON.parse(res.body), LIST);
  });

  it('sends a body that is not a JSON object unchanged and logs it', async () => {
    const res = await request(base, '/v1/bad/models');
    assert.equal(res.body, 'oops');
    assert.match(lines.at(-1), /GET \/v1\/bad\/models -> model 200 .*not a JSON object; sent unchanged/);
  });

  it('sends a list the upstream compressed anyway unchanged and logs it', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(new URL('/v1/gzip/models', base), r => {
        const chunks = [];
        r.on('data', c => chunks.push(c)).on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body)), LIST);
    assert.match(lines.at(-1), /model list sent unchanged: content-encoding gzip/);
  });

  it('passes an error status through unchanged', async () => {
    const res = await request(base, '/v1/missing/models');
    assert.equal(res.status, 404);
    assert.equal(res.body, '{"error":"none"}');
  });
});

/** An unmasked server-to-client WebSocket frame. */
function frame(opcode, payload, fin = true) {
  const data = Buffer.from(payload);
  const header = data.length < 126 ? Buffer.from([0, data.length]) : Buffer.from([0, 126, data.length >> 8, data.length & 0xff]);
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, data]);
}

describe('websocket upgrade', () => {
  const limits = JSON.stringify({ type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 91 } } });
  const created = JSON.stringify({ type: 'response.created', padding: 'x'.repeat(200) });
  const escapedLimits = '{"type":"codex.rate_\\u006cimits"}';
  const ping = frame(0x9, 'p');
  const sent = Buffer.concat([
    frame(0x1, escapedLimits),
    ping,
    frame(0x1, limits.slice(0, 10), false),
    ping,
    frame(0x0, limits.slice(10)),
    frame(0x1, created),
    frame(0x2, Buffer.from([1, 2, 3])),
  ]);
  const expected = Buffer.concat([ping, ping, frame(0x1, created), frame(0x2, Buffer.from([1, 2, 3]))]);

  let wsUpstream, router, base, seen;

  before(async () => {
    wsUpstream = http.createServer();
    wsUpstream.on('upgrade', (req, socket) => {
      seen = { headers: req.headers, received: '' };
      if (req.url === '/v1/denied')
        return socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      if (req.url === '/v1/hold')
        return socket.resume();
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade, x-private\r\nX-Up: yes\r\n'
        + 'X-Private: hop\r\nProxy-Authenticate: Basic\r\nx-codex-primary-used-percent: 99\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n');
      socket.on('data', d => {
        seen.received += d;
        socket.write(sent);
      });
    });
    const upUrl = await listen(wsUpstream);
    router = createRouter({ name: 'codex', passthrough: null, model: { upstream: upUrl, apiKey: KEY, paths: ['/v1/'] } });
    base = await listen(router);
  });

  after(() => close(router, wsUpstream));

  function upgrade(path) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(path, base), {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          authorization: 'Bearer chatgpt',
          'chatgpt-account-id': 'acct',
          'sec-websocket-key': 'k',
          'sec-websocket-extensions': 'permessage-deflate',
        },
      });
      req.on('upgrade', (res, socket) => resolve({ req, res, socket }));
      req.on('response', res => {
        res.resume();
        resolve({ req, res });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('relays an upgraded connection to the model upstream with its key and without compression', { timeout: 2000 }, async () => {
    const { res, socket } = await upgrade('/v1/responses');
    assert.equal(res.statusCode, 101);
    assert.equal(res.headers['x-up'], 'yes');
    assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen.headers['chatgpt-account-id'], undefined);
    assert.equal(seen.headers['sec-websocket-key'], 'k');
    assert.equal(seen.headers['sec-websocket-extensions'], undefined);
    socket.write('hello');
    let received = Buffer.alloc(0);
    while (received.length < expected.length)
      received = Buffer.concat([received, (await once(socket, 'data'))[0]]);
    assert.equal(seen.received, 'hello');
    assert.deepEqual(received, expected);
    socket.destroy();
  });

  it('strips limit and hop-by-hop headers from the 101 response and keeps repeated headers', { timeout: 2000 }, async () => {
    const { res, socket } = await upgrade('/v1/responses');
    assert.equal(res.headers['x-codex-primary-used-percent'], undefined);
    assert.equal(res.headers['x-private'], undefined);
    assert.equal(res.headers['proxy-authenticate'], undefined);
    assert.equal(res.headers.connection, 'Upgrade');
    assert.equal(res.headers.upgrade, 'websocket');
    assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
    socket.destroy();
  });

  it('closes the upstream connection when the client disconnects', { timeout: 2000 }, async () => {
    const upstreamClosed = new Promise(resolve => wsUpstream.once('upgrade', (req, socket) => socket.on('end', resolve)));
    const { socket } = await upgrade('/v1/responses');
    socket.destroy();
    await upstreamClosed;
  });

  it('closes the upstream connection when the client leaves during the handshake', { timeout: 2000 }, async () => {
    const upstreamClosed = new Promise(resolve => wsUpstream.once('upgrade', (req, socket) => socket.on('end', resolve)));
    const req = http.request(new URL('/v1/hold', base), { headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('error', () => {});
    req.end();
    await once(wsUpstream, 'upgrade');
    req.destroy();
    await upstreamClosed;
  });

  it('turns a model upstream 401 on upgrade into a 502', async () => {
    const { res } = await upgrade('/v1/denied');
    assert.equal(res.statusCode, 502);
  });

  it('closes a rejected client connection even when the client keeps it open', { timeout: 2000 }, async () => {
    const { port } = new URL(base);
    const socket = net.connect({ port: Number(port), host: '127.0.0.1', allowHalfOpen: true });
    const closed = new Promise(resolve => socket.on('close', resolve));
    socket.on('error', () => {});
    socket.write('GET /v1/denied HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    let reply = '';
    socket.on('data', d => {
      reply += d;
      socket.write('more');
    });
    // A write after the router's FIN gets a reset only when the router has closed its side, not just sent FIN.
    socket.on('end', () => socket.write('more'));
    await closed;
    assert.match(reply, /^HTTP\/1\.1 502/);
  });
});
