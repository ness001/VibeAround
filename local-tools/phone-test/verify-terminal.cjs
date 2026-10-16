'use strict';

// Optional browser driver stays outside the app's production dependencies.
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (!process.env.VIBEAROUND_DATA_DIR || !process.env.VIBEAROUND_WORKSPACE) throw new Error('Set private app data directory and disposable workspace');
  const origin = new URL(process.argv[2]).origin;
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)) throw new Error('Unexpected public origin');
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const base = `http://127.0.0.1:${auth.port}/va`;
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  for (const engine of [chromium, webkit]) {
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ tool: 'generic', project_path: process.env.VIBEAROUND_WORKSPACE, cols: 50, rows: 25 }),
    });
    if (!created.ok) throw new Error('Disposable session creation failed');
    const { session_id: sessionId } = await created.json();
    let browser;
    try {
      browser = await engine.launch({ headless: true,
        ...(engine === chromium && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
      });
      const context = await browser.newContext(devices['iPhone 13']);
      const page = await context.newPage();
      await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
      let output = '';
      let cursorReply = false;
      let resized = false;
      let commandExecuted = false;
      let barCommandExecuted = false;
      let keyboardCommand = '';
      let barCommandFrames = 0;
      let bytes = 0;
      page.on('websocket', ws => {
        const url = new URL(ws.url());
        if (url.pathname !== '/va/ws' || url.searchParams.get('session_id') !== sessionId) return;
        ws.on('framereceived', ({ payload }) => {
          if (typeof payload === 'string') return;
          bytes += payload.length;
          output = (output + payload.toString('utf8')).slice(-32768);
          // The complete marker does not appear in the typed command, only its result.
          commandExecuted ||= output.includes('MOBILE_PTY_OK_93');
          barCommandExecuted ||= output.includes('BAR_PTY_OK_94');
        });
        ws.on('framesent', ({ payload }) => {
          if (typeof payload !== 'string') return;
          cursorReply ||= /\x1b\[\d+;\d+R/.test(payload);
          resized ||= payload.includes('"type":"resize"');
          if (!commandExecuted && !payload.includes('\x1b') && !payload.startsWith('{')) keyboardCommand += payload;
          if (payload.includes("'BAR_'")) barCommandFrames++;
        });
      });
      await page.goto(`${origin}/va/`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.getByRole('button', { name: 'Show navigation', exact: true }).last().click();
      await page.getByRole('button', { name: /CLI/ }).filter({ visible: true }).last().click();
      await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
      const terminal = page.locator('.xterm:visible').first();
      await terminal.waitFor();
      const deadline = Date.now() + 15000;
      while (!cursorReply && Date.now() < deadline) await page.waitForTimeout(100);
      if (!cursorReply) throw new Error('Mobile terminal did not answer cursor query');
      await terminal.tap();
      await page.keyboard.type("echo ('MOBILE_' + 'PTY_OK_93')");
      await page.keyboard.press('Enter');
      while (!commandExecuted && Date.now() < deadline) await page.waitForTimeout(100);
      const focused = await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
      if (!commandExecuted || !focused || !resized) throw new Error('Mobile terminal input/output check failed');
      const inputNotDuplicated = keyboardCommand === "echo ('MOBILE_' + 'PTY_OK_93')\r";
      await page.getByRole('button', { name: 'Prompt', exact: true }).tap();
      await page.getByPlaceholder('Type text to send to terminal…').fill("echo ('BAR_' + 'PTY_OK_94')");
      await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).last().tap();
      const barDeadline = Date.now() + 10000;
      while (!barCommandExecuted && Date.now() < barDeadline) await page.waitForTimeout(100);
      if (!inputNotDuplicated || !barCommandExecuted || barCommandFrames !== 1) throw new Error('Mobile input bar or duplicate-input check failed');
      console.log(JSON.stringify({ engine: engine.name(), mobileViewport: true, cursorReply, resized, focused, commandExecuted, inputNotDuplicated, barCommandExecuted, barCommandFrames, outputBytes: bytes }));
    } finally {
      if (browser) await browser.close();
      const deleted = await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000) });
      if (!deleted.ok) throw new Error('Disposable session cleanup failed');
    }
  }
}
main().catch(error => {
  // Never print browser errors containing authenticated WebSocket URLs or terminal output.
  console.error('Terminal verification failed; credential and terminal details omitted.', error.name);
  process.exitCode = 1;
});
