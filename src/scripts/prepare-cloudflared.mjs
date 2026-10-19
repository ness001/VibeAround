import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const VERSION = '2026.10.1';
const assets = {
  'x86_64-pc-windows-msvc': ['cloudflared-windows-amd64.exe', '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6'],
  'x86_64-unknown-linux-gnu': ['cloudflared-linux-amd64', '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586'],
  'aarch64-unknown-linux-gnu': ['cloudflared-linux-arm64', '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46'],
  'x86_64-apple-darwin': ['cloudflared-darwin-amd64.tgz', '3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab'],
  'aarch64-apple-darwin': ['cloudflared-darwin-arm64.tgz', '647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc'],
};
export function assetFor(target) {
  if (!Object.hasOwn(assets, target)) throw new Error(`No verified cloudflared asset for ${target}`);
  const [name, sha256] = assets[target];
  return { name, sha256, executable: target.includes('windows') ? 'cloudflared.exe' : 'cloudflared' };
}
export function verify(bytes, sha256) {
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('cloudflared SHA-256 mismatch');
}
export async function prepareCloudflared(target) {
  const asset = assetFor(target);
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cache = join(src, 'desktop/binaries/.cloudflared-cache');
  const output = join(src, 'desktop/binaries/cloudflared');
  mkdirSync(cache, { recursive: true });
  mkdirSync(output, { recursive: true });
  const archive = join(cache, `${VERSION}-${asset.name}`);
  if (!existsSync(archive)) {
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, asset.sha256);
    writeFileSync(archive, bytes);
  }
  const bytes = readFileSync(archive);
  verify(bytes, asset.sha256);
  let binary = bytes;
  if (asset.name.endsWith('.tgz')) {
    const staging = mkdtempSync(join(tmpdir(), 'va-cloudflared-'));
    try {
      const result = spawnSync('tar', ['-xzf', archive, '-C', staging, 'cloudflared'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Cannot extract verified cloudflared archive');
      binary = readFileSync(join(staging, 'cloudflared'));
    } finally { rmSync(staging, { recursive: true }); }
  }
  const destination = join(output, asset.executable);
  writeFileSync(`${destination}.tmp`, binary);
  if (!target.includes('windows')) chmodSync(`${destination}.tmp`, 0o755);
  renameSync(`${destination}.tmp`, destination);
  writeFileSync(join(output, 'LICENSE'), readFileSync(join(src, 'resources/cloudflared-LICENSE')));
  console.log(`Prepared bundled cloudflared ${VERSION} (${target})`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET
      || spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1];
    await prepareCloudflared(target);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
