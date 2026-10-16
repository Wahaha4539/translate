'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { translate, readSSE } = require('../src/provider.cjs');
const settings = { baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'not-real' };
const request = { text: 'Hello', target: 'zh-CN', style: 'natural' };
const encoder = new TextEncoder();
function streamResponse(records) {
  const bytes = encoder.encode(records);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 1) controller.enqueue(bytes.slice(i, i + 1));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function packet(text) { return JSON.stringify({ choices: [{ delta: { content: text } }] }); }

test('SSE parsing survives split UTF-8, CRLF, comments, metadata and tail records', async () => {
  const response = streamResponse(`: keepalive\r\nevent: message\r\ndata: ${packet('你好')}\r\n\r\ndata: ${packet('世界')}\r\n\r\ndata: [DONE]`);
  const records = [];
  for await (const record of readSSE(response.body)) records.push(record);
  assert.deepEqual(records, [packet('你好'), packet('世界'), '[DONE]']);
});

test('sends authenticated request from provider layer and streams text only', async () => {
  let sent;
  const deltas = [];
  const response = await translate(settings, request, { onDelta: delta => deltas.push(delta), fetchImpl: async (url, options) => {
    sent = { url, options };
    return streamResponse(`data: ${packet('你')}\n\ndata: ${packet('好')}\n\ndata: [DONE]\n\n`);
  } });
  assert.equal(response.text, '你好');
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(sent.url, 'https://example.com/v1/chat/completions');
  assert.equal(sent.options.headers.Authorization, 'Bearer not-real');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(JSON.parse(sent.options.body).stream, true);
});

test('accepts compatible non-stream JSON responses', async () => {
  const value = await translate(settings, request, { fetchImpl: async () => Response.json({ choices: [{ message: { content: '你好' } }] }) });
  assert.equal(value.text, '你好');
});

test('indicates output length limits instead of claiming completeness', async () => {
  const response = streamResponse(`data: ${packet('部分')}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`);
  const value = await translate(settings, request, { fetchImpl: async () => response });
  assert.match(value.warning, /可能不完整/);
});

test('configuration is required before any network request', async () => {
  let called = false;
  await assert.rejects(translate({ ...settings, apiKey: '' }, request, { fetchImpl: async () => { called = true; } }), /API Key/);
  assert.equal(called, false);
});

test('HTTP errors are actionable and do not echo provider secrets', async () => {
  await assert.rejects(translate(settings, request, { fetchImpl: async () => new Response('secret echo', { status: 401 }) }), /API Key 无效/);
  await assert.rejects(translate(settings, request, { fetchImpl: async () => new Response('', { status: 429 }) }), /额度不足/);
});

test('rejects empty, malformed, or explicit error streams', async () => {
  await assert.rejects(translate(settings, request, { fetchImpl: async () => streamResponse('data: [DONE]\n\n') }), /未返回译文/);
  await assert.rejects(translate(settings, request, { fetchImpl: async () => streamResponse('data: bad-json\n\n') }), /无效/);
  await assert.rejects(translate(settings, request, { fetchImpl: async () => streamResponse('data: {"error":{"message":"nope"}}\n\n') }), /返回了错误/);
});

test('supports cancellation and applies a timeout to the whole request', async () => {
  const blockedFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const controller = new AbortController();
  const pending = translate(settings, request, { signal: controller.signal, fetchImpl: blockedFetch });
  controller.abort();
  await assert.rejects(pending, /已停止/);
  await assert.rejects(translate(settings, request, { fetchImpl: blockedFetch, timeoutMs: 15 }), /超时/);
});


test('premature stream termination is not reported as a successful translation', async () => {
  await assert.rejects(translate(settings, request, { fetchImpl: async () => streamResponse(`data: ${packet('部分译文')}\n\n`) }), /连接提前结束/);
});


test('forwards attitude and strength as system instructions without changing the source', async () => {
  let payload;
  const value = await translate(settings, { ...request, text: '我今天做不完。', tone: 'flattering', toneStrength: 'strong' }, {
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'Local fixture only.' } }] });
    },
  });
  assert.equal(value.text, 'Local fixture only.');
  assert.match(payload.messages[0].content, /表达态度：讨好/);
  assert.match(payload.messages[0].content, /态度力度：拉满/);
  assert.match(payload.messages[0].content, /事实、立场、承诺/);
  assert.deepEqual(JSON.parse(payload.messages[1].content), { source: '我今天做不完。' });
});
