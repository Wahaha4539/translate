'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

class Preferences {
  constructor(file) { this.file = file; this.mouseSelectionEnabled = true; }
  async load() {
    try { this.mouseSelectionEnabled = JSON.parse(await fs.readFile(this.file, 'utf8')).mouseSelectionEnabled !== false; }
    catch (error) { if (error.code !== 'ENOENT') this.mouseSelectionEnabled = false; }
    return this.publicState();
  }
  publicState() { return { mouseSelectionEnabled: this.mouseSelectionEnabled }; }
  async save(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('划词开关参数无效。');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify({ mouseSelectionEnabled: enabled }));
    await fs.rename(`${this.file}.tmp`, this.file);
    this.mouseSelectionEnabled = enabled;
    return this.publicState();
  }
}
module.exports = { Preferences };
