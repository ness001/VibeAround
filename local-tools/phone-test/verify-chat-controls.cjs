'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const dataDir = process.env.VIBEAROUND_DATA_DIR;
  if (!dataDir) throw new Error('Private test data is required');
  const auth = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
  const base = `http://127.0.0.1:${auth.port}`;
  if (auth.port === 12358) throw new Error('Use an isolated test instance');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    const errors = [];
    const updates = [];
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try {
        const event = JSON.parse(payload);
        if (event.kind === 'error') errors.push(String(event.error).slice(0,200));
        if (event.kind === 'session_config') updates.push(event);
      } catch {}
    }));
    await page.goto(`${base}/va/`, { waitUntil: 'networkidle' });
    const budget = page.getByRole('combobox', { name: 'Auto-compaction budget', exact: true }).filter({ visible: true });
    await budget.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('select[aria-label="Auto-compaction budget"]');
      return el && !el.disabled;
    }, { timeout: 20000 });
    await budget.selectOption('500000');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Auto-compaction budget"]')?.value === '500000');
    console.log(JSON.stringify({ draftBudgetConfirmed: await budget.inputValue() === '500000' }));
    await page.getByPlaceholder(/Ask .* anything/).fill('Reply exactly CONTROLS_READY. Do not use tools or access files.');
    await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('CONTROLS_READY') && !document.querySelector('button[aria-label="Stop"]'), { timeout: 90000 });
    const model = page.getByRole('combobox', { name: 'Model', exact: true }).filter({ visible: true });
    await page.waitForFunction(() => {
      const el = document.querySelector('select[aria-label="Model"]'); return el && !el.disabled;
    }, { timeout: 20000 });
    const options = await model.locator('option').evaluateAll(nodes => nodes.map(n => ({ value:n.value, label:n.textContent })));
    const effort = page.getByRole('combobox', { name: 'Effort', exact: true }).filter({ visible: true });
    const effortOptions = await effort.locator('option').evaluateAll(nodes => nodes.map(n => ({ value:n.value, label:n.textContent })));
    console.log(JSON.stringify({ modelOptions: options, currentModel: await model.inputValue(), effortOptions, effortDisabled: await effort.isDisabled(), contextLockedAfterStart: await budget.isDisabled(), snapshotCount: updates.length, errors }));
    if (!await budget.isDisabled()) throw new Error('Existing session context must be locked');
    if (!await effort.isDisabled()) {
      const value = effortOptions.find(o => o.value === 'low')?.value ?? effortOptions.find(o => o.value !== '')?.value;
      await effort.selectOption(value);
      await page.waitForFunction(() => !document.body.innerText.includes('Applying…'));
      console.log(JSON.stringify({ effortConfirmed: await effort.inputValue() === value }));
    }
    const current = await model.inputValue();
    const sameProvider = options.find(o => o.value !== current && o.value.startsWith('gateway-claude-gpt-'));
    if (sameProvider) {
      await model.selectOption(sameProvider.value);
      await page.waitForFunction(value => {
        const selects = [...document.querySelectorAll('select[aria-label="Model"]')];
        return selects.some(select => select.value === value);
      }, sameProvider.value, { timeout: 35000 }).catch(() => {});
      const confirmed = await model.inputValue() === sameProvider.value;
      if (!confirmed) console.log(JSON.stringify({ modelSwitchErrors: errors, snapshots: updates.map(u => u.config_options.filter(o => o.id === 'model').map(o => o.currentValue)).slice(-6) }));
      console.log(JSON.stringify({ modelSwitchConfirmed: confirmed }));
      if (!confirmed) {
        if (!errors.some(error => error.includes('minimum output-token limit'))) throw new Error('Model switch unconfirmed');
        console.log(JSON.stringify({ modelSwitchBlockedByProvider: true, currentModelPreserved: await model.inputValue() === current }));
      } else {
        await model.selectOption(current);
        await page.waitForFunction(value => [...document.querySelectorAll('select[aria-label="Model"]')].some(select => select.value === value), current);
      }
    }
    if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true });
  } finally { await browser.close(); }
})().catch(error => { console.error('Chat control verification failed:', error.name); process.exitCode = 1; });
