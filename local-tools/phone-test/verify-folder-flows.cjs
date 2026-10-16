'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function main() {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const base = `http://127.0.0.1:${auth.port}/va`;
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const rootResponse = await fetch(`${base}/api/workspaces/browser-root`, { headers });
  if (!rootResponse.ok) throw new Error('Root configuration unavailable');
  const originalRoot = await rootResponse.json();
  const testRoot = fs.mkdtempSync(path.join(originalRoot.root, '.va-folder-check-'));
  const name = path.basename(testRoot);
  const existing = path.join(testRoot, 'existing');
  const project = path.join(testRoot, 'project');
  fs.mkdirSync(existing);
  const registered = new Set();
  const sessionIds = [];
  let rootChanged = false;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  try {
    const outside = await fetch(`${base}/api/workspaces/browse?${new URLSearchParams({ path: path.dirname(originalRoot.root) })}`, { headers });
    if (outside.status !== 403) throw new Error('Root boundary not enforced');
    const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    let prompts = 0;
    let cliRequest;
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      try { if (JSON.parse(String(payload)).type === 'message') prompts++; } catch {}
    }));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) cliRequest = request.postDataJSON(); });
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const picker = page.getByRole('region', { name: 'Project folder', exact: true });
    await picker.getByRole('button', { name: 'Choose another folder', exact: true }).click();
    await picker.getByRole('button', { name: `Open folder ${name}`, exact: true }).click();
    await picker.getByRole('button', { name: 'Open folder existing', exact: true }).click();
    await picker.getByText('No subfolders. You can use this folder or create a new one here.', { exact: true }).waitFor();
    if (await picker.locator('input').count()) throw new Error('Choosing folder still requires path text');
    await picker.getByRole('button', { name: 'Up one folder', exact: true }).click();
    await picker.getByRole('button', { name: 'Open folder existing', exact: true }).waitFor();
    await page.screenshot({ path: path.join(os.tmpdir(), 'vibearound-folder-browser.png'), fullPage: true });
    await picker.getByRole('button', { name: 'Open folder existing', exact: true }).click();
    await picker.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('[data-slot="current-project-folder"]')?.textContent === expected, existing);
    registered.add(existing);
    await picker.getByRole('button', { name: 'Create a new project folder', exact: true }).click();
    await picker.getByRole('button', { name: `Open folder ${name}`, exact: true }).click();
    await picker.getByLabel('New folder name', { exact: true }).fill('project');
    if (await picker.locator('input').count() !== 1) throw new Error('Create should ask only for folder name');
    await picker.getByRole('button', { name: 'Create and use folder', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('[data-slot="current-project-folder"]')?.textContent === expected, project);
    registered.add(project);
    if (!fs.statSync(project).isDirectory()) throw new Error('Created folder missing');

    // Root is explicitly persisted configuration, separate from choosing folders.
    await picker.getByRole('button', { name: 'Configure root folder', exact: true }).click();
    await picker.getByLabel('Folder browser root', { exact: true }).fill(testRoot);
    await picker.getByRole('button', { name: 'Save root folder', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('[data-slot="browsed-folder"]')?.textContent === expected, testRoot);
    rootChanged = true;
    const saved = await (await fetch(`${base}/api/workspaces/browser-root`, { headers })).json();
    if (saved.configured_root !== testRoot) throw new Error('Root was not saved');
    await picker.getByRole('button', { name: 'Use current folder', exact: true }).click();

    await page.getByRole('button', { name: 'Show navigation', exact: true }).last().click();
    await page.getByRole('button', { name: /CLI/ }).filter({ visible: true }).last().click();
    await page.getByRole('button', { name: 'Add CLI session', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Choose another folder', exact: true }).click();
    const start = dialog.getByRole('button', { name: 'Start CLI', exact: true });
    if (!await start.isDisabled()) throw new Error('CLI launch allowed before folder confirmation');
    await dialog.getByRole('button', { name: 'Open folder project', exact: true }).click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'vibearound-cli-folder-browser.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/sessions'));
    await start.click();
    const response = await created;
    if (!response.ok()) throw new Error('CLI launch failed');
    const session = await response.json();
    sessionIds.push(session.session_id);
    if (session.project_path !== project || cliRequest.project_path !== project) throw new Error('CLI folder mismatch');
    if (prompts !== 0) throw new Error('Unexpected model prompt');
    console.log(JSON.stringify({ browsedRootAndNestedFolders: true, noPathEntryForSelection: true, createdInsideBrowsedParent: true, configurableRootPersisted: true, sharedRootUsedByCli: true, cliSelectedFolderConfirmed: true, outsideRootDenied: true, modelPromptsSent: 0 }));
  } catch (error) {
    console.error('Folder browser check failed:', error.name, error.message?.split('\n')[0]);
    throw error;
  } finally {
    await browser.close();
    if (rootChanged) await fetch(`${base}/api/workspaces/browser-root`, { method: 'PUT', headers, body: JSON.stringify({ path: originalRoot.configured_root }) });
    for (const id of sessionIds) await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers });
    for (const folder of registered) await fetch(`${base}/api/workspaces/remove`, { method: 'POST', headers, body: JSON.stringify({ path: folder }) });
    for (const folder of [project, existing, testRoot]) if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
  }
}
main().catch(() => { process.exitCode = 1; });
