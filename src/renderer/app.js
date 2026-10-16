'use strict';

const $ = id => document.getElementById(id);
const source = $('source');
const result = $('result');
const api = window.huanyi;
let settings = { baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false, shortcutRegistered: true, selectionShortcutRegistered: true };
let style = 'natural';
let tone = 'neutral';
let toneStrength = 'balanced';
const strengthValues = ['subtle', 'balanced', 'strong'];
const strengthLabels = { subtle: '一点点', balanced: '明显', strong: '拉满' };
let running = false;
let captureBusy = false;
let sourceImage = '';
let sourceImageSize = '';

function setSourceImage(captured = null) {
  sourceImage = captured?.image || '';
  sourceImageSize = captured ? `${captured.width} × ${captured.height}` : '';
  source.hidden = Boolean(sourceImage);
  $('source-image').hidden = !sourceImage;
  if (sourceImage) $('source-screenshot').src = sourceImage;
  else $('source-screenshot').removeAttribute('src');
  document.body.classList.toggle('has-image', Boolean(sourceImage));
}
let activeId = '';
let output = '';
let completedRequest = null;
let removeKey = false;
let noticeTimer;

async function unwrap(promise) {
  const response = await promise;
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

function notify(text, error = false, transient = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
  if (transient) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500);
}

function currentMatchesSource() {
  return completedRequest && completedRequest.text === source.value.trim() && (completedRequest.image || '') === sourceImage
    && completedRequest.target === $('target').value && completedRequest.style === style;
}

function effectiveStrength() {
  return tone === 'neutral' ? 'balanced' : toneStrength;
}

function currentMatchesResult() {
  return currentMatchesSource() && completedRequest.tone === tone
    && completedRequest.toneStrength === effectiveStrength();
}

function toneLabel(value, strength) {
  const label = document.querySelector('[data-tone="' + value + '"]').textContent;
  return value === 'neutral' ? label : label + ' · ' + strengthLabels[strength];
}

function updateStrengthLabel() {
  const strength = strengthValues[Number($('tone-strength').value) - 1];
  $('tone-strength-label').textContent = strengthLabels[strength];
  $('tone-strength').setAttribute('aria-valuetext', strengthLabels[strength]);
}

function renderToneControls() {
  document.querySelectorAll('button[data-tone]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.tone === tone));
    button.title = button.dataset.description;
  });
  const selected = document.querySelector('[data-tone="' + tone + '"]');
  $('tone-more').value = selected.tagName === 'OPTION' ? tone : '';
  $('tone-more').classList.toggle('active', selected.tagName === 'OPTION');
  $('tone-description').textContent = selected.dataset.description;
  $('tone-strength').value = String(strengthValues.indexOf(toneStrength) + 1);
  updateStrengthLabel();
}

function selectTone(nextTone, nextStrength = toneStrength) {
  if (running || captureBusy) return;
  const canRegenerate = Boolean(output && currentMatchesSource());
  tone = nextTone;
  toneStrength = nextStrength;
  renderToneControls();
  updateControls();
  // Never send text merely because an option changed before a first translation,
  // or after the source/language/style no longer matches the existing result.
  if (canRegenerate && !currentMatchesResult()) {
    void runTranslation('', true).catch(error => notify(error.message, true));
  }
}

function updateControls() {
  const busy = running || captureBusy;
  const length = source.value.length;
  $('character-count').textContent = sourceImage ? `截图 · ${sourceImageSize}` : `${length.toLocaleString('zh-CN')} / 24,000 字符`;
  $('character-count').style.color = length > 24000 ? '#a05d44' : '';
  $('translate-button').disabled = captureBusy || !running && (!sourceImage && !source.value.trim() || length > 24000);
  $('translate-button').classList.toggle('running', running);
  $('translate-button').querySelector('span').textContent = running ? '停止翻译' : '开始翻译';
  $('copy-button').disabled = busy || !output;
  $('capture-button').disabled = busy;
  $('settings-button').disabled = captureBusy;
  const canRevise = !busy && Boolean(output) && Boolean(currentMatchesResult());
  document.querySelectorAll('.revision-chip').forEach(button => { button.disabled = !canRevise; });
  $('revision-input').disabled = !canRevise;
  $('revision-submit').disabled = !canRevise || !$('revision-input').value.trim();
  source.readOnly = busy;
  $('paste-button').disabled = busy;
  $('clear-button').disabled = busy || !source.value && !sourceImage;
  $('target').disabled = busy;
  document.querySelectorAll('button[data-tone]').forEach(button => { button.disabled = busy; });
  $('tone-more').disabled = busy;
  $('tone-strength').disabled = busy || tone === 'neutral';
  $('tone-strength-control').classList.toggle('inactive', tone === 'neutral');
  document.querySelectorAll('[data-style]').forEach(button => { button.disabled = busy; });
  if (!running && output && completedRequest) {
    if (!currentMatchesResult()) $('result-status').textContent = '原文或选项已变化 · 请重新翻译';
    else if ($('result-status').textContent === '原文或选项已变化 · 请重新翻译') $('result-status').textContent = completedRequest.label;
  }
}

function renderOutput() {
  result.textContent = output;
  $('result-tone').hidden = !output || !completedRequest;
  $('result-tone').textContent = completedRequest ? toneLabel(completedRequest.tone, completedRequest.toneStrength) : '';
  result.hidden = !output;
  $('empty-result').hidden = Boolean(output);
  result.classList.toggle('streaming', running);
  $('result-count').textContent = output ? `${output.length.toLocaleString('zh-CN')} 字符` : '';
  updateControls();
}

function resetResult() {
  output = '';
  completedRequest = null;
  $('result-status').textContent = '等待你的文字';
  renderOutput();
}

function receiveClipboard(text) {
  if (running || captureBusy || !text.trim() || text === source.value) return;
  setSourceImage();
  source.value = text;
  resetResult();
  notify(text.length > 24000 ? '剪贴板内容超过 24,000 字符，请分段翻译。' : '已读取剪贴板；点击“开始翻译”后才会发送到模型。', text.length > 24000, text.length <= 24000);
  source.focus();
}

function renderModelStatus() {
  const configured = settings.hasApiKey && Boolean(settings.model);
  $('model-status').classList.toggle('configured', configured);
  $('model-status-text').textContent = configured ? `模型已配置 · ${settings.model}` : '尚未配置模型';
  if (!settings.shortcutRegistered) notify('Ctrl + Alt + T 被其他程序占用。当前仍可通过系统托盘打开唤译。', true);
  else if (!settings.selectionShortcutRegistered) notify('Ctrl + Alt + D 被其他程序占用。选中即译暂不可用，仍可手动复制并唤出翻译。', true);
  else if (!settings.captureShortcutRegistered) notify('Ctrl + Alt + S 被其他程序占用，请使用右上角截图按钮。', true);
  else if (settings.warning) notify(settings.warning, true);
}

function openSettings() {
  if (running || captureBusy) { notify('请先完成翻译或截图，再修改模型设置。', true); return; }
  $('mouse-selection-enabled').checked = settings.mouseSelectionEnabled !== false;
  $('mouse-status').textContent = settings.mouseWarning || '';
  $('api-url').value = settings.baseUrl;
  $('model-name').value = settings.model;
  $('api-key').value = '';
  $('api-key').placeholder = settings.hasApiKey ? '已安全保存，留空则保持不变' : '输入 API Key';
  $('remove-key').hidden = !settings.hasApiKey;
  $('settings-error').hidden = true;
  $('key-help').textContent = '密钥通过系统安全存储加密，界面不会回显已保存的密钥。';
  removeKey = false;
  $('settings-dialog').showModal();
}

async function runTranslation(instruction = '', toneChange = false) {
  if (captureBusy) return;
  if (running) { await unwrap(api.stop()); return; }
  if (!sourceImage && !source.value.trim() || source.value.length > 24000) return;
  if (!settings.hasApiKey || !settings.model) { openSettings(); notify('先连接你的模型，再开始真实翻译。'); return; }
  if (instruction && !currentMatchesResult()) { notify('原文或翻译选项已变化，请先重新翻译。', true); return; }
  const request = {
    id: crypto.randomUUID(), text: source.value.trim(), ...(sourceImage ? { image: sourceImage } : {}), target: $('target').value, style, tone, toneStrength: effectiveStrength(),
    ...(instruction ? { instruction, previous: output } : {}),
  };
  const prior = { output, completedRequest };
  const preservePrevious = Boolean(instruction || currentMatchesSource());
  activeId = request.id;
  running = true;
  output = '';
  completedRequest = null;
  $('result-status').textContent = instruction ? 'AI 正在修订表达…' : toneChange ? `AI 正在调整为「${toneLabel(tone, effectiveStrength())}」…` : sourceImage ? 'AI 正在识别截图并翻译…' : 'AI 正在理解并翻译…';
  notify('');
  renderOutput();
  try {
    const response = await unwrap(api.translate(request));
    output = response.text;
    completedRequest = { text: request.text, image: request.image || '', target: request.target, style: request.style, tone: request.tone, toneStrength: request.toneStrength, label: instruction ? '已按要求修订' : '翻译完成' };
    $('result-status').textContent = instruction ? '已按要求修订' : '翻译完成';
    if (instruction) $('revision-input').value = '';
    if (response.warning) notify(response.warning, true);
  } catch (error) {
    // A failed attitude switch must not replace the last good result with a partial one.
    if (preservePrevious) { output = prior.output; completedRequest = prior.completedRequest; }
    else completedRequest = null;
    $('result-status').textContent = preservePrevious ? '本次请求未完成 · 已保留上一版' : output ? '未完成 · 当前显示部分译文' : '本次请求未完成';
    notify(error.message, error.message !== '已停止翻译。');
  } finally {
    running = false;
    activeId = '';
    renderOutput();
  }
}

source.addEventListener('input', () => { updateControls(); if (!source.value && !running) resetResult(); });
$('target').addEventListener('change', updateControls);
$('revision-input').addEventListener('input', updateControls);
document.querySelectorAll('[data-style]').forEach(button => {
  button.addEventListener('click', () => {
    style = button.dataset.style;
    document.querySelectorAll('[data-style]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateControls();
  });
});
document.querySelectorAll('button[data-tone]').forEach(button => {
  button.addEventListener('click', () => selectTone(button.dataset.tone));
});
$('tone-more').addEventListener('change', () => selectTone($('tone-more').value));
// Preview while dragging; submit at most once when the user commits the change.
$('tone-strength').addEventListener('input', updateStrengthLabel);
$('tone-strength').addEventListener('change', () => {
  if (tone !== 'neutral') selectTone(tone, strengthValues[Number($('tone-strength').value) - 1]);
});
$('translate-button').addEventListener('click', () => { void runTranslation().catch(error => notify(error.message, true)); });
document.querySelectorAll('.revision-chip').forEach(button => {
  button.addEventListener('click', () => { void runTranslation(button.dataset.instruction).catch(error => notify(error.message, true)); });
});
$('revision-form').addEventListener('submit', event => {
  event.preventDefault();
  const instruction = $('revision-input').value.trim();
  if (instruction) void runTranslation(instruction).catch(error => notify(error.message, true));
});
$('paste-button').addEventListener('click', async () => {
  try {
    const text = await unwrap(api.readClipboard());
    if (!text.trim()) notify('剪贴板中还没有文字。', false, true);
    else receiveClipboard(text);
  } catch (error) { notify(error.message, true); }
});
$('clear-button').addEventListener('click', () => { setSourceImage(); source.value = ''; $('revision-input').value = ''; resetResult(); notify(''); source.focus(); });
$('copy-button').addEventListener('click', async () => {
  try { await unwrap(api.writeClipboard(output)); notify('译文已复制，可以回到原来的软件粘贴。', false, true); }
  catch (error) { notify(error.message, true); }
});
$('hide-button').addEventListener('click', () => { void unwrap(api.hide()).catch(error => notify(error.message, true)); });
$('pin-button').addEventListener('click', async () => {
  try {
    const pin = await unwrap(api.pin($('pin-button').getAttribute('aria-pressed') !== 'true'));
    $('pin-button').setAttribute('aria-pressed', String(pin));
  } catch (error) { notify(error.message, true); }
});
$('capture-button').addEventListener('click', async () => {
  try { await unwrap(api.startCapture()); } catch (error) { notify(error.message, true); }
});
$('expand-button').addEventListener('click', () => { void unwrap(api.expand()).catch(error => notify(error.message, true)); });
$('mouse-selection-enabled').addEventListener('change', async event => {
  const control = event.target;
  control.disabled = true;
  try { Object.assign(settings, await unwrap(api.setMouseEnabled(control.checked))); $('mouse-status').textContent = control.checked ? '已开启；仅在点击翻译后发送文字。' : '已关闭鼠标划词；快捷键与截图仍可用。'; }
  catch (error) { control.checked = settings.mouseSelectionEnabled !== false; $('mouse-status').textContent = error.message; }
  finally { control.disabled = false; }
});
$('settings-button').addEventListener('click', openSettings);
$('model-status').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => { $('api-key').value = ''; $('settings-dialog').close(); });
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('remove-key').addEventListener('click', () => {
  removeKey = true;
  $('api-key').value = '';
  $('api-key').placeholder = '点击保存后移除密钥';
  $('key-help').textContent = '尚未移除。点击“保存配置”后生效，取消则保留。';
  $('remove-key').hidden = true;
});
$('api-key').addEventListener('input', () => { if ($('api-key').value.trim()) removeKey = false; });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('save-settings').disabled = true;
  $('settings-error').hidden = true;
  try {
    const updated = await unwrap(api.saveSettings({ baseUrl: $('api-url').value, model: $('model-name').value, apiKey: $('api-key').value, removeKey }));
    settings = { ...settings, ...updated };
    renderModelStatus();
    $('api-key').value = '';
    $('settings-dialog').close();
    notify(settings.hasApiKey ? '配置已保存。现在可以开始翻译。' : '设置已保存；填写 API Key 后才能翻译。', false, true);
  } catch (error) {
    $('settings-error').textContent = error.message;
    $('settings-error').hidden = false;
  } finally { $('save-settings').disabled = false; }
});
document.addEventListener('keydown', event => {
  if ($('settings-dialog').open) return;
  if (event.key === 'Escape') { event.preventDefault(); void unwrap(api.hide()).catch(error => notify(error.message, true)); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void runTranslation().catch(error => notify(error.message, true));
  }
});
api.onCompact(value => { document.body.classList.toggle('compact', value); $('expand-button').hidden = !value; });
api.onCaptureBusy(value => { captureBusy = value; updateControls(); });
api.onPreferences(value => { Object.assign(settings, value); $('mouse-selection-enabled').checked = value.mouseSelectionEnabled; });
api.onSettingsRequired(() => { openSettings(); notify('截图会直接上传到当前模型，请先配置支持图片输入的模型。'); });
api.onImage(async captured => {
  if (running) return;
  captureBusy = false;
  if ($('settings-dialog').open) $('settings-dialog').close();
  setSourceImage(captured);
  source.value = '';
  $('revision-input').value = '';
  resetResult();
  try { await runTranslation(); } catch (error) { notify(error.message, true); }
});
api.onClipboard(receiveClipboard);
api.onSelection(async captured => {
  if (running || captureBusy) return;
  if ($('settings-dialog').open) $('settings-dialog').close();
  setSourceImage();
  source.value = captured.text;
  $('revision-input').value = '';
  resetResult();
  try {
    await runTranslation();
    if (captured.warning) notify(captured.warning, true);
  } catch (error) { notify(error.message, true); }
});
api.onNotice(message => notify(message, true));
api.onDelta(packet => {
  if (!running || packet.id !== activeId) return;
  output += packet.text;
  renderOutput();
});

renderToneControls();
updateControls();

(async () => {
  try { settings = await unwrap(api.getSettings()); renderModelStatus(); updateControls(); source.focus(); }
  catch (error) {
    settings = { baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false, shortcutRegistered: false };
    notify(`初始化失败：${error.message}`, true);
  }
})();
