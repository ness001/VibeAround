'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    const statuses = [];
    const modes = [];
    page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
      try {
        const e = JSON.parse(String(payload));
        if (e.kind === 'turn_status') statuses.push({ active: e.active });
        if (e.kind === 'session_mode') modes.push(e.session_mode);
      } catch {}
    }));
    await page.goto(`http://127.0.0.1:${auth.port}/va/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    const buttons = await page.locator('button').evaluateAll(nodes => nodes.filter(n => /Manual|Session mode|Permission mode|Auto edit|Plan/.test(n.getAttribute('aria-label') || '')).map(n => ({ label: n.getAttribute('aria-label'), disabled: n.disabled, title: n.title })));
    console.log(JSON.stringify({ buttons, statuses, modes }));
  } finally { await browser.close(); }
})().catch(e => { console.error('Session mode inspection failed:', e.name); process.exitCode = 1; });
