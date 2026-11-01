import {pathToFileURL} from 'node:url';
import {boundedText} from './protocol.mjs';
import {PROBE_ID,PROBE_REF,PROBE_PATH} from './connection-probe.mjs';

export async function checkConnection({env=process.env,fetchImpl=fetch,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(env.CONNECTION_CHECK_APPROVED!=='true'||env.GITHUB_REF!=='refs/tags/'+PROBE_REF||env.LIVE_EXECUTION_ENABLED!=='false'||
    env.AGENT_ORIGIN!=='https://mega-s01e05.sawczuk-mateusz.workers.dev'||!['start','receive'].includes(env.PROBE_MODE)||
    env.PROBE_JOB_ID!==PROBE_ID||typeof env.RUNNER_SHARED_KEY!=='string'||env.RUNNER_SHARED_KEY.length<32||
    !/^[A-Za-z0-9_-]{1,100}$/.test(env.PROBE_RUNNER_ID??''))throw Error('Connection check gate is closed');
 const call=async(path,body)=>{
  let response;
  try{response=await fetchImpl(env.AGENT_ORIGIN+PROBE_PATH+path,{method:body?'POST':'GET',redirect:'error',
   headers:{authorization:`Bearer ${env.RUNNER_SHARED_KEY}`,'x-runner-id':env.PROBE_RUNNER_ID,...(body?{'content-type':'application/json'}:{})},
   body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});}
  catch{throw Error('Connection check transport failed; no automatic resend');}
  if(!response.ok)throw Error(`Connection check HTTP ${response.status}; no automatic resend`);
  const data=JSON.parse(await boundedText(response,4096));
  if(data.probeId!==PROBE_ID)throw Error('Probe identity differs');
  return data;
 };
 if(env.PROBE_MODE==='receive'){
  const leased=await call('/lease',{probeId:PROBE_ID});
  if(leased.diagnostic!==true)throw Error('Probe lease differs');
  const completed=await call('/result',{probeId:PROBE_ID,ok:true});
  if(completed.completed!==true)throw Error('Probe result differs');
  return {completed:true,phase:'receive',modelCalls:0};
 }
 const initial=await call('',{probeId:PROBE_ID});
 if(initial.accepted!==true)throw Error('Probe dispatch not accepted');
 for(let attempt=0;attempt<18;attempt++){
  const status=await call('');
  if(status.state==='probe_completed'&&/^[0-9]+-[0-9]+$/.test(status.runnerId??''))return {completed:true,phase:'start',receiverRun:status.runnerId,modelCalls:0};
  if(['probe_failed','probe_uncertain'].includes(status.state))throw Error('Probe dispatch failed; no automatic resend');
  await delay(5000);
 }
 throw Error('Probe receiver not confirmed within 90 seconds; no automatic resend');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await checkConnection()));}
 catch{console.error('Connection check stopped. Inspect safe Worker dispatch diagnostics; no automatic resend.');process.exitCode=1;}
}
