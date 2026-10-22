'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const childProcess = require('node:child_process');
const { createRequire } = require('node:module');
const { createMouseSelectionMonitor } = require('../src/mouse-selection.cjs');
const helperFile = path.resolve(__dirname, '../src/windows-helper.cjs');
const nativeDirectory = path.resolve(__dirname, '../src/native');

// Exercise the real PowerShell protocol with a synthetic UIA reader. Never read
// desktop controls, create a window, or change focus/input/the clipboard.
const reader = `
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public sealed class HuanyiSelectionResult {
    public string Text { get; set; }
    public string Blocked { get; set; }
}
public static class HuanyiSelection {
    private static int reads;
    public static HuanyiSelectionResult Read(long handle, int x, int y, int ownProcess) {
        reads++;
        switch (handle) {
            case 2: throw new COMException("provider E_FAIL", unchecked((int)0x80004005));
            case 3: throw new InvalidOperationException("wrapped", new COMException("provider failed"));
            case 4: throw new ElementNotAvailableException("element disappeared");
            case 5: throw new ElementNotAvailableException("element disappeared", new Exception("provider details"));
            case 6: throw new InvalidOperationException("unexpected reader failure");
            case 7: return new HuanyiSelectionResult { Blocked = "password" };
            case 8: return new HuanyiSelectionResult { Blocked = "too-long" };
            default: return new HuanyiSelectionResult { Text = "selection-" + reads };
        }
    }
}`;

async function fixture(t, source = reader) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huanyi-helper-test-'));
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}huanyi-helper-test-`));
  const children = [];
  let helper;
  t.after(async () => {
    helper?.stop();
    await Promise.all(children.map(({ child, exited }) => {
      if (child.exitCode === null) child.kill();
      return exited;
    }));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const script = path.join(directory, 'windows-helper.ps1');
  await fs.copyFile(path.join(nativeDirectory, 'windows-helper.ps1'), script);
  await fs.writeFile(path.join(directory, 'selection.cs'), source);
  const load = createRequire(helperFile);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(helperFile, 'utf8'), {
    module, __dirname: path.dirname(helperFile), process, setTimeout, clearTimeout,
    require: name => name !== 'node:child_process' ? load(name) : { spawn(executable, args, options) {
      assert.equal(options.windowsHide, true);
      assert.ok(args.includes('-Mta'));
      assert.ok(args.includes('-NonInteractive'));
      const child = childProcess.spawn(executable, [...args.slice(0, -1), script], options);
      const exited = new Promise(resolve => child.once('exit', resolve));
      children.push({ child, exited });
      return child;
    } },
  }, { filename: helperFile });
  helper = new module.exports.WindowsHelper();
  return { helper, children, read: hwnd => helper.run({ hwnd, x: 0, y: 0, ownProcess: 0 }) };
}

const windowsOnly = { skip: process.platform !== 'win32', timeout: 30000 };
test('UIA provider failures are empty reads, not service failures, and the helper stays usable', windowsOnly, async t => {
  const { read, children } = await fixture(t);
  assert.equal((await read(1)).text, 'selection-1');
  for (const handle of [2, 3, 4, 5]) {
    const result = await read(handle);
    assert.equal(result.text, null);
    assert.equal(result.blocked, null);
  }
  assert.equal((await read(1)).text, 'selection-6');
  assert.equal(children.length, 1, 'Recoverable provider errors must not restart the helper');
});
test('UIA protocol preserves password/length blocking and still reports unexpected failures', windowsOnly, async t => {
  const { read } = await fixture(t);
  assert.equal((await read(7)).blocked, 'password');
  assert.equal((await read(8)).blocked, 'too-long');
  await assert.rejects(read(6), /unexpected reader failure/);
  assert.equal((await read(1)).text, 'selection-4');
});
test('helper initialization errors are not mistaken for an empty selection', windowsOnly, async t => {
  const { read } = await fixture(t, 'this is deliberately invalid C#');
  await assert.rejects(read(1));
});

test('E_FAIL keeps the click-to-copy candidate without a global mouse error; later gestures still read text', windowsOnly, async t => {
  const { helper } = await fixture(t);
  let down = false;
  let point = { x: 10, y: 10 };
  let hwnd = 2;
  const offered = [];
  const errors = [];
  const monitor = createMouseSelectionMonitor({
    native: { mouseDown: () => down, escapeDown: () => false, foreground: () => hwnd, windowProcess: () => 10, textCursor: () => true },
    getPoint: () => point, toPhysical: point => point, processId: 20,
    readSelection: input => helper.run(input), cancelRead: () => { if (helper.pending) helper.stop(); },
    onSelection: candidate => offered.push(candidate), onDismiss: () => {}, onError: error => errors.push(error),
  });
  t.after(() => monitor.stop());
  const drag = () => { down = true; monitor.tick(); point = { x: point.x + 20, y: 10 }; down = false; monitor.tick(); };
  drag();
  assert.equal(offered.length, 1, 'Button is available before the provider responds');
  assert.equal((await offered[0].readResult).text, null, 'Explicit click can still use the existing copy fallback');
  assert.equal(offered[0].isCurrent(), true);
  assert.deepEqual(errors, [], 'A provider E_FAIL must not become a global unavailable notice');
  hwnd = 1;
  drag();
  assert.equal((await offered[1].readResult).text, 'selection-2');
  assert.equal(offered[1].isCurrent(), true);
  assert.deepEqual(errors, []);
});
