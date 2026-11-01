import {diagnosticError, preserveDiagnostic} from './diagnostics.mjs';
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const encoder = new TextEncoder();
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function responseText(response, maximum) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum)) throw new Error('invalid response');
  if (!response.body) throw new Error('invalid response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error('invalid response');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

/** Native generateContent adapter. No tools, retries, provider switching or paid-tier selection. */
export function createGeminiClient({ apiKey, models, fetchImpl = fetch, timeoutMs = 45_000, maxCalls = 2 } = {}) {
  const timeouts = typeof timeoutMs === 'number' ? {pulse: timeoutMs, test: timeoutMs} : timeoutMs;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 1_000 || /[\r\n]/.test(apiKey) ||
      !record(models) || !['pulse', 'test'].every((kind) => /^[a-z0-9][a-z0-9._-]{1,100}$/.test(models[kind] ?? '')) ||
      !record(timeouts) || !['pulse', 'test'].every(kind => Number.isSafeInteger(timeouts[kind]) && timeouts[kind] >= 1 && timeouts[kind] <= 300_000) ||
      !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 6 || typeof fetchImpl !== 'function') {
    throw new Error('invalid model configuration');
  }
  const configuredModels = { pulse: models.pulse, test: models.test };
  const configuredTimeouts = {pulse: timeouts.pulse, test: timeouts.test};
  let calls = 0;
  return async function generate({ kind, system, data } = {}) {
    if (!['pulse', 'test'].includes(kind) || typeof system !== 'string' || !system.trim() || system.length > 40_000 || !record(data)) {
      throw new Error('invalid generation input');
    }
    let body;
    try {
      body = JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ untrustedEvidence: data }) }] }],
        generationConfig: {
          candidateCount: 1, responseMimeType: 'application/json', temperature: 0,
          maxOutputTokens: kind === 'test' ? 8_192 : 512,
        },
      });
      if (encoder.encode(body).byteLength > 300_000) throw new Error('input too large');
    } catch { throw new Error('invalid generation input'); }
    if (calls >= maxCalls) throw new Error('model call budget exhausted');
    // Reserve before the request: timeouts and quota errors do not grant a free retry.
    calls++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), configuredTimeouts[kind]);
    let phase = 'transport';
    try {
      const response = await fetchImpl(API_ROOT + configuredModels[kind] + ':generateContent', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body,
      });
      if (!response.ok) throw diagnosticError('model generation failed', 'model_http_error', {httpStatus: response.status});
      phase = 'response';
      const result = JSON.parse(await responseText(response, 128_000));
      if (record(result) && result.promptFeedback?.blockReason) throw diagnosticError('model generation failed', 'model_blocked');
      if (!record(result) || !Array.isArray(result.candidates) || result.candidates.length !== 1) {
        throw new Error('invalid generation response');
      }
      const candidate = result.candidates[0];
      if (record(candidate) && candidate.finishReason !== 'STOP') throw diagnosticError('model generation failed', 'model_incomplete', {finishReason: candidate.finishReason});
      if (!record(candidate) || !Array.isArray(candidate.content?.parts) || !candidate.content.parts.length ||
          candidate.content.parts.some((part) => !record(part) || typeof part.text !== 'string')) {
        throw new Error('invalid generation response');
      }
      const answerText = candidate.content.parts.filter((part) => part.thought !== true).map((part) => part.text).join('');
      if (encoder.encode(answerText).byteLength > 32_000) throw new Error('invalid generation response');
      const answer = JSON.parse(answerText);
      if (!record(answer)) throw new Error('invalid generation response');
      return answer;
    } catch (error) {
      // Provider bodies/errors may echo request data; expose only this fixed message.
      if (controller.signal.aborted) throw diagnosticError('model generation failed', 'model_timeout');
      throw preserveDiagnostic(error, 'model generation failed', phase === 'transport' ? 'model_transport_error' : 'model_invalid_response');
    } finally { clearTimeout(timer); }
  };
}
