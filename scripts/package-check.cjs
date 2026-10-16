'use strict';
// Static package inspection only: never spawn or launch Huanyi.exe.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
async function main() {
  const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
  const unpacked = `${archive}.unpacked`;
  const executable = path.join(root, 'dist', `Huanyi-${version}-x64.exe`);
  const list = asar.listPackage(archive).map(item => item.replaceAll('\\', '/').replace(/^\//, ''));
  const required = [
    'src/main.cjs', 'src/preload.cjs', 'src/button-preload.cjs', 'src/capture-preload.cjs',
    'src/renderer/index.html', 'src/renderer/app.js', 'src/renderer/styles.css',
    'src/renderer/selection-button.html', 'src/renderer/selection-button.js', 'src/renderer/selection-button.css',
    'src/renderer/capture.html', 'src/renderer/capture.js', 'src/renderer/capture.css',
    'src/screen-capture.cjs', 'src/mouse-selection.cjs', 'src/windows-helper.cjs',
    'src/provider.cjs', 'src/contracts.cjs', 'src/geometry.cjs', 'src/preferences.cjs',
    'src/settings.cjs', 'src/windows-native.cjs', 'src/selection.cjs',
    'src/native/windows-helper.ps1', 'src/native/selection.cs', 'assets/icon.ico',
  ];
  for (const file of required) {
    assert.ok(list.includes(file), `Missing packaged file: ${file}`);
    const packaged = asar.extractFile(archive, path.normalize(file));
    assert.deepEqual(packaged, await fs.readFile(path.join(root, file)), `Package does not match source: ${file}`);
  }
  for (const file of ['src/native/windows-helper.ps1', 'src/native/selection.cs']) {
    assert.ok(asar.statFile(archive, path.normalize(file)).unpacked, `Native helper must be outside asar: ${file}`);
    assert.ok((await fs.stat(path.join(unpacked, file))).size > 0);
  }
  assert.ok(list.some(file => file.endsWith('.node')), 'Native input library is packaged');
  assert.equal(list.some(file => file.startsWith('tests/') || file.startsWith('scripts/') || file.startsWith('.test-artifacts/')), false, 'Test profiles, logs and fixtures are not shipped');
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version, version);
  const handle = await fs.open(executable, 'r');
  try {
    const header = Buffer.alloc(64);
    await handle.read(header, 0, 64, 0);
    assert.equal(header.subarray(0, 2).toString('ascii'), 'MZ');
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, header.readUInt32LE(60));
    assert.deepEqual(signature, Buffer.from([0x50, 0x45, 0, 0]));
    assert.ok((await handle.stat()).size > 10 * 1024 * 1024, 'Portable EXE includes an application payload');
  } finally { await handle.close(); }
  const report = { passed: true, version, executable, archive, requiredFiles: required.length, executableLaunched: false, desktopVerified: false };
  await fs.writeFile(path.join(root, '.test-artifacts/package-results.json'), JSON.stringify(report, null, 2));
  console.log(`Static package verification passed for ${version}: source matches, native helpers unpacked, PE executable present. EXE was NOT launched.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
