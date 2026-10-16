const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'VIBEAROUND_DATA_DIR', 'VIBEAROUND_WORKSPACE']) {
  if (!process.env[key]) {
    console.error(`Missing ${key}; start from the existing approved credential environment.`);
    process.exit(1);
  }
}
const repo = path.resolve(__dirname, '..', '..');
const executable = process.env.VIBEAROUND_EXECUTABLE || path.join(
  repo, 'src', 'target', 'release',
  process.platform === 'win32' ? 'vibearound-desktop.exe' : 'vibearound-desktop',
);
if (!fs.existsSync(executable)) {
  console.error('Source-built desktop executable not found. Build it first or set VIBEAROUND_EXECUTABLE.');
  process.exit(1);
}
const env = { ...process.env };
// This launches an independent application, not a nested Claude Code session.
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_CHILD_SESSION;
const app = spawn(executable, [], {
  cwd: process.env.VIBEAROUND_WORKSPACE, env,
  stdio: 'ignore', windowsHide: false,
});
app.on('spawn', () => console.log(`VibeAround process started: ${app.pid}`));
app.on('error', () => { console.error('VibeAround could not start.'); process.exitCode = 1; });
app.on('exit', (code, signal) => {
  console.log(`VibeAround exited: ${code ?? signal}`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.kill());
