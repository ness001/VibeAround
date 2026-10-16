const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

async function main() {
  const base = new URL(process.argv[2]);
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(base.hostname)) throw new Error('Unexpected tunnel URL');
  if (!process.env.VIBEAROUND_DATA_DIR) throw new Error('Set VIBEAROUND_DATA_DIR to private app state');
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const checks = [
    { path: '/va/', expected: 200 },
    { path: '/va/api/settings', expected: 404 },
    { path: '/va/api/sessions', expected: 401 },
    { path: '/va/api/sessions', expected: 401, headers: { Authorization: 'Bearer invalid' } },
    { path: '/va/api/sessions', expected: 200, headers: { Authorization: `Bearer ${auth.token}` } },
    { path: '/va/api/pair/complete', method: 'POST', expected: 401, headers: { Origin: base.origin } },
    { path: '/va/api/pair/complete', method: 'POST', expected: 204, headers: { Origin: base.origin, Authorization: `Bearer ${auth.token}` } },
    { path: '/va/api/pair/start', method: 'POST', expected: 403, headers: { Origin: 'https://untrusted.invalid' } },
    { path: '/va/local-api/v1/models', expected: 404 },
    { path: '/va/mcp', expected: 404 },
    { path: '/va/api/settings', method: 'PUT', expected: 404, headers: { Origin: base.origin, Authorization: `Bearer ${auth.token}` } },
    { path: '/va/api/pair/ticket', method: 'POST', expected: 404, headers: { Origin: base.origin, Authorization: `Bearer ${auth.token}` } },
  ];
  let failed = false;
  for (const check of checks) {
    const result = await fetch(new URL(check.path, base), {
      method: check.method || 'GET', headers: check.headers || {}, signal: AbortSignal.timeout(15000), redirect: 'manual',
    });
    const pass = result.status === check.expected;
    failed ||= !pass;
    console.log(JSON.stringify({ path: check.path, method: check.method || 'GET', authenticated: Boolean(check.headers?.Authorization), status: result.status, expected: check.expected, pass }));
    await result.body?.cancel();
  }
  const mint = await fetch(`http://127.0.0.1:${auth.port}/va/api/pair/ticket`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_url: base.origin }), signal: AbortSignal.timeout(10000),
  });
  if (!mint.ok) throw new Error('QR ticket mint failed');
  const { ticket } = await mint.json();
  if (!/^[0-9a-f]{64}$/.test(ticket)) throw new Error('QR ticket format invalid');
  for (const expected of [200, 410]) {
    const redeemed = await fetch(new URL('/va/api/pair/redeem', base), {
      method: 'POST', headers: { Origin: base.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(15000),
    });
    let pass = redeemed.status === expected && redeemed.headers.get('cache-control') === 'no-store';
    if (redeemed.status === 200) {
      const data = await redeemed.json();
      pass &&= data.status === 'verified' && data.token === auth.token;
    } else {
      await redeemed.body?.cancel();
    }
    failed ||= !pass;
    console.log(JSON.stringify({ qrRedemption: true, status: redeemed.status, expected, pass }));
  }
  for (const authenticated of [false, true]) {
    const result = await new Promise((resolve, reject) => {
      const request = https.request(new URL('/va/ws/chat', base), { headers: {
        Origin: base.origin, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
        ...(authenticated ? { Authorization: `Bearer ${auth.token}` } : {}),
      } });
      request.setTimeout(15000, () => request.destroy(new Error('Timeout')));
      request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
      request.on('response', response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end();
    });
    const expected = authenticated ? 101 : 401;
    const pass = result === expected;
    failed ||= !pass;
    console.log(JSON.stringify({ websocket: true, authenticated, status: result, expected, pass }));
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => { console.error('Remote verification failed; credentials omitted.'); process.exitCode = 1; });
