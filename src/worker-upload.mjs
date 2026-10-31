// s01e05-private/publication-candidate-v5/src/store.mjs
var Inbox = class {
  constructor(db) {
    this.db = db;
  }
  async reserve({ id, webhookId, bodyHash, payload, now, maxJobs }) {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO jobs(id,webhook_id,body_hash,payload,state,created)
      SELECT ?,?,?,?,'dispatching',? WHERE
      (SELECT COUNT(*) FROM jobs WHERE created >= ?) < ? RETURNING id`).bind(id, webhookId, bodyHash, JSON.stringify(payload), now, Math.floor(now / 864e5) * 864e5, maxJobs).first();
    if (result) return { created: true, id };
    const existing = await this.db.prepare("SELECT id,body_hash,state FROM jobs WHERE webhook_id = ?").bind(webhookId).first();
    if (!existing) return { budgetExceeded: true };
    return { created: false, id: existing.id, conflict: existing.body_hash !== bodyHash, state: existing.state };
  }
  async markDispatch(id, state) {
    await this.db.prepare("UPDATE jobs SET state=? WHERE id=? AND state='dispatching'").bind(state, id).run();
  }
  async lease(id, runner, now) {
    return this.db.prepare(`UPDATE jobs SET state='leased',runner_id=? WHERE id=?
      AND state IN ('dispatching','dispatched') AND created >= ? RETURNING id,payload`).bind(runner, id, now - 15 * 6e4).first();
  }
  async context() {
    const row = await this.db.prepare("SELECT content FROM documents WHERE name='context'").first();
    if (!row) throw new Error("private context not configured");
    return JSON.parse(row.content);
  }
  async get(id) {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first();
  }
  async sending(id, runner, answer) {
    return this.db.prepare("UPDATE jobs SET state='sending',answer=? WHERE id=? AND runner_id=? AND state='leased' RETURNING id").bind(JSON.stringify(answer), id, runner).first();
  }
  async finish(id, state, status = null) {
    await this.db.prepare("UPDATE jobs SET state=?,reply_status=?,payload=NULL,answer=NULL WHERE id=?").bind(state, status, id).run();
  }
};

// s01e05-private/publication-candidate-v5/src/protocol.mjs
var encoder = new TextEncoder();
var MAX_PING_BYTES = 262144;
var MAX_REPLY_BYTES = 19999;
function courseURL(value, origin) {
  const base = new URL(origin);
  const url = new URL(value);
  if (base.protocol !== "https:" || url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password || url.hash || /[\u0000-\u0020\\]/u.test(value)) {
    throw new Error("invalid course URL");
  }
  return url;
}
function replyURL(value, origin) {
  const url = courseURL(value, origin);
  let path = url.pathname;
  for (let i = 0; i < 4 && path.includes("%"); i++) path = decodeURIComponent(path);
  if (path.includes("%") || /[\\?#\u0000-\u0020]/u.test(path)) throw new Error("ambiguous reply route");
  const normalized = new URL(path, url.origin);
  if (normalized.origin !== url.origin || /^\/rig\/tracker(?:[;/]|$)/.test(normalized.pathname) || /^\/(?:mcp|challenges)(?:[;/]|$)/.test(normalized.pathname)) {
    throw new Error("reply cannot mutate tracker or challenge");
  }
  return url.href;
}
function validatePing(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ping");
  const reply = replyURL(value.reply, origin);
  if (value.kind === "pulse") {
    const tracker = courseURL(value.tracker, origin);
    if (tracker.pathname !== "/rig/tracker/issues" || tracker.search) throw new Error("invalid tracker");
    if (value.phrase !== void 0 && (typeof value.phrase !== "string" || value.phrase.length > 500)) throw new Error("invalid phrase");
    return { kind: "pulse", text: typeof value.text === "string" ? value.text.slice(0, 1e3) : "", phrase: value.phrase ?? "", tracker: tracker.href, reply };
  }
  if (value.kind !== "test" || !Number.isSafeInteger(value.issue) || value.issue < 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw new Error("invalid test ping");
  const entries = Object.entries(value.files);
  if (!entries.length || entries.length > 100 || entries.some(([path, text]) => typeof text !== "string" || !/^(?:src|test|runs)\/[A-Za-z0-9_./-]+\.(?:tsx?|jsonl?)$/.test(path) || path.split("/").some((p) => p === "." || p === ".." || !p) || path.includes("node_modules"))) throw new Error("invalid files");
  return { kind: "test", issue: value.issue, files: Object.fromEntries(entries), reply };
}
function bytes64(text) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("invalid base64");
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
async function verifyWebhook(headers, body, secret, now = Date.now()) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || id.length > 200 || /\s/.test(id) || !/^\d{1,12}$/.test(timestamp ?? "") || !signatures) return false;
  if (Math.abs(now / 1e3 - Number(timestamp)) > 300 || !secret?.startsWith("whsec_")) return false;
  try {
    const key = await crypto.subtle.importKey("raw", bytes64(secret.slice(6)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    for (const signature of signatures.split(" ").slice(0, 8)) {
      if (!signature.startsWith("v1,")) continue;
      try {
        if (await crypto.subtle.verify("HMAC", key, bytes64(signature.slice(3)), encoder.encode(`${id}.${timestamp}.${body}`))) return true;
      } catch {
      }
    }
    return false;
  } catch {
    return false;
  }
}
async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}
function equalSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length < 32) return false;
  const a = encoder.encode(given), b = encoder.encode(expected);
  let different = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) different |= (a[i] ?? 0) ^ b[i];
  return different === 0;
}
async function boundedText(request, maxBytes) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new Error("body too large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (; ; ) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}
function validateAnswer(ping, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid answer");
  if (ping.kind === "pulse") {
    if (Object.keys(value).join() !== "text" || typeof value.text !== "string" || !value.text.trim() || value.text.length > 2e3) throw new Error("invalid pulse answer");
    if (!/^pulse stopped: [^\r\n]+$/.test(value.text) && !value.text.includes(JSON.stringify(ping.phrase))) throw new Error("phrase missing");
  } else {
    if (Object.keys(value).sort().join() !== "path,red,test" || !/^test\/[A-Za-z0-9_-]+\.test\.ts$/.test(value.path ?? "") || typeof value.test !== "string" || !value.test.trim() || typeof value.red !== "string" || !value.red.trim() || /[\r\n]/.test(value.red)) throw new Error("invalid test answer");
  }
  if (encoder.encode(JSON.stringify(value)).length > MAX_REPLY_BYTES) throw new Error("reply too large");
  return value;
}

// s01e05-private/publication-candidate-v5/src/worker.mjs
var json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
var jobPath = /^\/internal\/jobs\/([a-f0-9-]{36})(\/(?:result|failed))?$/;
function createWorker({ fetchImpl = fetch, now = Date.now, uuid = () => crypto.randomUUID() } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/mega-pulse.json") {
        if (!env.OWNER_CODE) return json({ error: "not configured" }, 503);
        return json({ owner: env.OWNER_CODE, agents: { pulse: { wakes: "pulse", may: ["answer"] }, "test-writer": { wakes: "test", may: ["test"] } } });
      }
      if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, enabled: env.AUTONOMOUS_REPLIES_ENABLED === "true" });
      if (env.AUTONOMOUS_REPLIES_ENABLED !== "true") return json({ error: "awaiting owner authorization" }, 503);
      if (!env.INBOX || !env.COURSE_ORIGIN) return json({ error: "not configured" }, 503);
      if (typeof env.RUNNER_SHARED_KEY !== "string" || env.RUNNER_SHARED_KEY.length < 32 || typeof env.GITHUB_ACTIONS_TOKEN !== "string" || env.GITHUB_ACTIONS_TOKEN.length < 8 || /[\r\n]/.test(env.GITHUB_ACTIONS_TOKEN)) return json({ error: "secrets not configured" }, 503);
      const inbox = new Inbox(env.INBOX);
      const internal = jobPath.exec(url.pathname);
      if (internal) {
        if (!equalSecret(request.headers.get("authorization")?.replace(/^Bearer /, ""), env.RUNNER_SHARED_KEY)) return json({ error: "unauthorized" }, 401);
        const runner = request.headers.get("x-runner-id");
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(runner ?? "")) return json({ error: "invalid runner" }, 400);
        if (request.method === "GET" && !internal[2]) {
          let context;
          try {
            context = await inbox.context();
          } catch {
            return json({ error: "context unavailable" }, 503);
          }
          const leased = await inbox.lease(internal[1], runner, now());
          if (!leased) return json({ error: "already leased or expired" }, 409);
          const ping2 = JSON.parse(leased.payload);
          const { reply, ...safePing } = ping2;
          const scopedContext = ping2.kind === "pulse" ? { plan: context.plan, history: context.history } : context;
          return json({ id: leased.id, ping: safePing, context: scopedContext, courseOrigin: env.COURSE_ORIGIN });
        }
        if (request.method === "POST" && internal[2] === "/failed") {
          const job = await inbox.get(internal[1]);
          if (!job || job.runner_id !== runner || job.state !== "leased") return json({ error: "not leased" }, 409);
          await inbox.finish(job.id, "runner_failed");
          return json({ state: "stopped" });
        }
        if (request.method === "POST" && internal[2] === "/result") {
          const job = await inbox.get(internal[1]);
          if (!job || job.runner_id !== runner || job.state !== "leased") return json({ error: "not leased" }, 409);
          let answer, ping2;
          try {
            ping2 = JSON.parse(job.payload);
            answer = validateAnswer(ping2, JSON.parse(await boundedText(request, MAX_REPLY_BYTES)));
          } catch {
            return json({ error: "invalid result" }, 400);
          }
          if (!await inbox.sending(job.id, runner, answer)) return json({ error: "already sent" }, 409);
          let response;
          try {
            response = await fetchImpl(ping2.reply, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(answer), signal: AbortSignal.timeout(15e3) });
          } catch {
            await inbox.finish(job.id, "reply_uncertain");
            return json({ error: "reply outcome uncertain; owner review needed" }, 502);
          }
          const accepted = response.status === 202 || response.status === 409;
          await inbox.finish(job.id, accepted ? "answered" : "reply_rejected", response.status);
          return json({ state: accepted ? "received" : "rejected", replyStatus: response.status }, accepted ? 200 : 502);
        }
        return json({ error: "method not allowed" }, 405);
      }
      if (request.method !== "POST" || url.pathname !== "/") return json({ error: "not found" }, 404);
      let raw, ping;
      try {
        raw = await boundedText(request, MAX_PING_BYTES);
      } catch {
        return json({ error: "invalid body" }, 413);
      }
      if (!await verifyWebhook(request.headers, raw, env.PING_KEY, now())) return json({ error: "invalid signature" }, 401);
      try {
        ping = validatePing(JSON.parse(raw), env.COURSE_ORIGIN);
      } catch {
        return json({ error: "invalid ping" }, 400);
      }
      const maxJobs = Number(env.MAX_JOBS_PER_DAY ?? 6);
      if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10) return json({ error: "invalid budget" }, 503);
      try {
        await inbox.context();
      } catch {
        return json({ error: "context unavailable" }, 503);
      }
      const reserved = await inbox.reserve({ id: uuid(), webhookId: request.headers.get("webhook-id"), bodyHash: await hash(raw), payload: ping, now: now(), maxJobs });
      if (reserved.budgetExceeded) return json({ error: "daily budget exhausted" }, 429);
      if (reserved.conflict) return json({ error: "webhook ID reused with different body" }, 409);
      if (!reserved.created) return json({ accepted: true, duplicate: true }, 202);
      const owner = env.RUNNER_OWNER, repo = env.RUNNER_REPOSITORY, workflow = env.RUNNER_WORKFLOW, ref = env.RUNNER_REF;
      if (![owner, repo, workflow, ref].every((x) => typeof x === "string" && /^[A-Za-z0-9_.-]+$/.test(x))) {
        await inbox.markDispatch(reserved.id, "dispatch_failed");
        return json({ error: "invalid runner configuration" }, 503);
      }
      try {
        const dispatched = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
          method: "POST",
          redirect: "error",
          headers: { "authorization": `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, "accept": "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2026-03-10", "user-agent": "signed-agent-runtime" },
          // Public inputs contain only a random ID, never a secret or private course material.
          body: JSON.stringify({ ref, inputs: { job_id: reserved.id } }),
          signal: AbortSignal.timeout(12e3)
        });
        if (![200, 204].includes(dispatched.status)) {
          await inbox.markDispatch(reserved.id, "dispatch_failed");
          return json({ error: "dispatch rejected" }, 502);
        }
        await inbox.markDispatch(reserved.id, "dispatched");
        return json({ accepted: true }, 202);
      } catch {
        await inbox.markDispatch(reserved.id, "dispatch_uncertain");
        return json({ error: "dispatch outcome uncertain; owner review needed" }, 502);
      }
    }
  };
}
var worker_default = createWorker();
export {
  createWorker,
  worker_default as default
};
