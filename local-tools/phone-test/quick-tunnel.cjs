'use strict';

const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');

const CLOUDFLARED = process.env.CLOUDFLARED_PATH || 'cloudflared';
const PUBLIC_ORIGIN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const READ_ROUTES = new Set([
  '/va/', '/va/pair', '/va/pair/',
  '/va/favicon.ico', '/va/favicon-32x32.png', '/va/favicon-16x16.png',
  '/va/apple-touch-icon.png',
  '/va/api/service/health', '/va/api/service/info',
  '/va/api/pair/status', '/va/api/sessions', '/va/api/profiles',
  '/va/api/workspaces', '/va/api/tmux/sessions',
]);
const POST_ROUTES = new Set([
  '/va/api/pair/start', '/va/api/pair/complete', '/va/api/pair/redeem', '/va/api/sessions',
  '/va/api/launch-sessions', '/va/api/workspace-threads/init',
]);
const WS_ROUTES = new Set(['/va/ws', '/va/ws/chat']);

function validatePublicOrigin(value) {
  if (typeof value !== 'string' || !PUBLIC_ORIGIN.test(value)) {
    throw new Error('Invalid public origin');
  }
  const url = new URL(value);
  if (url.origin !== value || url.hostname.split('.')[0].length > 63) {
    throw new Error('Invalid public origin');
  }
  return url;
}

function canonicalPath(target) {
  if (typeof target !== 'string' || /[\x00-\x20\x7f#]/.test(target)) return null;
  const path = target.split('?', 1)[0];
  if (!path.startsWith('/') || /[%\\]/.test(path) || path.includes('//')) return null;
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) return null;
  if (path.split('/').some((part) => part === '.' || part === '..')) return null;
  return path;
}

function routeAllowed(method, path, upgrade = false) {
  if (!path) return false;
  if (upgrade) return method === 'GET' && WS_ROUTES.has(path);
  if (method === 'GET' || method === 'HEAD') {
    return READ_ROUTES.has(path)
      || /^\/va\/(?:assets|brand)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)
      || /^\/va\/api\/agents\/[A-Za-z0-9_-]+\/launch-sessions$/.test(path);
  }
  if (method === 'POST') return POST_ROUTES.has(path);
  return method === 'DELETE' && /^\/va\/api\/sessions\/[A-Za-z0-9_-]+$/.test(path);
}

function rawValues(message, name) {
  const result = [];
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    if (message.rawHeaders[i].toLowerCase() === name) result.push(message.rawHeaders[i + 1]);
  }
  return result;
}

function connectionTokens(message) {
  return String(message.headers.connection || '').toLowerCase().split(',')
    .map((part) => part.trim()).filter(Boolean);
}

function hasProtectedConnectionToken(message) {
  return connectionTokens(message).some((name) =>
    ['authorization', 'cookie', 'set-cookie', 'origin', 'host', 'content-length', 'transfer-encoding'].includes(name)
    || name.startsWith('sec-websocket-'));
}

function cleanHeaders(message) {
  const removed = new Set([...HOP_HEADERS, ...connectionTokens(message)]);
  const headers = Object.create(null);
  for (const [name, value] of Object.entries(message.headers)) {
    if (!removed.has(name)) headers[name] = value;
  }
  return headers;
}

function forwardedHeaders(req, publicUrl, upstreamPort, upgrade) {
  const headers = cleanHeaders(req);
  for (const name of Object.keys(headers)) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip') {
      delete headers[name];
    }
  }
  headers.host = publicUrl.host;
  if (req.headers.origin !== undefined) headers.origin = `http://127.0.0.1:${upstreamPort}`;
  headers.forwarded = `for=192.0.2.1;proto=https;host="${publicUrl.host}"`;
  headers['x-forwarded-for'] = '192.0.2.1';
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-real-ip'] = '192.0.2.1';
  headers.connection = upgrade ? 'Upgrade' : 'close';
  if (upgrade) headers.upgrade = 'websocket';
  return headers;
}

function rejectHttp(res, status) {
  res.writeHead(status, {
    'content-length': '0', 'cache-control': 'no-store', connection: 'close',
  });
  res.end();
}

function rejectSocket(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
  const timer = setTimeout(() => socket.destroy(), 1000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

function writeRawHeaders(socket, status, headers) {
  let output = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Upstream Response'}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      http.validateHeaderName(name);
      http.validateHeaderValue(name, entry);
      output += `${name}: ${entry}\r\n`;
    }
  }
  socket.write(`${output}\r\n`);
}

function createGateway({ upstreamPort = 12358, publicOrigin } = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error('Invalid upstream port');
  }
  let publicUrl = publicOrigin === undefined ? null : validatePublicOrigin(publicOrigin);
  let closing = false;
  let closePromise;
  const sockets = new Set();
  const requests = new Set();

  function trackSocket(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  }

  function validate(req, upgrade) {
    if (closing || !publicUrl) return 503;
    const hosts = rawValues(req, 'host');
    const origins = rawValues(req, 'origin');
    if (hosts.length !== 1 || hosts[0] !== publicUrl.host || origins.length > 1) return 403;
    if (origins.length === 1 && origins[0] !== publicUrl.origin) return 403;
    if ((upgrade || !['GET', 'HEAD'].includes(req.method)) && origins.length !== 1) return 403;
    if (hasProtectedConnectionToken(req) || rawValues(req, 'authorization').length > 1) return 400;
    const path = canonicalPath(req.url);
    if (!path) return 400;
    if (!routeAllowed(req.method, path, upgrade)) return 404;
    if (upgrade) {
      const key = rawValues(req, 'sec-websocket-key');
      if (rawValues(req, 'upgrade').length !== 1
          || String(req.headers.upgrade).toLowerCase() !== 'websocket'
          || !connectionTokens(req).includes('upgrade')
          || rawValues(req, 'sec-websocket-version').length !== 1
          || req.headers['sec-websocket-version'] !== '13'
          || key.length !== 1 || !/^[A-Za-z0-9+/]{22}==$/.test(key[0])
          || req.headers['transfer-encoding'] !== undefined
          || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) return 400;
    }
    return 0;
  }

  function upstreamRequest(req, upgrade) {
    const upstream = http.request({
      hostname: '127.0.0.1', port: upstreamPort, method: req.method,
      path: req.url, headers: forwardedHeaders(req, publicUrl, upstreamPort, upgrade),
      agent: false, maxHeaderSize: 16384,
    });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    upstream.on('socket', trackSocket);
    upstream.setTimeout(30000, () => upstream.destroy());
    return upstream;
  }

  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    const status = validate(req, false);
    if (status) return rejectHttp(res, status);
    const upstream = upstreamRequest(req, false);
    upstream.on('response', (response) => {
      if (hasProtectedConnectionToken(response)) {
        response.destroy();
        return rejectHttp(res, 502);
      }
      res.writeHead(response.statusCode, { ...cleanHeaders(response), connection: 'close' });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) rejectHttp(res, 502);
      else res.destroy();
    });
    upstream.on('upgrade', (_response, socket) => { socket.destroy(); rejectHttp(res, 502); });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', trackSocket);
  server.on('clientError', (_error, socket) => rejectSocket(socket, 400));
  server.on('checkContinue', (_req, res) => rejectHttp(res, 417));
  server.on('checkExpectation', (_req, res) => rejectHttp(res, 417));
  server.on('connect', (_req, socket) => rejectSocket(socket, 405));
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 1000;

  server.on('upgrade', (req, client, head) => {
    const status = validate(req, true);
    if (status) return rejectSocket(client, status);
    client.pause();
    const upstream = upstreamRequest(req, true);
    let remote;
    const cleanup = () => {
      client.destroy();
      if (remote) remote.destroy();
      upstream.destroy();
    };
    client.once('close', cleanup);
    client.once('error', cleanup);
    upstream.once('error', () => rejectSocket(client, 502));
    upstream.once('response', (response) => {
      if (hasProtectedConnectionToken(response)) {
        response.destroy();
        return rejectSocket(client, 502);
      }
      const headers = cleanHeaders(response);
      headers.connection = 'close';
      try { writeRawHeaders(client, response.statusCode, headers); }
      catch { response.destroy(); return cleanup(); }
      response.once('error', cleanup);
      response.pipe(client);
    });
    upstream.once('upgrade', (response, socket, upstreamHead) => {
      remote = socket;
      remote.pause();
      remote.setTimeout(0);
      client.setTimeout(0);
      const expected = createHash('sha1').update(req.headers['sec-websocket-key']
        + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const received = String(response.headers['sec-websocket-accept'] || '');
      if (response.statusCode !== 101 || hasProtectedConnectionToken(response)
          || String(response.headers.upgrade).toLowerCase() !== 'websocket'
          || !connectionTokens(response).includes('upgrade')
          || rawValues(response, 'sec-websocket-accept').length !== 1
          || !/^[A-Za-z0-9+/]{27}=$/.test(received)
          || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
        remote.destroy();
        return rejectSocket(client, 502);
      }
      const headers = cleanHeaders(response);
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
      try { writeRawHeaders(client, 101, headers); }
      catch { return cleanup(); }
      remote.once('close', cleanup);
      remote.once('error', cleanup);
      // unshift puts HTTP parser leftovers ahead of later frames; pipe manages backpressure.
      if (head.length) client.unshift(head);
      if (upstreamHead.length) remote.unshift(upstreamHead);
      client.pipe(remote);
      remote.pipe(client);
    });
    upstream.end();
  });

  return {
    server,
    setPublicOrigin(value) {
      if (closing) throw new Error('Gateway is closed');
      const next = validatePublicOrigin(value);
      if (publicUrl && publicUrl.origin !== next.origin) throw new Error('Public origin already set');
      publicUrl = next;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      publicUrl = null;
      closePromise = new Promise((resolve) => {
        server.close(() => resolve());
        for (const request of requests) request.destroy();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

async function startTunnel({
  upstreamPort = 12358, spawnChild = spawn, startupMs = 60000, lifetimeMs = 0,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 0 || lifetimeMs > 2147483647) {
    throw new Error('Invalid tunnel lifetime');
  }
  const gateway = createGateway({ upstreamPort });
  let child;
  let deadline;
  let expiry;
  let killDeadline;
  let stopping = false;
  let ready = false;
  let pending = '';
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  async function stop(code = 0) {
    if (stopping) return done;
    stopping = true;
    clearTimeout(deadline);
    clearTimeout(expiry);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      killDeadline = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      killDeadline.unref();
    }
    await gateway.close();
    resolveDone(code);
    return code;
  }
  const interrupt = () => { void stop(0); };
  const fail = () => { log('TUNNEL_STOPPED'); void stop(1); };
  const completeLine = (line) => {
    if (ready || stopping) return;
    const candidates = line.match(/https:\/\/[^\s|<>"']+/g) || [];
    for (const candidate of candidates) {
      let origin;
      try { origin = validatePublicOrigin(candidate).origin; }
      catch { continue; }
      gateway.setPublicOrigin(origin);
      ready = true;
      clearTimeout(deadline);
      log(`PUBLIC_URL=${origin}/va/`);
      break;
    }
  };

  deadline = setTimeout(fail, startupMs);
  // Zero disables the local auto-stop timer; connection failures still close the gateway.
  if (lifetimeMs > 0) {
    expiry = setTimeout(() => { log('TUNNEL_EXPIRED'); void stop(0); }, lifetimeMs);
  }
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await new Promise((resolve, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(0, '127.0.0.1', resolve);
    });
    if (stopping) { await gateway.close(); return { gateway, done, stop }; }
    const port = gateway.server.address().port;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'TUNNEL_TOKEN') delete env[key];
    }
    child = spawnChild(CLOUDFLARED, [
      'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`,
    ], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', fail);
    child.once('exit', () => {
      clearTimeout(killDeadline);
      if (!stopping) fail();
    });
    child.stderr.on('error', fail);
    child.stderr.on('data', (chunk) => {
      if (stopping || ready) return;
      pending += chunk.toString('utf8');
      if (pending.length > 65536) return fail();
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        completeLine(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
    });
    gateway.server.on('error', fail);
  } catch {
    fail();
  }
  return { gateway, child, done, stop };
}

module.exports = { createGateway, startTunnel, canonicalPath, routeAllowed, validatePublicOrigin, CLOUDFLARED };

if (require.main === module) {
  startTunnel().then(async ({ done }) => { process.exitCode = await done; }).catch(() => {
    process.stderr.write('TUNNEL_STOPPED\n');
    process.exitCode = 1;
  });
}
