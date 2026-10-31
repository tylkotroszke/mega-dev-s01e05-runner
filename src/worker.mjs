import {Inbox} from './store.mjs';
import {MAX_PING_BYTES,MAX_REPLY_BYTES,boundedText,equalSecret,hash,validatePing,validateAnswer,verifyWebhook} from './protocol.mjs';

const json = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store'}});
const jobPath = /^\/internal\/jobs\/([a-f0-9-]{36})(\/(?:result|failed))?$/;

export function createWorker({fetchImpl=fetch,now=Date.now,uuid=()=>crypto.randomUUID()}={}) {
  return {
    async fetch(request,env) {
      const url=new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/.well-known/mega-pulse.json') {
        if (!env.OWNER_CODE) return json({error:'not configured'},503);
        return json({owner:env.OWNER_CODE,agents:{pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}});
      }
      if (url.pathname === '/health' && request.method === 'GET') return json({ok:true,enabled:env.AUTONOMOUS_REPLIES_ENABLED==='true'});
      if (env.AUTONOMOUS_REPLIES_ENABLED !== 'true') return json({error:'awaiting owner authorization'},503);
      if (!env.INBOX || !env.COURSE_ORIGIN) return json({error:'not configured'},503);
      if (typeof env.RUNNER_SHARED_KEY!=='string' || env.RUNNER_SHARED_KEY.length<32 ||
          typeof env.GITHUB_ACTIONS_TOKEN!=='string' || env.GITHUB_ACTIONS_TOKEN.length<8 ||
          /[\r\n]/.test(env.GITHUB_ACTIONS_TOKEN)) return json({error:'secrets not configured'},503);
      const inbox=new Inbox(env.INBOX);
      const internal=jobPath.exec(url.pathname);
      if (internal) {
        if (!equalSecret(request.headers.get('authorization')?.replace(/^Bearer /,''),env.RUNNER_SHARED_KEY)) return json({error:'unauthorized'},401);
        const runner=request.headers.get('x-runner-id');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(runner ?? '')) return json({error:'invalid runner'},400);
        if (request.method === 'GET' && !internal[2]) {
          // Read context before taking the one-use lease: a configuration failure spends no model call.
          let context; try { context=await inbox.context(); } catch { return json({error:'context unavailable'},503); }
          const leased=await inbox.lease(internal[1],runner,now());
          if (!leased) return json({error:'already leased or expired'},409);
          const ping=JSON.parse(leased.payload);
          // Reply token stays in the inbox. Neither model nor execution runner needs it.
          const {reply,...safePing}=ping;
          const scopedContext=ping.kind==='pulse'?{plan:context.plan,history:context.history}:context;
          return json({id:leased.id,ping:safePing,context:scopedContext,courseOrigin:env.COURSE_ORIGIN});
        }
        if (request.method === 'POST' && internal[2] === '/failed') {
          const job=await inbox.get(internal[1]);
          if (!job || job.runner_id!==runner || job.state!=='leased') return json({error:'not leased'},409);
          await inbox.finish(job.id,'runner_failed');
          return json({state:'stopped'});
        }
        if (request.method === 'POST' && internal[2] === '/result') {
          const job=await inbox.get(internal[1]);
          if (!job || job.runner_id !== runner || job.state !== 'leased') return json({error:'not leased'},409);
          let answer,ping;
          try {
            ping=JSON.parse(job.payload);
            answer=validateAnswer(ping,JSON.parse(await boundedText(request,MAX_REPLY_BYTES)));
          } catch { return json({error:'invalid result'},400); }
          if (!await inbox.sending(job.id,runner,answer)) return json({error:'already sent'},409);
          let response;
          try {
            response=await fetchImpl(ping.reply,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(answer),signal:AbortSignal.timeout(15000)});
          } catch { await inbox.finish(job.id,'reply_uncertain'); return json({error:'reply outcome uncertain; owner review needed'},502); }
          const accepted=response.status===202 || response.status===409;
          await inbox.finish(job.id,accepted?'answered':'reply_rejected',response.status);
          return json({state:accepted?'received':'rejected',replyStatus:response.status},accepted?200:502);
        }
        return json({error:'method not allowed'},405);
      }
      if (request.method !== 'POST' || url.pathname !== '/') return json({error:'not found'},404);
      let raw,ping;
      try { raw=await boundedText(request,MAX_PING_BYTES); } catch { return json({error:'invalid body'},413); }
      if (!await verifyWebhook(request.headers,raw,env.PING_KEY,now())) return json({error:'invalid signature'},401);
      try { ping=validatePing(JSON.parse(raw),env.COURSE_ORIGIN); } catch { return json({error:'invalid ping'},400); }
      const maxJobs=Number(env.MAX_JOBS_PER_DAY ?? 6);
      if (!Number.isInteger(maxJobs) || maxJobs<1 || maxJobs>10) return json({error:'invalid budget'},503);
      // Context must be seeded privately before registering with the course.
      try { await inbox.context(); } catch { return json({error:'context unavailable'},503); }
      const reserved=await inbox.reserve({id:uuid(),webhookId:request.headers.get('webhook-id'),bodyHash:await hash(raw),payload:ping,now:now(),maxJobs});
      if (reserved.budgetExceeded) return json({error:'daily budget exhausted'},429);
      if (reserved.conflict) return json({error:'webhook ID reused with different body'},409);
      if (!reserved.created) return json({accepted:true,duplicate:true},202);
      const owner=env.RUNNER_OWNER, repo=env.RUNNER_REPOSITORY, workflow=env.RUNNER_WORKFLOW,ref=env.RUNNER_REF;
      if (![owner,repo,workflow,ref].every(x=>typeof x==='string' && /^[A-Za-z0-9_.-]+$/.test(x))) {
        await inbox.markDispatch(reserved.id,'dispatch_failed'); return json({error:'invalid runner configuration'},503);
      }
      try {
        const dispatched=await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,{
          method:'POST',redirect:'error',headers:{'authorization':`Bearer ${env.GITHUB_ACTIONS_TOKEN}`,'accept':'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2026-03-10','user-agent':'signed-agent-runtime'},
          // Public inputs contain only a random ID, never a secret or private course material.
          body:JSON.stringify({ref,inputs:{job_id:reserved.id}}),signal:AbortSignal.timeout(12000)});
        if (![200,204].includes(dispatched.status)) { await inbox.markDispatch(reserved.id,'dispatch_failed'); return json({error:'dispatch rejected'},502); }
        await inbox.markDispatch(reserved.id,'dispatched');
        return json({accepted:true},202);
      } catch {
        await inbox.markDispatch(reserved.id,'dispatch_uncertain');
        return json({error:'dispatch outcome uncertain; owner review needed'},502);
      }
    }
  };
}
export default createWorker();
