'use strict';

const { buildMessages, normalizeEndpoint } = require('./contracts.cjs');

function endpointFor(baseUrl) {
  const base = normalizeEndpoint(baseUrl);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Keep CRLF intact across network chunks before normalizing it.
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 200000) throw new Error('模型返回的数据块过大，请更换服务或重试。');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = record.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (done) {
        const data = buffer.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  return '';
}

async function translate(settings, request, { signal, onDelta = () => {}, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  if (!settings.apiKey) throw new Error('请先在设置中填写 API Key。');
  if (!settings.model) throw new Error('请先在设置中填写模型名称。');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let output = '';
  let truncated = false;
  try {
    const response = await fetchImpl(endpointFor(settings.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model, stream: true, messages: buildMessages(request) }),
      signal: combined,
      redirect: 'error',
    });
    if (!response.ok) {
      const messages = {
        401: 'API Key 无效或已过期，请检查设置。',
        403: '当前账号无权使用这个模型或服务。',
        404: '接口或模型不存在，请检查 API 地址和模型名称。',
        429: '请求过于频繁或额度不足，请稍后重试并检查服务商额度。',
      };
      if (request.image && response.status === 413) throw new Error('模型服务拒绝了过大的截图，请缩小框选区域后重试。');
      if (request.image && [400, 415, 422].includes(response.status)) throw new Error(`服务拒绝了截图请求（HTTP ${response.status}）。请确认当前模型支持图片输入，且接口支持 image_url；也可缩小截图后重试。`);
      throw new Error(messages[response.status] || `模型服务暂时不可用（HTTP ${response.status}）。`);
    }
    const append = value => {
      if (!value) return;
      output += value;
      if (output.length > 100000) throw new Error('译文超过长度上限，请缩短原文。');
      onDelta(value);
    };
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      if (!response.body) throw new Error('模型没有返回可读取的数据流。');
      let finished = false;
      for await (const data of readSSE(response.body)) {
        if (data.trim() === '[DONE]') { finished = true; break; }
        let packet;
        try { packet = JSON.parse(data); } catch { throw new Error('服务返回了无效的数据流，请确认兼容 Chat Completions 接口。'); }
        if (packet.error) throw new Error(request.image ? '截图翻译失败，请确认模型及接口支持图片输入，并检查服务商额度。' : '模型服务返回了错误，请检查模型设置和服务商额度。');
        const choice = packet.choices?.[0];
        append(extractText(choice?.delta?.content));
        if (choice?.finish_reason) finished = true;
        if (choice?.finish_reason === 'length') truncated = true;
      }
      if (!finished) throw new Error('模型连接提前结束，译文可能不完整，请重新翻译。');
    } else {
      const payload = await response.json();
      if (payload.error) throw new Error(request.image ? '截图翻译失败，请确认模型及接口支持图片输入。' : '模型服务返回了错误，请检查模型设置。');
      append(extractText(payload.choices?.[0]?.message?.content));
      truncated = payload.choices?.[0]?.finish_reason === 'length';
    }
    if (!output.trim()) throw new Error('模型未返回译文，请确认模型支持文本输出。');
    return { text: output.trim(), warning: truncated ? '模型输出达到长度限制，译文可能不完整。请分段翻译。' : '' };
  } catch (error) {
    if (signal?.aborted) throw new Error('已停止翻译。');
    if (timeout.signal.aborted) throw new Error('模型响应超时，请稍后重试。');
    if (error instanceof TypeError || error.name === 'SyntaxError') throw new Error('无法连接模型或返回格式不正确，请检查地址、网络和接口兼容性。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { endpointFor, readSSE, translate };
