'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const file = path.resolve(__dirname, '../src/windows-native.cjs');
function fixture(arch) {
  const state = { handle: 1234, flags: 1, success: true, called: [] };
  const koffi = { load: () => ({ func: signature => {
    state.called.push(signature);
    if (signature.includes('LoadCursorW')) return (instance, name) => { assert.equal(instance, 0); assert.equal(name, 32513); return 1234; };
    if (signature.includes('GetCursorInfo')) return info => {
      assert.equal(info.readUInt32LE(0), arch === 'ia32' ? 20 : 24);
      info.writeUInt32LE(state.flags, 4);
      if (arch === 'ia32') info.writeUInt32LE(state.handle, 8); else info.writeBigUInt64LE(BigInt(state.handle), 8);
      return state.success ? 1 : 0;
    };
    if (signature.includes('GetDoubleClickTime')) return () => 650;
    return () => 0;
  } }) };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => { assert.equal(name, 'koffi'); return koffi; }, process: { platform: 'win32', arch }, Buffer });
  return { state, native: module.exports.createWindowsNative() };
}
test('text cursor detection uses the native CURSORINFO layout on x64 and x86 without setting input', () => {
  for (const arch of ['x64', 'ia32']) {
    const { state, native } = fixture(arch);
    assert.equal(native.textCursor(), true);
    assert.equal(native.doubleClickTime(), 650);
    state.handle = 5678; assert.equal(native.textCursor(), false);
    state.handle = 1234; state.flags = 0; assert.equal(native.textCursor(), false);
    state.flags = 1; state.success = false; assert.equal(native.textCursor(), false);
    assert.equal(state.called.some(signature => /SetCursor|SetCursorPos|mouse_event/.test(signature)), false);
  }
});
