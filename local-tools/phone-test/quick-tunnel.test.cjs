'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once, EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash, randomBytes } = require('node:crypto');
const { createGateway, startTunnel, canonicalPath, validatePublicOrigin, CLOUDFLARED } = require('./quick-tunnel.cjs');

const ORIGIN = 'https://phone-test-example.trycloudflare.com';
const HOST = new URL(ORIGIN).host;
const TEST_TOKEN = 'mock-token-only-not-a-real-credential';
const AUTH = `Bearer ${TEST_TOKEN}`;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function fixture(t, { publicOrigin = ORIGIN, invalidHandshake = false } = {}) {
  const observed = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer((req, res) => {
    observed.push({ method: req.method, url: req.url, headers: req.headers });
    const publicRoute = req.url.startsWith('/va/api/pair/start') || req.url === '/va/';
    if (!publicRoute && req.headers.authorization !== AUTH) {
      res.writeHead(401, { 'content-length': '0' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      observed.at(-1).body = body;
      if (req.url.includes('hang=true')) return;
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['va_owner=mock-cookie; Path=/va/; HttpOnly', 'second=value'],
        connection: 'close, x-hop-response', 'x-hop-response': 'must-disappear',
      });
      res.end('upstream-body');
    });
  });
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (req, socket, head) => {
    observed.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true, head });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== TEST_TOKEN && req.headers.authorization !== AUTH) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = invalidHandshake ? 'é'.repeat(28) : createHash('sha1').update(req.headers['sec-websocket-key']
      + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const initialFrame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    socket.write(Buffer.concat([
      Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      initialFrame,
    ]));
    if (head.length) socket.write(head);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({ upstreamPort, ...(publicOrigin === null ? {} : { publicOrigin }) });
  const port = await listen(gateway.server);
  t.after(async () => {
    await gateway.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { gateway, upstreamPort, port, observed, upstream };
}

function request(port, { path = '/va/api/sessions', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { host: HOST, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Mock request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.setTimeout(3000, () => socket.destroy(new Error('Raw request timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('connect', () => socket.write(text));
  });
}

async function websocket(port, { path = `/va/ws/chat?token=${TEST_TOKEN}`, headers = {}, head = Buffer.alloc(0) } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  socket.setTimeout(3000, () => socket.destroy(new Error('WebSocket test timed out')));
  socket.on('error', () => {});
  await once(socket, 'connect');
  const fields = {
    Host: HOST, Origin: ORIGIN, Upgrade: 'websocket', Connection: 'Upgrade',
    'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    ...headers,
  };
  const text = `GET ${path} HTTP/1.1\r\n` + Object.entries(fields)
    .filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n';
  let buffer = Buffer.alloc(0);
  const received = [];
  let onData;
  const handshake = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('end', () => {
      if (!buffer.includes('\r\n\r\n')) reject(new Error('Handshake ended early'));
    });
    onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index < 0) return;
      socket.removeListener('data', onData);
      const remainder = buffer.subarray(index + 4);
      if (remainder.length) received.push(remainder);
      socket.on('data', (value) => received.push(value));
      resolve({ status: Number(buffer.toString('latin1').split(' ')[1]), socket, received });
    };
    socket.on('data', onData);
  });
  socket.write(Buffer.concat([Buffer.from(text), head]));
  return handshake;
}

async function receiveBytes(ws, length) {
  while (Buffer.concat(ws.received).length < length) await once(ws.socket, 'data');
  return Buffer.concat(ws.received);
}

function fakeSpawner({ throwOnSpawn = false } = {}) {
  let invocation;
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killCalls.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  const spawnChild = (executable, args, options) => {
    invocation = { executable, args, options };
    if (throwOnSpawn) throw new Error('Mock spawn failure');
    return child;
  };
  return { child, spawnChild, invocation: () => invocation };
}

test('public origin accepts only the exact HTTPS quick-tunnel authority', () => {
  assert.equal(validatePublicOrigin(ORIGIN).origin, ORIGIN);
  for (const value of [
    `${ORIGIN}/`, `${ORIGIN}/va/`, `${ORIGIN}?token=private`, `${ORIGIN}#fragment`,
    `${ORIGIN}:443`, `${ORIGIN}.evil.example`, 'http://phone-test-example.trycloudflare.com',
    'https://user@phone-test-example.trycloudflare.com', 'https://LOCALHOST',
    'https://a_b.trycloudflare.com', 'https://phone-test-example.TRYCLOUDFLARE.com',
  ]) assert.throws(() => validatePublicOrigin(value), /Invalid public origin/);
});

test('canonical paths reject normalization tricks but preserve opaque query strings', () => {
  for (const path of [
    '//va/api/sessions', '/va//api/sessions', '/va/./api/sessions', '/va/x/../api/sessions',
    '/va/%61pi/sessions', '/va/%2e%2e/api/settings', '/va/%252e%252e/api/settings',
    '/va\\api/sessions', '/va/api/sessions#fragment', 'http://elsewhere/va/api/sessions',
  ]) assert.equal(canonicalPath(path), null, path);
  assert.equal(canonicalPath('/va/api/pair/status?sid=a%2Fb%20c&token=x%25'), '/va/api/pair/status');
});

test('gateway stays closed until a validated immutable public origin is supplied', async (t) => {
  const f = await fixture(t, { publicOrigin: null });
  assert.equal((await request(f.port, { path: '/va/' })).status, 503);
  assert.equal(f.observed.length, 0);
  assert.throws(() => f.gateway.setPublicOrigin('http://localhost'));
  f.gateway.setPublicOrigin(ORIGIN);
  assert.equal((await request(f.port, { path: '/va/' })).status, 200);
  assert.throws(() => f.gateway.setPublicOrigin('https://another.trycloudflare.com'), /already set/);
});

test('upstream authentication rejects missing/bad bearer and preserves valid auth, cookies, query, and body', async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.port)).status, 401);
  assert.equal((await request(f.port, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const path = '/va/api/sessions?token=opaque%2Fvalue&sid=a%26b';
  const body = '{"workspace_path":"mock-empty-workspace"}';
  const response = await request(f.port, {
    path, method: 'POST', body,
    headers: { origin: ORIGIN, authorization: AUTH, cookie: 'first=1; va_owner=mock-only', 'content-type': 'application/json' },
  });
  assert.equal(response.status, 200);
  const seen = f.observed.at(-1);
  assert.equal(seen.url, path);
  assert.equal(seen.body, body);
  assert.equal(seen.headers.authorization, AUTH);
  assert.equal(seen.headers.cookie, 'first=1; va_owner=mock-only');
  assert.equal(seen.headers.host, HOST);
  assert.equal(seen.headers.origin, `http://127.0.0.1:${f.upstreamPort}`);
  assert.deepEqual(response.headers['set-cookie'], ['va_owner=mock-cookie; Path=/va/; HttpOnly', 'second=value']);
  assert.equal(response.body, 'upstream-body');
});

test('Origin is optional only for reads; foreign, null, duplicate Origin and invalid Host never reach upstream', async (t) => {
  const f = await fixture(t);
  for (const origin of ['null', 'https://evil.example', 'http://127.0.0.1:12358', `${ORIGIN}/`]) {
    assert.equal((await request(f.port, { headers: { origin, authorization: AUTH } })).status, 403);
  }
  for (const host of ['localhost:12358', '127.0.0.1:12358', `${HOST}:443`, 'evil.example', HOST.toUpperCase()]) {
    assert.equal((await request(f.port, { headers: { host, authorization: AUTH } })).status, 403);
  }
  for (const method of ['POST', 'DELETE']) {
    assert.equal((await request(f.port, { method, headers: { authorization: AUTH } })).status, 403);
  }
  for (const extra of [`Host: ${HOST}\r\n`, `Origin: ${ORIGIN}\r\n`]) {
    const response = await rawRequest(f.port,
      `GET /va/api/sessions HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\n${extra}Connection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 403 /);
  }
  assert.equal(f.observed.length, 0);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await request(f.port, { method, headers: { authorization: AUTH } })).status, 200);
    assert.equal(f.observed.at(-1).headers.origin, undefined);
  }
  assert.equal((await request(f.port, { headers: { origin: ORIGIN, authorization: AUTH } })).status, 200);
});

test('narrow source-derived allowlist excludes admin, bridge, preview, settings and unneeded mutations', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/va/local-api/v1/models', '/va/bridge/p/a/v1/messages', '/va/local-agent/a/p/v1/models',
    '/va/mcp', '/mcp', '/va/preview/u/private', '/va/api/settings', '/va/api/settings/reload',
    '/va/api/tunnels', '/va/api/channels', '/va/api/chat/files/download',
    '/va/api/launcher/preferences', '/va/api/model-profiles', '/va/api/agents/runtime',
    '/va/api/anything', '/va/ws/channels', '/va/some-spa-fallback',
  ]) {
    assert.equal((await request(f.port, { path, headers: { authorization: AUTH } })).status, 404, path);
  }
  for (const path of ['/va/api/workspaces/remove', '/va/api/chat/uploads', '/va/api/settings', '/va/api/launcher/plan', '/va/api/pair/ticket']) {
    assert.equal((await request(f.port, { path, method: 'POST', headers: { origin: ORIGIN, authorization: AUTH } })).status, 404, path);
  }
  assert.equal(f.observed.length, 0);
  for (const path of [
    '/va/', '/va/pair', '/va/pair/', '/va/assets/index-AbCd123.js', '/va/brand/vibearound-mark.svg',
    '/va/favicon.ico', '/va/favicon-32x32.png', '/va/favicon-16x16.png', '/va/apple-touch-icon.png',
    '/va/api/service/health', '/va/api/service/info', '/va/api/pair/status?sid=a',
    '/va/api/sessions', '/va/api/profiles', '/va/api/workspaces', '/va/api/tmux/sessions',
    '/va/api/workspaces/browse?path=C%3A%5CProjects', '/va/api/workspaces/browser-root',
    '/va/api/agents/claude-code/launch-sessions',
  ]) assert.equal((await request(f.port, { path, headers: { authorization: AUTH } })).status, 200, path);
  for (const path of ['/va/api/pair/start', '/va/api/pair/complete', '/va/api/sessions', '/va/api/launch-sessions', '/va/api/workspace-threads/init', '/va/api/workspaces', '/va/api/workspaces/create']) {
    assert.equal((await request(f.port, { path, method: 'POST', headers: { origin: ORIGIN, authorization: AUTH } })).status, 200, path);
  }
  assert.equal((await request(f.port, { path: '/va/api/sessions/a-123', method: 'DELETE', headers: { origin: ORIGIN, authorization: AUTH } })).status, 200);
  assert.equal((await request(f.port, { path: '/va/api/workspaces/browser-root', method: 'PUT', headers: { origin: ORIGIN, authorization: AUTH } })).status, 200);
  for (const path of ['/va/api/workspaces', '/va/api/workspaces/create', '/va/api/settings']) {
    assert.equal((await request(f.port, { path, method: 'PUT', headers: { origin: ORIGIN, authorization: AUTH } })).status, 404, path);
  }
});

test('QR redemption reaches upstream unchanged but ticket minting stays local', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify({ ticket: 'a'.repeat(64) });
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  const redeemed = await request(f.port, { path: '/va/api/pair/redeem', method: 'POST', headers, body });
  // This mock requires auth; receiving its rejection proves we did not inject credentials.
  assert.equal(redeemed.status, 401);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].headers.authorization, undefined);
  assert.equal(f.observed[0].headers.host, HOST);
  assert.equal(f.observed[0].headers.origin, `http://127.0.0.1:${f.upstreamPort}`);
  const accepted = await request(f.port, {
    path: '/va/api/pair/redeem', method: 'POST', headers: { ...headers, authorization: AUTH }, body,
  });
  assert.equal(accepted.status, 200);
  assert.equal(f.observed.at(-1).body, body);
  const observed = f.observed.length;
  for (const headers of [{}, { origin: 'https://foreign.example' }]) {
    assert.equal((await request(f.port, { path: '/va/api/pair/redeem', method: 'POST', headers, body })).status, 403);
  }
  for (const method of ['GET', 'POST']) {
    assert.equal((await request(f.port, {
      path: '/va/api/pair/ticket', method, headers: { origin: ORIGIN, authorization: AUTH },
    })).status, 404);
  }
  assert.equal(f.observed.length, observed);
});

test('browser pairing forwards public endpoints and cookies but keeps approval and revocation local', async (t) => {
  const f = await fixture(t);
  const headers = { origin: ORIGIN, authorization: AUTH, cookie: 'va_device=mock-device-only' };
  for (const [method, path] of [
    ['POST', '/va/api/pair/browser/start'],
    ['GET', '/va/api/pair/browser/status?sid=opaque-polling-secret'],
    ['GET', '/va/api/pair/browser/session'],
  ]) {
    const result = await request(f.port, { method, path, headers });
    assert.equal(result.status, 200, path);
    assert.equal(f.observed.at(-1).headers.cookie, headers.cookie);
    assert.equal(f.observed.at(-1).headers.origin, ORIGIN);
    assert.equal(f.observed.at(-1).headers['x-forwarded-for'], '192.0.2.1');
  }
  const observed = f.observed.length;
  for (const [method, path] of [
    ['GET', '/va/api/pair/browser/requests'],
    ['POST', '/va/api/pair/browser/approve'],
    ['POST', '/va/api/pair/browser/reject'],
    ['GET', '/va/api/pair/devices'],
    ['DELETE', '/va/api/pair/devices/device-id'],
  ]) {
    assert.equal((await request(f.port, { method, path, headers })).status, 404, path);
  }
  for (const path of ['/va/api/pair/browser/start', '/va/api/pair/browser/session']) {
    const method = path.endsWith('/start') ? 'POST' : 'GET';
    assert.equal((await request(f.port, { method, path, headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 403);
  }
  assert.equal(f.observed.length, observed);
});

test('encoded, noncanonical, and absolute-form paths never reach upstream', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/va/%61pi/sessions', '/va/api/../api/sessions', '/va//api/sessions', '/va/api/./sessions',
    '/va/assets/../../local-api/v1/models', '/va/assets/%252e%252e/local-api', '/va\\api/sessions',
    '/va/api/sessions#ignored', `https://${HOST}/va/api/sessions`,
  ]) assert.equal((await request(f.port, { path, headers: { authorization: AUTH } })).status, 400, path);
  assert.equal(f.observed.length, 0);
});

test('forwarding spoofing is replaced and hop-by-hop headers cannot suppress auth or origin', async (t) => {
  const f = await fixture(t);
  const response = await request(f.port, {
    headers: {
      authorization: AUTH, connection: 'keep-alive, x-hop-request, x-forwarded-for',
      'keep-alive': 'timeout=999', 'x-hop-request': 'must-disappear',
      forwarded: 'for=127.0.0.1;host=localhost', 'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'localhost:12358', 'x-forwarded-proto': 'http',
      'x-forwarded-port': '12358', 'x-forwarded-anything': 'spoof', 'x-real-ip': '127.0.0.1',
    },
  });
  assert.equal(response.status, 200);
  const headers = f.observed[0].headers;
  assert.equal(headers.host, HOST);
  assert.equal(headers.authorization, AUTH);
  assert.equal(headers['x-forwarded-for'], '192.0.2.1');
  assert.equal(headers['x-forwarded-host'], HOST);
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(headers['x-real-ip'], '192.0.2.1');
  assert.equal(headers.forwarded, `for=192.0.2.1;proto=https;host="${HOST}"`);
  assert.equal(headers['x-forwarded-port'], undefined);
  assert.equal(headers['x-forwarded-anything'], undefined);
  assert.equal(headers['x-hop-request'], undefined);
  assert.equal(headers['keep-alive'], undefined);
  assert.equal(response.headers['x-hop-response'], undefined);
  for (const name of ['authorization', 'cookie', 'origin', 'host', 'content-length']) {
    assert.equal((await request(f.port, { headers: { authorization: AUTH, connection: name } })).status, 400);
  }
  assert.equal(f.observed.length, 1);
});

test('WebSocket origin and upstream token checks remain enforced for both allowed endpoints', async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'https://evil.example']) {
    const ws = await websocket(f.port, { headers: { Origin: origin } });
    assert.equal(ws.status, 403);
    ws.socket.destroy();
  }
  assert.equal(f.observed.length, 0);
  for (const path of ['/va/ws', '/va/ws/chat?token=wrong']) {
    const ws = await websocket(f.port, { path });
    assert.equal(ws.status, 401);
    ws.socket.destroy();
  }
  const blocked = await websocket(f.port, { path: '/va/ws/tunnels' });
  assert.equal(blocked.status, 404);
  blocked.socket.destroy();
  const badHost = await websocket(f.port, { headers: { Host: 'localhost:12358' } });
  assert.equal(badHost.status, 403);
  badHost.socket.destroy();
});

test('authenticated WebSocket preserves handshake and bidirectional parser head bytes with backpressure', async (t) => {
  const f = await fixture(t);
  const early = Buffer.from([0x81, 0x82, 0x11, 0x22, 0x33, 0x44, 0x79, 0x4b]);
  const path = `/va/ws/chat?token=${TEST_TOKEN}&chat_id=x%2Fy`;
  const ws = await websocket(f.port, {
    path, head: early,
    headers: { Cookie: 'va_owner=mock-only', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Port': '12358' },
  });
  t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101);
  const first = await receiveBytes(ws, 4 + early.length);
  assert.deepEqual(first.subarray(0, 4), Buffer.from([0x81, 0x02, 0x68, 0x69]));
  assert.deepEqual(first.subarray(4, 4 + early.length), early);
  const seen = f.observed.at(-1);
  assert.equal(seen.url, path);
  assert.equal(seen.headers.host, HOST);
  assert.equal(seen.headers.origin, `http://127.0.0.1:${f.upstreamPort}`);
  assert.equal(seen.headers.cookie, 'va_owner=mock-only');
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers['x-forwarded-for'], '192.0.2.1');
  assert.equal(seen.headers['x-forwarded-port'], undefined);
  const payload = randomBytes(256 * 1024);
  ws.socket.write(payload);
  const all = await receiveBytes(ws, 4 + early.length + payload.length);
  assert.deepEqual(all.subarray(4 + early.length), payload);
  const terminal = await websocket(f.port, { path: '/va/ws?session_id=a', headers: { Authorization: AUTH } });
  assert.equal(terminal.status, 101);
  assert.equal(f.observed.at(-1).headers.authorization, AUTH);
  terminal.socket.destroy();
});

test('malformed upstream WebSocket accept cannot crash or open the gateway', async (t) => {
  const f = await fixture(t, { invalidHandshake: true });
  const ws = await websocket(f.port);
  assert.equal(ws.status, 502);
  ws.socket.destroy();
  assert.equal((await request(f.port, { headers: { authorization: AUTH } })).status, 200);
});

test('gateway close destroys WebSockets, pending HTTP and the listener', async (t) => {
  const f = await fixture(t);
  const ws = await websocket(f.port);
  const closed = once(ws.socket, 'close');
  const pending = http.request({ host: '127.0.0.1', port: f.port, path: '/va/api/sessions?hang=true', headers: { host: HOST, authorization: AUTH } });
  const pendingClosed = new Promise((resolve) => pending.once('error', resolve));
  pending.end();
  await new Promise((resolve) => f.upstream.once('request', resolve));
  await f.gateway.close();
  await Promise.all([closed, pendingClosed]);
  assert.equal(f.gateway.server.listening, false);
  await f.gateway.close();
  assert.throws(() => f.gateway.setPublicOrigin(ORIGIN), /closed/);
});

test('startup uses fixed executable and HTTP2, strips inherited token, and prints only validated URL', async (t) => {
  const original = process.env.TUNNEL_TOKEN;
  process.env.TUNNEL_TOKEN = 'mock-inherited-secret';
  t.after(() => {
    if (original === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = original;
  });
  const fake = fakeSpawner();
  const logs = [];
  const running = await startTunnel({ spawnChild: fake.spawnChild, log: (line) => logs.push(line), startupMs: 1000, lifetimeMs: 5000 });
  t.after(() => running.stop());
  const invocation = fake.invocation();
  assert.equal(invocation.executable, CLOUDFLARED);
  assert.deepEqual(invocation.args.slice(0, 6), ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${running.gateway.server.address().port}`]);
  assert.equal(invocation.options.env.TUNNEL_TOKEN, undefined);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'pipe']);
  const port = running.gateway.server.address().port;
  assert.equal((await request(port, { path: '/va/' })).status, 503);
  fake.child.stderr.write(`ignore https://a.trycloudflare.com.evil.example token=do-not-log\n${ORIGIN}?token=never-print\n`);
  assert.deepEqual(logs, []);
  fake.child.stderr.write(`| ${ORIGIN.slice(0, 25)}`);
  assert.deepEqual(logs, []);
  fake.child.stderr.write(`${ORIGIN.slice(25)} |\n`);
  assert.deepEqual(logs, [`PUBLIC_URL=${ORIGIN}/va/`]);
  fake.child.stderr.write('sensitive authorization cookie query body must not appear\n');
  assert.equal(logs.length, 1);
  await running.stop();
  assert.deepEqual(fake.child.killCalls, ['SIGTERM']);
  assert.equal(running.gateway.server.listening, false);
  assert.equal(await running.done, 0);
});

test('startup deadline kills child and closes gateway without accepting partial or invalid URLs', async () => {
  const fake = fakeSpawner();
  const logs = [];
  const running = await startTunnel({ spawnChild: fake.spawnChild, log: (line) => logs.push(line), startupMs: 35, lifetimeMs: 1000 });
  fake.child.stderr.write(`https://evil.example\n${ORIGIN}`);
  assert.equal(await running.done, 1);
  assert.deepEqual(logs, ['TUNNEL_STOPPED']);
  assert.deepEqual(fake.child.killCalls, ['SIGTERM']);
  assert.equal(running.gateway.server.listening, false);
});

test('child spawn failures and unexpected exits close the listener and fail', async () => {
  for (const kind of ['throw', 'error', 'exit']) {
    const fake = fakeSpawner({ throwOnSpawn: kind === 'throw' });
    const running = await startTunnel({ spawnChild: fake.spawnChild, log: () => {}, startupMs: 1000, lifetimeMs: 1000 });
    if (kind === 'error') fake.child.emit('error', new Error('Mock child error'));
    if (kind === 'exit') { fake.child.exitCode = 2; fake.child.emit('exit', 2, null); }
    assert.equal(await running.done, 1, kind);
    assert.equal(running.gateway.server.listening, false);
  }
});

test('default and zero lifetimes stay open until explicitly stopped', async (t) => {
  for (const options of [{}, { lifetimeMs: 0 }]) {
    const fake = fakeSpawner();
    const logs = [];
    const running = await startTunnel({
      spawnChild: fake.spawnChild, log: (line) => logs.push(line), startupMs: 1000, ...options,
    });
    t.after(() => running.stop());
    fake.child.stderr.write(`| ${ORIGIN} |\n`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(running.gateway.server.listening, true);
    assert.deepEqual(fake.child.killCalls, []);
    assert.deepEqual(logs, [`PUBLIC_URL=${ORIGIN}/va/`]);
    await running.stop();
    assert.equal(await running.done, 0);
    assert.equal(running.gateway.server.listening, false);
    assert.deepEqual(fake.child.killCalls, ['SIGTERM']);
  }
});

test('invalid lifetimes are rejected before starting a child', async () => {
  for (const lifetimeMs of [-1, NaN, Infinity, 1.5, 2147483648]) {
    const fake = fakeSpawner();
    await assert.rejects(startTunnel({ lifetimeMs, spawnChild: fake.spawnChild }), /Invalid tunnel lifetime/);
  }
});

test('automatic expiry kills child and destroys an active WebSocket', async (t) => {
  const f = await fixture(t);
  const fake = fakeSpawner();
  const logs = [];
  const running = await startTunnel({
    upstreamPort: f.upstreamPort, spawnChild: fake.spawnChild, log: (line) => logs.push(line),
    startupMs: 1000, lifetimeMs: 250,
  });
  t.after(() => running.stop());
  fake.child.stderr.write(`| ${ORIGIN} |\n`);
  const ws = await websocket(running.gateway.server.address().port);
  assert.equal(ws.status, 101);
  const closed = once(ws.socket, 'close');
  assert.equal(await running.done, 0);
  await closed;
  assert.deepEqual(logs, [`PUBLIC_URL=${ORIGIN}/va/`, 'TUNNEL_EXPIRED']);
  assert.deepEqual(fake.child.killCalls, ['SIGTERM']);
  assert.equal(running.gateway.server.listening, false);
});

test('phone archive and unarchive reach upstream with authentication and exact workspace body', async (t) => {
  const f = await fixture(t);
  for (const action of ['archive', 'unarchive']) {
    const path = `/va/api/agents/claude/launch-sessions/session-123/${action}`;
    const body = JSON.stringify({ workspace_path: 'C:\\test-workspace' });
    const response = await request(f.port, { path, method: 'POST', body,
      headers: { origin: ORIGIN, authorization: AUTH, 'content-type': 'application/json' } });
    assert.equal(response.status, 200);
    assert.equal(f.observed.at(-1).url, path);
    assert.equal(f.observed.at(-1).body, body);
    assert.equal((await request(f.port, { path, method: 'POST', headers: { origin: ORIGIN } })).status, 401);
    assert.equal((await request(f.port, { path, method: 'POST', headers: { authorization: AUTH } })).status, 403);
    assert.equal((await request(f.port, { path, method: 'DELETE', headers: { origin: ORIGIN, authorization: AUTH } })).status, 404);
  }
  for (const path of ['/va/api/agents/claude/launch-sessions/session-123/delete',
    '/va/api/agents/claude/launch-sessions/session-123/archive/extra',
    '/va/api/agents/claude/launch-sessions/../archive']) {
    assert.notEqual((await request(f.port, { path, method: 'POST', headers: { origin: ORIGIN, authorization: AUTH } })).status, 200);
  }
});
