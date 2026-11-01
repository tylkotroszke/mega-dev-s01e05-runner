import {pathToFileURL} from 'node:url';
import {createGeminiClient} from './gemini.mjs';
import {processJob} from './orchestrate.mjs';
import {boundedText} from './protocol.mjs';
import {runRedTest} from './sandbox.mjs';
import {diagnosticDetails} from './diagnostics.mjs';
import {pulseOutcome} from './agents.mjs';

// Writer responses have exceeded 60s in observed provider metrics. Allow one
// response up to the owner's chosen 5min within a 10min workflow; no retry or extra call.
export const MODEL_TIMEOUTS = Object.freeze({pulse:300_000,test:300_000});
const STAGES = new Set(['processing','tracker','pulse_generation','test_selection','test_generation','sandbox','answer_validation','result']);

export async function runAgent({env=process.env,fetchImpl=fetch,measure=runRedTest,report=()=>{}}={}) {
  if (env.LIVE_EXECUTION_ENABLED !== 'true') throw new Error('execution disabled');
  const jobId=env.JOB_ID,runnerId=env.RUNNER_ID;
  if (!/^[a-f0-9-]{36}$/.test(jobId ?? '') || !/^[A-Za-z0-9_-]{1,100}$/.test(runnerId ?? '')) throw new Error('invalid job identity');
  const origin=new URL(env.AGENT_ORIGIN);
  if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.hash || origin.search) throw new Error('invalid agent origin');
  if (typeof env.RUNNER_SHARED_KEY!=='string' || env.RUNNER_SHARED_KEY.length<32) throw new Error('runner key unavailable');
  const generate=createGeminiClient({apiKey:env.GEMINI_API_KEY,models:{pulse:env.PULSE_MODEL,test:env.TEST_MODEL},fetchImpl,timeoutMs:MODEL_TIMEOUTS,report:entry=>{try{report(entry);}catch{}}});
  const url=`${origin.origin}/internal/jobs/${jobId}`;
  const headers={authorization:`Bearer ${env.RUNNER_SHARED_KEY}`,'x-runner-id':runnerId};
  const response=await fetchImpl(url,{method:'GET',redirect:'error',headers,signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('job lease unavailable');
  const job=await response.json();
  if (job.id!==jobId) throw new Error('job identity mismatch');
  let stage='processing',started=performance.now();
  const emit=(entry)=>{try {report(entry);} catch { /* diagnostics cannot change the job outcome */ }};
  const elapsed=()=>Math.max(0,Math.round(performance.now()-started));
  const onStage=(next)=>{
    if (!STAGES.has(next)) return;
    emit({event:'agent_stage',stage,elapsedMs:elapsed()});
    stage=next;started=performance.now();
    emit({event:'agent_stage',stage,state:'started'});
  };
  try {
    const answer=await processJob(job,{generate,fetchImpl,onStage,runRedTest:(options)=>measure({...options,image:'signed-test-toolchain:local'})});
    onStage('result');
    const result=await fetchImpl(url+'/result',{method:'POST',redirect:'error',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(answer),signal:AbortSignal.timeout(30000)});
    if (!result.ok) throw new Error('result outcome requires owner review');
    emit({event:'agent_stage',stage,elapsedMs:elapsed(),state:'completed'});
    const outcome=job.ping.kind==='pulse'?pulseOutcome(answer):{outcome:'test'};
    emit({event:'agent_outcome',kind:job.ping.kind,delivered:true,...outcome});
    return {completed:true,kind:job.ping.kind,...outcome};
  } catch (error) {
    const fallback=stage==='sandbox'?'sandbox_failed':stage==='result'?'result_failed':'processing_failed';
    emit({event:'agent_failure',stage,elapsedMs:elapsed(),...diagnosticDetails(error,fallback)});
    // A failed or uncertain result is not resent. This only records controller failure.
    try { await fetchImpl(url+'/failed',{method:'POST',redirect:'error',headers,signal:AbortSignal.timeout(10000)}); } catch { /* preserve the original failed outcome */ }
    throw new Error('agent stopped; inspect redacted job state');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result=await runAgent({report:entry=>console.log(JSON.stringify(entry))}); console.log(result.outcome==='stopped'?'agent delivered stopped: '+result.code:`agent completed: ${result.kind}`); }
  catch { console.error('Agent stopped. No automatic retry. Inspect the redacted job state.'); process.exitCode=1; }
}
