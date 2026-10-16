'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function main() {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const base = `http://127.0.0.1:${auth.port}/va`;
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  let sessionId;
  let socket;
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    await page.addInitScript(token => sessionStorage.setItem('vibearound.auth.token', token), auth.token);
    let prompts = 0;
    page.on('websocket', ws => ws.on('framesent', ({ payload }) => {
      try { if (JSON.parse(String(payload)).type === 'message') prompts++; } catch {}
    }));
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Effort"]')].some(s => !s.disabled), undefined, { timeout: 60000 });
    const labels = await page.evaluate(() => {
      const read = label => [...document.querySelectorAll(`select[aria-label="${label}"]`)].filter(e => e.getClientRects().length).map(e => ({ value: e.value, options: [...e.options].map(o => o.textContent) }));
      return { effort: read('Effort'), context: read('Auto-compaction budget') };
    });
    console.log(JSON.stringify({ labels, modelPromptsSent: prompts }));
    if (prompts !== 0 || !labels.effort.some(s => s.options.includes('Default (High)')) || !labels.context.some(s => s.options.includes('Agent default (automatic)'))) throw new Error('Unexpected default labels');
    if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true });

    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ tool: 'generic', project_path: process.env.VIBEAROUND_WORKSPACE, cols: 100, rows: 35 }) });
    if (!created.ok) throw new Error('Disposable terminal creation failed');
    sessionId = (await created.json()).session_id;
    let output = '';
    socket = new WebSocket(`ws://127.0.0.1:${auth.port}/va/ws?session_id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(auth.token)}`);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      output = (output + text).slice(-100000);
      if (text.includes('\x1b[6n')) socket.send('\x1b[1;1R');
      if (text.includes('\x1b[c')) socket.send('\x1b[?1;2c');
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Terminal websocket failed')); });
    await new Promise(resolve => setTimeout(resolve, 1500));
    socket.send("[Console]::WriteLine(('ENV_'+'CHECK:') + [bool]$env:CLAUDE_CODE_CHILD_SESSION + ',' + [bool]$env:CLAUDECODE)\r");
    const deadline = Date.now() + 15000;
    while (!output.includes('ENV_CHECK:False,False') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!output.includes('ENV_CHECK:False,False')) throw new Error('Child marker persisted in new terminal');
    output = '';
    socket.send('claude --strict-mcp-config\r');
    await new Promise(resolve => setTimeout(resolve, 15000));
    const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
    const cliStarted = /Claude\s*Code|Welcome\s*to\s*Claude|trust.*folder|trust\s*this|New\s*MCP\s*server\s*found/i.test(plain);
    if (!cliStarted) {
      let safe = plain;
      for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
        if (process.env[name]) safe = safe.split(process.env[name]).join('<redacted>');
      }
      fs.writeFileSync(path.join(require('node:os').tmpdir(), 'vibearound-cli-startup-check.txt'), safe);
    }
    const transcriptWarning = /Transcript saving is off|inherited CLAUDE_CODE_CHILD_SESSION/i.test(output);
    console.log(JSON.stringify({ terminalChildMarkerRemoved: true, terminalNestedMarkerRemoved: true, cliStarted, transcriptWarning }));
    if (!cliStarted || transcriptWarning) throw new Error('Native Claude startup verification failed');
  } finally {
    if (socket) socket.close();
    if (sessionId) await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE', headers });
    await browser.close();
  }
}
main().catch(error => { console.error('Local verification failed:', error.name, 'Private terminal output omitted.'); process.exitCode = 1; });
