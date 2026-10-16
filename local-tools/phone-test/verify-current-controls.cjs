'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    const configEvents = [];
    const errors = [];
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try { const x = JSON.parse(payload); if (x.kind === 'session_config') configEvents.push(x); if (x.kind === 'error') errors.push(x.error); } catch {}
    }));
    const base = process.env.PUBLIC_URL || `http://127.0.0.1:${auth.port}/va/`;
    await page.goto(base, { waitUntil: 'networkidle' });
    const context = page.getByRole('combobox', { name: 'Auto-compaction budget', exact: true }).filter({ visible: true });
    await context.selectOption('500000');
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Auto-compaction budget"]')].some(s => s.value === '500000'));
    await page.getByPlaceholder(/Ask .* anything/).fill('Say CONTROLS_READY. Do not use tools.');
    await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
    const model = page.getByRole('combobox', { name: 'Model', exact: true }).filter({ visible: true });
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Model"]')].some(s => !s.disabled && s.options.length > 1), { timeout: 90000 });
    const effort = page.getByRole('combobox', { name: 'Effort', exact: true }).filter({ visible: true });
    await effort.selectOption('low');
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Effort"]')].some(s => s.value === 'low'));
    const original = await model.inputValue();
    await page.waitForFunction(() => !document.body.innerText.includes('Applying…'));
    await model.selectOption('gateway-claude-gpt-5.6-sol[1m]');
    await page.getByText(/minimum output-token limit is incompatible/).waitFor({ timeout: 35000 });
    console.log(JSON.stringify({ contextBudgetConfirmed: await context.inputValue(), contextLocked: await context.isDisabled(), effortConfirmed: await effort.inputValue(), providerModelSwitchErrorShown: true, originalModelPreserved: await model.inputValue() === original, configEventCount: configEvents.length }));
  } finally { await browser.close(); }
})().catch(e => { console.error('Live controls verification failed:', e.name); process.exitCode = 1; });
