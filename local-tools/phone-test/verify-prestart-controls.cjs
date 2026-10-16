'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  if (auth.port === 12358 && process.env.ALLOW_PRIMARY_TEST !== '1') throw new Error('Use isolated instance');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    let prompts = 0;
    const errors = [];
    page.on('websocket', socket => {
      socket.on('framesent', ({ payload }) => { try { if (JSON.parse(String(payload)).type === 'message') prompts++; } catch {} });
      socket.on('framereceived', ({ payload }) => { try { const e = JSON.parse(String(payload)); if (e.kind === 'error') errors.push(e.error); } catch {} });
    });
    await page.goto(process.env.PUBLIC_URL || `http://127.0.0.1:${auth.port}/va/`, { waitUntil: 'networkidle' });
    const model = page.getByRole('combobox', { name: 'Model', exact: true }).filter({ visible: true });
    const effort = page.getByRole('combobox', { name: 'Effort', exact: true }).filter({ visible: true });
    const context = page.getByRole('combobox', { name: 'Auto-compaction budget', exact: true }).filter({ visible: true });
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Model"]')].some(s => !s.disabled && s.options.length > 1), undefined, { timeout: 45000 });
    if (prompts !== 0 || await context.isDisabled() || await effort.isDisabled()) throw new Error('Controls unavailable before prompt');
    await model.selectOption('gateway-claude-gpt-5.6-sol[1m]');
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Model"]')].some(s => s.value === 'gateway-claude-gpt-5.6-sol[1m]' && !s.disabled), undefined, { timeout: 45000 });
    await effort.selectOption('low');
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Effort"]')].some(s => s.value === 'low' && !s.disabled), undefined, { timeout: 45000 });
    await context.selectOption('500000');
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Auto-compaction budget"]')].some(s => s.value === '500000' && !s.disabled));
    console.log(JSON.stringify({ promptsBeforeSelection: prompts, selectedModel: await model.inputValue(), effort: await effort.inputValue(), context: await context.inputValue(), errors }));
    if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true });
    await page.getByPlaceholder(/Ask .* anything/).fill('Reply exactly PRESTART_READY. Do not use tools.');
    await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Model"]')].some(s => !s.disabled) && document.body.innerText.includes('PRESTART_READY'), undefined, { timeout: 90000 });
    if (await model.inputValue() !== 'gateway-claude-gpt-5.6-sol[1m]' || await effort.inputValue() !== 'low' || !await context.isDisabled()) throw new Error('Selections not preserved at first prompt');
    console.log(JSON.stringify({ firstPromptCompleted: true, chosenModelPreserved: true, chosenEffortPreserved: true, contextLockedAfterPrompt: true, prompts }));
  } catch (error) {
    const detail = error?.name || 'Error';
    console.error('Pre-start verification failed:', detail);
    process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.name); process.exitCode = 1; });
