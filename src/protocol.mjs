const encoder = new TextEncoder();
export const MAX_PING_BYTES = 2_000_000;
export const MAX_REPLY_BYTES = 20_000;
export const MEASURED_RED = "Vitest reported a failing behavioral assertion in the new test on the unchanged base (exit 1).";
export function isTestPath(path) {
  return typeof path === "string" && path.startsWith("test/") && path.endsWith(".test.ts") && !/[\\\u0000]/.test(path) && path.split("/").every(part => part && part !== "." && part !== "..");
}
export function importsSource(source) { return /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:\.\.\/)+src\//.test(source); }
export function artifactFits(path,test) { return encoder.encode(JSON.stringify({path,test,red:MEASURED_RED})).length <= MAX_REPLY_BYTES; }

export function courseURL(value, origin) {
  const base = new URL(origin);
  const url = new URL(value);
  if (base.protocol !== 'https:' || url.protocol !== 'https:' || url.origin !== base.origin ||
      url.username || url.password || url.hash || /[\u0000-\u0020\\]/u.test(value)) {
    throw new Error('invalid course URL');
  }
  return url;
}

export function replyURL(value, origin) {
  const url = courseURL(value, origin);
  let path=url.pathname;
  for (let i=0;i<4 && path.includes('%');i++) path=decodeURIComponent(path);
  if (path.includes('%') || /[\\?#\u0000-\u0020]/u.test(path)) throw new Error('ambiguous reply route');
  const normalized=new URL(path,url.origin);
  if (normalized.origin!==url.origin || /^\/rig\/tracker(?:[;/]|$)/.test(normalized.pathname) || /^\/(?:mcp|challenges)(?:[;/]|$)/.test(normalized.pathname)) {
    throw new Error('reply cannot mutate tracker or challenge');
  }
  return url.href;
}

export function validatePing(value, origin) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid ping');
  const reply = replyURL(value.reply, origin);
  if (value.kind === 'pulse') {
    const tracker = value.tracker ? courseURL(value.tracker, origin) : null;
    if (tracker && (tracker.pathname !== '/rig/tracker/issues' || tracker.search)) throw new Error('invalid tracker');
    // Missing phrase/tracker are course stop conditions, not silent ingress failures.
    if (value.phrase !== undefined && typeof value.phrase !== 'string') throw new Error('invalid phrase');
    return { kind: 'pulse', text: typeof value.text === 'string' ? value.text : '', phrase: value.phrase ?? '', tracker: tracker?.href ?? '', reply };
  }
  if (value.kind !== 'test' || !Number.isSafeInteger(value.issue) || value.issue < 1 ||
      !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('invalid test ping');
  const entries = Object.entries(value.files);
  if (!entries.length || entries.some(([path,text]) =>
    typeof text !== 'string' || !/^(?:src|test|runs)\/[^\\\u0000]+$/.test(path) ||
    path.split('/').some(p => p === '.' || p === '..' || !p) || path.includes('node_modules'))) throw new Error('invalid files');
  return {kind:'test', issue:value.issue, files:Object.fromEntries(entries), reply};
}

function bytes64(text) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('invalid base64');
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export async function verifyWebhook(headers, body, secret, now = Date.now()) {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || id.length > 200 || /\s/.test(id) || !/^\d{1,12}$/.test(timestamp ?? '') || !signatures) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300 || !secret?.startsWith('whsec_')) return false;
  try {
    const key = await crypto.subtle.importKey('raw', bytes64(secret.slice(6)), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    for (const signature of signatures.split(' ').slice(0, 8)) {
      if (!signature.startsWith('v1,')) continue;
      try {
        if (await crypto.subtle.verify('HMAC', key, bytes64(signature.slice(3)), encoder.encode(`${id}.${timestamp}.${body}`))) return true;
      } catch { /* another rotation signature can still be valid */ }
    }
    return false;
  } catch { return false; }
}

export async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2,'0')).join('');
}

export function equalSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const a = encoder.encode(given), b = encoder.encode(expected);
  let different = a.length ^ b.length;
  for (let i=0; i<b.length; i++) different |= (a[i] ?? 0) ^ b[i];
  return different === 0;
}

export async function boundedText(request, maxBytes) {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new Error('body too large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size=0;
  for (;;) {
    const {value,done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('body too large'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset=0;
  for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8',{fatal:true}).decode(result);
}

export function validateAnswer(ping, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid answer');
  if (ping.kind === 'pulse') {
    if (Object.keys(value).join() !== 'text' || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000) throw new Error('invalid pulse answer');
    if (!/^pulse stopped: [^\r\n]+$/.test(value.text) && !value.text.includes(JSON.stringify(ping.phrase))) throw new Error('phrase missing');
  } else {
    if (Object.keys(value).sort().join() !== 'path,red,test' || !isTestPath(value.path) ||
        typeof value.test !== 'string' || !value.test.trim() || typeof value.red !== 'string' || !value.red.trim() || /[\r\n]/.test(value.red)) throw new Error('invalid test answer');
  }
  if (encoder.encode(JSON.stringify(value)).length > MAX_REPLY_BYTES) throw new Error('reply too large');
  return value;
}
