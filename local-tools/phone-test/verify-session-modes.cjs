'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 950 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    const workspace = process.env.VIBEAROUND_WORKSPACE;
    await page.route('**/api/workspace-threads/init', route => route.fulfill({ json: { thread_id: 'mode-test-thread', chat_id: 'mode-test-chat', agent_id: 'claude', profile_id: 'direct', session_id: 'mode-test-session', workspace } }));
    let ws;
    let mode = 'default';
    let active = false;
    const changes = [];
    const snapshot = () => ({ kind: 'session_config', config_options: [
      { id: 'mode', category: 'mode', type: 'select', name: 'Mode', currentValue: mode, options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan', description: 'Plan before making changes' }] },
    ], context_window: null, context_window_default: null, context_window_automatic: true, context_window_editable: false, context_window_choices: [100000, 200000, 500000, 1000000] });
    const send = value => ws.send(JSON.stringify(value));
    await page.routeWebSocket('**/ws/chat?*', socket => {
      ws = socket;
      socket.onMessage(data => {
        const message = JSON.parse(String(data));
        if (message.type === 'get_session_config') {
          send({ kind: 'config', channel_id: 'mode-test', default_agent: 'claude', agents: [{ id: 'claude', name: 'Claude Code', description: 'Test' }] });
          send({ kind: 'session_ready', session_id: 'mode-test-session' });
          send(snapshot());
          send({ kind: 'acp_notification', payload: { sessionId: 'mode-test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Existing conversation: mode switching test.' } } } });
          send({ kind: 'turn_status', active });
        }
        if (message.type === 'set_config_option' || message.type === 'set_mode') {
          changes.push(message);
          mode = message.value ?? message.modeId;
          send(snapshot());
        }
      });
    });
    await page.goto(`http://127.0.0.1:${auth.port}/va/`, { waitUntil: 'networkidle' });
    const manual = page.getByRole('button', { name: 'Session mode: Manual', exact: true }).filter({ visible: true });
    await manual.waitFor();
    await manual.click();
    await page.getByRole('menuitem', { name: /^Plan/ }).click();
    await page.getByRole('button', { name: 'Session mode: Plan', exact: true }).waitFor();
    if (changes.length !== 1) throw new Error('Idle mode was not sent exactly once');
    active = true;
    send({ kind: 'turn_status', active });
    await page.getByRole('button', { name: 'Session mode: Plan', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Manual/ }).click();
    await page.getByText('Mode will change to Manual after the current turn finishes.', { exact: true }).waitFor();
    if (changes.length !== 1) throw new Error('Mode changed during active turn');
    await page.getByRole('button', { name: 'Cancel mode change', exact: true }).click();
    await page.getByRole('button', { name: 'Session mode: Plan', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Manual/ }).click();
    await page.getByText('Mode will change to Manual after the current turn finishes.', { exact: true }).waitFor();
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(os.tmpdir(), 'vibearound-session-mode-queued.png'), fullPage: true });
    active = false;
    send({ kind: 'turn_status', active });
    await manual.waitFor();
    if (changes.length !== 2) throw new Error('Queued mode not applied exactly once');
    console.log(JSON.stringify({ mockedAgentTransport: true, existingSessionIdleChange: true, busyChangeQueued: true, queueCancelable: true, appliedOnceAfterTurn: true, realSessionPermissionsChanged: false }));
  } finally { await browser.close(); }
})().catch(error => { console.error('Mode browser verification failed:', error.name, error.message?.split('\n')[0]); process.exitCode = 1; });
