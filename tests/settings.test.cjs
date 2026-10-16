'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/settings.cjs');
const encryption = {
  available: async () => true,
  encrypt: async value => Buffer.from(value.split('').reverse().join('')),
  decrypt: async value => value.toString().split('').reverse().join(''),
};
const valid = { baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'private-test-key-123' };

async function createStore(t, crypto = encryption) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huanyi-settings-'));
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('huanyi-settings-'));
  t.after(() => fs.rm(resolved, { recursive: true, force: true }));
  return new SettingsStore(path.join(directory, 'settings.json'), crypto);
}

test('missing settings produce a usable unconfigured state', async t => {
  const store = await createStore(t);
  assert.deepEqual(await store.load(), { baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false, warning: '' });
});

test('persists encrypted keys, never returns them to the renderer, and reloads', async t => {
  const store = await createStore(t);
  const publicState = await store.save(valid);
  assert.equal(publicState.hasApiKey, true);
  assert.equal(publicState.apiKey, undefined);
  const disk = await fs.readFile(store.file, 'utf8');
  assert.equal(disk.includes(valid.apiKey), false);
  const restored = new SettingsStore(store.file, encryption);
  await restored.load();
  assert.equal(restored.privateSettings().apiKey, valid.apiKey);
});

test('blank key preserves existing secret; explicit removal deletes it', async t => {
  const store = await createStore(t);
  await store.save(valid);
  await store.save({ ...valid, model: 'other', apiKey: '' });
  assert.equal(store.privateSettings().apiKey, valid.apiKey);
  await store.save({ ...valid, apiKey: '', removeKey: true });
  assert.equal(store.privateSettings().apiKey, '');
  assert.equal(store.publicSettings().hasApiKey, false);
});

test('unavailable encryption rejects secret persistence without plaintext fallback', async t => {
  const store = await createStore(t, { ...encryption, available: async () => false });
  await assert.rejects(store.save(valid), /安全存储/);
  await assert.rejects(fs.readFile(store.file), { code: 'ENOENT' });
  assert.equal(store.privateSettings().apiKey, '');
});

test('damaged settings and undecryptable secrets are visible, not silently reused', async t => {
  const store = await createStore(t);
  await fs.writeFile(store.file, '{malformed');
  const state = await store.load();
  assert.equal(state.hasApiKey, false);
  assert.match(state.warning, /重新填写/);
  await store.save(valid);
  const broken = new SettingsStore(store.file, { ...encryption, decrypt: async () => { throw new Error('bad encryption'); } });
  assert.equal((await broken.load()).hasApiKey, false);
  assert.match(broken.publicSettings().warning, /解密/);
});
