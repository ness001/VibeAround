'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function main() {
  const publicUrl = new URL(process.argv[2]);
  assert.equal(publicUrl.protocol, 'https:');
  assert.match(publicUrl.hostname, /^[a-z0-9-]+\.trycloudflare\.com$/);
  assert.ok(process.env.VIBEAROUND_DATA_DIR, 'Set the intended private application state');
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const local = `http://127.0.0.1:${auth.port}/va`;
  const ownerHeaders = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const origin = publicUrl.origin;
  const createdDevices = new Set();
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  });
  let stage = 'setup';
  const report = result => console.log(JSON.stringify(result));
  async function localApi(endpoint, options = {}) {
    return fetch(local + endpoint, { ...options, headers: ownerHeaders, signal: AbortSignal.timeout(10000) });
  }
  async function start(context, remember) {
    const response = await context.request.post(origin + '/va/api/pair/browser/start', {
      data: { remember }, headers: { Origin: origin },
    });
    assert.equal(response.status(), 200);
    const request = await response.json();
    assert.match(request.code, /^\d{6}$/);
    assert.ok(request.sid);
    return request;
  }
  async function status(context, request) {
    const response = await context.request.get(origin + '/va/api/pair/browser/status', { params: { sid: request.sid } });
    assert.equal(response.status(), 200);
    return response.json();
  }
  try {
    stage = 'desktop approval';
    const context = await browser.newContext(devices['Pixel 7']);
    assert.equal((await context.request.get(origin + '/va/api/pair/browser/session', { headers: { Origin: origin } })).status(), 401);
    const request = await start(context, true);
    assert.equal((await status(context, request)).status, 'pending');
    const pending = await (await localApi('/api/pair/browser/requests')).json();
    const match = pending.requests.find(item => item.code === request.code);
    assert.ok(match);
    assert.equal(match.remember, true);
    const rejectedApproval = await localApi('/api/pair/browser/approve', {
      method: 'POST', body: JSON.stringify({ id: match.id, code: request.code === '000000' ? '111111' : '000000' }),
    });
    assert.ok(rejectedApproval.status >= 400);
    const previousDevices = new Set((await (await localApi('/api/pair/devices')).json()).devices.map(item => item.id));
    const approved = await localApi('/api/pair/browser/approve', { method: 'POST', body: JSON.stringify({ id: match.id, code: request.code }) });
    assert.equal(approved.status, 204);
    const paired = await status(context, request);
    assert.equal(paired.status, 'verified');
    assert.match(paired.token, /^[a-f0-9]{64}$/i);
    assert.notEqual(paired.token, auth.token);
    assert.equal((await status(context, request)).token, paired.token);
    const deviceList = await (await localApi('/api/pair/devices')).json();
    const newDevices = deviceList.devices.filter(item => !previousDevices.has(item.id));
    assert.equal(newDevices.length, 1);
    const deviceId = newDevices[0].id;
    createdDevices.add(deviceId);
    const cookies = await context.cookies();
    const remembered = cookies.find(cookie => cookie.value === paired.token);
    assert.ok(remembered);
    assert.equal(remembered.httpOnly, true);
    assert.equal(remembered.secure, true);
    assert.ok(remembered.expires > Date.now() / 1000);
    assert.ok(remembered.expires <= Date.now() / 1000 + 31 * 86400);
    report({ desktopApproval: true, exactCodeRequired: true, perDeviceCredential: true, rememberCookie: true });

    stage = 'cookie restoration and scope';
    const restored = await context.request.get(origin + '/va/api/pair/browser/session', { headers: { Origin: origin } });
    assert.equal(restored.status(), 200);
    assert.equal((await restored.json()).token, paired.token);
    const bearer = { Authorization: `Bearer ${paired.token}` };
    assert.equal((await context.request.get(origin + '/va/api/sessions', { headers: bearer })).status(), 200);
    assert.equal((await context.request.get(origin + '/va/api/pair/browser/requests', { headers: bearer })).status(), 404);
    const ownerEscalation = await context.request.post(origin + '/va/api/pair/complete', { headers: { ...bearer, Origin: origin } });
    assert.ok(ownerEscalation.status() >= 400);
    report({ rememberedSessionRestored: true, authenticatedApi: true, ownerEscalationBlocked: true, publicAdminBlocked: true });

    stage = 'fresh browser restoration';
    const state = await context.storageState();
    const reopened = await browser.newContext({ ...devices['Pixel 7'], storageState: state });
    await reopened.route('**/va/api/**', route => {
      const req = route.request();
      // Do not launch agents or modify the user's workspaces during a login test.
      if (req.method() === 'POST' && !new URL(req.url()).pathname.startsWith('/va/api/pair/')) return route.abort();
      return route.continue();
    });
    const page = await reopened.newPage();
    await page.goto(origin + '/va/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => Boolean(sessionStorage.getItem('vibearound.auth.token')), {}, { timeout: 15000 });
    const storedMatches = await page.evaluate(token => sessionStorage.getItem('vibearound.auth.token') === token, paired.token);
    assert.equal(storedMatches, true);
    stage = 'socket revocation';
    // Open an otherwise idle chat transport; revocation must close an established socket.
    await page.evaluate(token => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/va/ws/chat?token=${encodeURIComponent(token)}`);
      window.__pairingProbe = socket;
      socket.onopen = () => resolve(true);
      socket.onerror = () => reject(new Error('WebSocket open failed'));
    }), paired.token);
    assert.equal((await localApi(`/api/pair/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })).status, 204);
    createdDevices.delete(deviceId);
    await page.waitForFunction(() => window.__pairingProbe?.readyState === WebSocket.CLOSED, {}, { timeout: 10000 });
    assert.equal((await context.request.get(origin + '/va/api/sessions', { headers: bearer })).status(), 401);
    assert.equal((await context.request.get(origin + '/va/api/pair/browser/session', { headers: { Origin: origin } })).status(), 401);
    report({ freshBrowserCookieRestore: true, desktopRevocation: true, revokedApiDenied: true, existingWebSocketClosed: true });
    await reopened.close();

    stage = 'request rejection';
    const deniedContext = await browser.newContext(devices['Pixel 7']);
    const deniedRequest = await start(deniedContext, false);
    const requests = await (await localApi('/api/pair/browser/requests')).json();
    const denied = requests.requests.find(item => item.code === deniedRequest.code);
    assert.ok(denied);
    assert.equal(denied.remember, false);
    assert.equal((await localApi('/api/pair/browser/reject', { method: 'POST', body: JSON.stringify({ id: denied.id }) })).status, 204);
    assert.equal((await status(deniedContext, deniedRequest)).status, 'rejected');
    assert.equal((await deniedContext.request.get(origin + '/va/api/pair/browser/session', { headers: { Origin: origin } })).status(), 401);
    report({ rejection: true, noCredentialOnRejection: true });
    await deniedContext.close();
    await context.close();
  } catch (error) {
    console.error(`Failed stage: ${stage}; sensitive details omitted.`);
    throw error;
  } finally {
    for (const id of createdDevices) await localApi(`/api/pair/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await browser.close();
  }
}

main().catch(error => {
  // Browser errors and assertion operands can contain bearer URLs or credentials.
  console.error(`Browser pairing verification failed (${error.name}); sensitive details omitted.`);
  process.exitCode = 1;
});
