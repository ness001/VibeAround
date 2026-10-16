const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (!process.env.VIBEAROUND_DATA_DIR) throw new Error('Set VIBEAROUND_DATA_DIR to private app state');
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.VIBEAROUND_DATA_DIR, 'auth.json'), 'utf8'));
  const root = `http://127.0.0.1:${auth.port}/va`;
  const headers = { Authorization: `Bearer ${auth.token}` };
  for (const endpoint of ['/api/agents', '/api/sessions', '/api/workspaces', '/api/launcher/preferences']) {
    const response = await fetch(root + endpoint, { headers });
    console.log(JSON.stringify({ endpoint, status: response.status }));
    if (!response.ok) throw new Error('Authenticated local check failed');
  }
  const response = await fetch(root + '/api/launcher/plan', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: 'claude', profile_id: 'direct' }),
  });
  if (response.ok) {
    const data = await response.json();
    console.log(JSON.stringify({ launchPlanStatus: response.status, topLevelFields: Object.keys(data) }));
    for (const key of ['command', 'args', 'workspace', 'agent', 'terminal']) {
      if (data[key] !== undefined) console.log(JSON.stringify({ [key]: data[key] }));
    }
  } else {
    console.log(JSON.stringify({ launchPlanStatus: response.status }));
  }
}
main().catch(() => { console.error('Local verification failed; secrets omitted.'); process.exitCode = 1; });
