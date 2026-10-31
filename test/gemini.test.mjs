import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient } from '../src/gemini.mjs';

const config = { apiKey: 'test-only-model-key', models: { pulse: 'model-small', test: 'model-code' } };
const input = { kind: 'pulse', system: 'Return JSON.', data: { topic: 'a batch' } };
const success = (answer = { issue: 7, recommendation: 'Check the batch count.' }) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer) }] } }] });

test('uses one configured Google model with header key, JSON boundary and no tools', async () => {
  let call;
  const generate = createGeminiClient({ ...config, fetchImpl: async (url, options) => { call = { url, options }; return success(); } });
  const result = await generate(input);
  assert.equal(result.issue, 7);
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/model-small:generateContent');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers['x-goog-api-key'], config.apiKey);
  assert.equal(call.options.body.includes(config.apiKey), false);
  const body = JSON.parse(call.options.body);
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), { untrustedEvidence: input.data });
  assert.equal(body.systemInstruction.parts[0].text, input.system);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.maxOutputTokens, 512);
  assert.equal(Object.hasOwn(body, 'tools'), false);
  assert.equal(Object.hasOwn(body, 'serviceTier'), false);
});

test('test role uses only its configured model, not a model chosen from input', async () => {
  let call;
  const generate = createGeminiClient({ ...config, fetchImpl: async (url, options) => { call = { url, options }; return success({ path: 'test/example.test.ts', test: 'source' }); } });
  await generate({ ...input, kind: 'test', model: 'https://evil.example' });
  assert.equal(call.url.endsWith('/model-code:generateContent'), true);
  assert.equal(JSON.parse(call.options.body).generationConfig.maxOutputTokens, 8_192);
});

test('rejects injected configuration and invalid input before network use', async () => {
  for (const model of ['../model', 'https://evil.example', 'model?key=bad', 'model:method']) {
    assert.throws(() => createGeminiClient({ ...config, models: { pulse: model, test: 'safe-model' } }), /invalid model configuration/);
  }
  let calls = 0;
  const generate = createGeminiClient({ ...config, fetchImpl: async () => { calls++; return success(); } });
  await assert.rejects(generate({ ...input, kind: 'other' }), /invalid generation input/);
  await assert.rejects(generate({ ...input, data: { large: 'x'.repeat(300_001) } }), /invalid generation input/);
  assert.equal(calls, 0);
});

test('quota and remote errors produce no retry, fallback or echoed credential', async () => {
  let calls = 0;
  const generate = createGeminiClient({ ...config, maxCalls: 1, fetchImpl: async () => { calls++; return new Response('provider echoed ' + config.apiKey, { status: 429 }); } });
  await assert.rejects(generate(input), (error) => error.message === 'model generation failed' && !error.message.includes(config.apiKey));
  await assert.rejects(generate(input), /budget exhausted/);
  assert.equal(calls, 1);
});

test('rejects truncated, blocked, malformed or excessive model output', async () => {
  const responses = [
    Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"ok":true}' }] } }] }),
    Response.json({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }),
    Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'arbitrary' } }] } }] }),
    Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n{}\n```' }] } }] }),
    new Response('x'.repeat(128_001)),
  ];
  for (const response of responses) {
    const generate = createGeminiClient({ ...config, fetchImpl: async () => response });
    await assert.rejects(generate(input), /model generation failed/);
  }
});

test('timeout is bounded and its nested transport error is not exposed', async () => {
  let calls = 0;
  const generate = createGeminiClient({ ...config, timeoutMs: 5, fetchImpl: async (_url, options) => {
    calls++;
    await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('transport ' + config.apiKey))); });
    return success();
  } });
  await assert.rejects(generate(input), (error) => error.message === 'model generation failed');
  assert.equal(calls, 1);
});
