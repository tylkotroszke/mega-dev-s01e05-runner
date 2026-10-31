import {pathToFileURL} from 'node:url';
import {createGeminiClient} from './gemini.mjs';
import {processJob} from './orchestrate.mjs';
import {boundedText} from './protocol.mjs';
import {runRedTest} from './sandbox.mjs';

export async function runAgent({env=process.env,fetchImpl=fetch,measure=runRedTest}={}) {
  if (env.LIVE_EXECUTION_ENABLED !== 'true') throw new Error('execution disabled');
  const jobId=env.JOB_ID,runnerId=env.RUNNER_ID;
  if (!/^[a-f0-9-]{36}$/.test(jobId ?? '') || !/^[A-Za-z0-9_-]{1,100}$/.test(runnerId ?? '')) throw new Error('invalid job identity');
  const origin=new URL(env.AGENT_ORIGIN);
  if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.hash || origin.search) throw new Error('invalid agent origin');
  if (typeof env.RUNNER_SHARED_KEY!=='string' || env.RUNNER_SHARED_KEY.length<32) throw new Error('runner key unavailable');
  const generate=createGeminiClient({apiKey:env.GEMINI_API_KEY,models:{pulse:env.PULSE_MODEL,test:env.TEST_MODEL},fetchImpl,maxCalls:1,timeoutMs:60000});
  const url=`${origin.origin}/internal/jobs/${jobId}`;
  const headers={authorization:`Bearer ${env.RUNNER_SHARED_KEY}`,'x-runner-id':runnerId};
  const response=await fetchImpl(url,{method:'GET',redirect:'error',headers,signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('job lease unavailable');
  const job=JSON.parse(await boundedText(response,1048576));
  if (job.id!==jobId) throw new Error('job identity mismatch');
  try {
    const answer=await processJob(job,{generate,fetchImpl,runRedTest:(options)=>measure({...options,image:'signed-test-toolchain:local'})});
    const result=await fetchImpl(url+'/result',{method:'POST',redirect:'error',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(answer),signal:AbortSignal.timeout(30000)});
    if (!result.ok) throw new Error('result outcome requires owner review');
    return {completed:true,kind:job.ping.kind};
  } catch {
    // A failed or uncertain result is not resent. This only records controller failure.
    try { await fetchImpl(url+'/failed',{method:'POST',redirect:'error',headers,signal:AbortSignal.timeout(10000)}); } catch { /* preserve the original failed outcome */ }
    throw new Error('agent stopped; inspect redacted job state');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result=await runAgent(); console.log(`agent completed: ${result.kind}`); }
  catch { console.error('Agent stopped. No automatic retry. Inspect the redacted job state.'); process.exitCode=1; }
}
