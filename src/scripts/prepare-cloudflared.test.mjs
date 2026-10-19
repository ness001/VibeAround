import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetFor, verify } from './prepare-cloudflared.mjs';
test('selects pinned assets without falling back to another architecture', () => {
  assert.equal(assetFor('x86_64-pc-windows-msvc').executable, 'cloudflared.exe');
  assert.match(assetFor('aarch64-apple-darwin').name, /arm64.tgz$/);
  assert.throws(() => assetFor('aarch64-pc-windows-msvc'), /No verified/);
  assert.throws(() => assetFor('universal-apple-darwin'), /No verified/);
});
test('rejects corrupted downloads and cache entries', () => {
  const bytes = Buffer.from('verified fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => verify(bytes, hash));
  assert.throws(() => verify(Buffer.from('modified'), hash), /SHA-256 mismatch/);
});
