'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeEndpoint, validateSettings } = require('./contracts.cjs');

const DEFAULT_SETTINGS = { baseUrl: 'https://api.openai.com/v1', model: '', encryptedApiKey: '' };

class SettingsStore {
  constructor(file, encryption) {
    this.file = file;
    this.encryption = encryption;
    this.settings = { ...DEFAULT_SETTINGS };
    this.apiKey = '';
    this.loadWarning = '';
  }

  async load() {
    try {
      const stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.settings = {
        baseUrl: normalizeEndpoint(stored.baseUrl),
        model: typeof stored.model === 'string' && stored.model.length <= 120 ? stored.model : '',
        encryptedApiKey: typeof stored.encryptedApiKey === 'string' ? stored.encryptedApiKey : '',
      };
      if (this.settings.encryptedApiKey) {
        this.apiKey = await this.encryption.decrypt(Buffer.from(this.settings.encryptedApiKey, 'base64'));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.apiKey = '';
        this.loadWarning = '原有配置无法读取或解密，请重新填写模型设置。';
      }
    }
    return this.publicSettings();
  }

  publicSettings() {
    return {
      baseUrl: this.settings.baseUrl,
      model: this.settings.model,
      hasApiKey: Boolean(this.apiKey),
      warning: this.loadWarning,
    };
  }

  privateSettings() {
    return { baseUrl: this.settings.baseUrl, model: this.settings.model, apiKey: this.apiKey };
  }

  async save(input) {
    const valid = validateSettings(input);
    const nextKey = valid.removeKey ? '' : (valid.apiKey || this.apiKey);
    let encryptedApiKey = '';
    if (nextKey) {
      if (!(await this.encryption.available())) {
        throw new Error('系统安全存储不可用，未保存 API Key。唤译不会将密钥明文写入磁盘。');
      }
      encryptedApiKey = (await this.encryption.encrypt(nextKey)).toString('base64');
    }
    const next = { baseUrl: valid.baseUrl, model: valid.model, encryptedApiKey };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file);
    this.settings = next;
    this.apiKey = nextKey;
    this.loadWarning = '';
    return this.publicSettings();
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS };
