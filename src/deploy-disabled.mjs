import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const API='https://api.cloudflare.com/client/v4/accounts/32781e40b48d6ec2b90c3ed6c547d731/workers/scripts/mega-s01e05';
const PUBLIC='https://mega-s01e05.sawczuk-mateusz.workers.dev';
const REF='refs/tags/deploy-disabled-v1';
const HASH='d021990f201eb95f058599cb64b016458f0503f8f035b4292a8b9d86f2a12137';
const D1='e04e51bc-7677-4672-822c-e1d950b77735';
const EXPECTED={AUTONOMOUS_REPLIES_ENABLED:'false',MAX_JOBS_PER_DAY:'6',COURSE_ORIGIN:'https://hq.mega.dev',RUNNER_OWNER:'tylkotroszke',RUNNER_REPOSITORY:'mega-dev-s01e05-runner',RUNNER_WORKFLOW:'agents.yml',RUNNER_REF:'approved-v1'};
export const METADATA=Object.freeze({main_module:'worker.mjs',compatibility_date:'2026-10-31',keep_bindings:['plain_text','d1'],observability:{enabled:true,logs:{enabled:true,invocation_logs:true,persist:true},traces:{enabled:false}}});

async function jsonResponse(response) {
  if(!response.ok) throw new Error(`HTTP request failed (${response.status})`);
  const reader=response.body?.getReader(); if(!reader) throw new Error('Missing HTTP body');
  let text='',bytes=0; const decoder=new TextDecoder();
  try {
    for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>100_000)throw new Error('HTTP body exceeds limit');text+=decoder.decode(chunk.value,{stream:true});}
    text+=decoder.decode();
  } finally {await reader.cancel().catch(()=>{});}
  try{return JSON.parse(text);}catch{throw new Error('Invalid JSON response');}
}
function settingsSnapshot(result) {
  if(result?.compatibility_date!=='2026-10-31' || !Array.isArray(result.bindings) || result.bindings.length!==9) throw new Error('Unexpected Worker settings');
  const variables={};let database=false;
  for(const binding of result.bindings){
    if(binding.type==='plain_text' && typeof binding.text==='string' && !Object.hasOwn(variables,binding.name)) variables[binding.name]=binding.text;
    else if(binding.type==='d1' && binding.name==='INBOX' && binding.id===D1 && !database) database=true;
    else throw new Error('Unexpected Worker binding');
  }
  if(!database || Object.keys(variables).length!==8 || Object.entries(EXPECTED).some(([k,v])=>variables[k]!==v) || typeof variables.OWNER_CODE!=='string' || !/^own-[a-zA-Z0-9-]{1,100}$/.test(variables.OWNER_CODE)) throw new Error('Worker must retain approved configuration with agents disabled');
  return variables;
}
export async function deployDisabled({token,ref,approved,scriptBytes,fetchImpl=fetch,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(approved!=='true' || ref!==REF) throw new Error('Deployment gate is closed');
  if(typeof token!=='string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('Deployment token is missing or invalid');
  const bytes=scriptBytes ?? await readFile(new URL('./worker-upload.mjs',import.meta.url));
  if(createHash('sha256').update(bytes).digest('hex')!==HASH) throw new Error('Worker artifact hash differs from approval');
  const api=async(method,path='',body)=>{
    const response=await fetchImpl(API+path,{method,redirect:'error',headers:{authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(30_000)});
    const data=await jsonResponse(response);if(data?.success!==true || !data.result)throw new Error('Cloudflare did not accept the request');return data.result;
  };
  const before=settingsSnapshot(await api('GET','/settings'));
  const form=new FormData();
  form.set('metadata',new Blob([JSON.stringify(METADATA)],{type:'application/json'}));
  form.set('worker.mjs',new Blob([bytes],{type:'application/javascript+module'}),'worker.mjs');
  // Exactly one external mutation. A failure or uncertain result never retries it.
  await api('PUT','',form);
  const afterResult=await api('GET','/settings');const after=settingsSnapshot(afterResult);
  if(Object.keys(before).some(k=>before[k]!==after[k]) || afterResult.observability?.enabled!==true || afterResult.observability?.logs?.enabled!==true)throw new Error('Post-deployment settings differ');
  let verified=false;
  for(let attempt=0;attempt<5;attempt++){
    try {
      const health=await jsonResponse(await fetchImpl(PUBLIC+'/health',{redirect:'error',headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(10_000)}));
      const manifest=await jsonResponse(await fetchImpl(PUBLIC+'/.well-known/mega-pulse.json',{redirect:'error',headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(10_000)}));
      if(health.ok!==true || health.enabled!==false || manifest.owner!==before.OWNER_CODE || JSON.stringify(manifest.agents)!==JSON.stringify({pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}))throw new Error('Public verification differs');
      verified=true;break;
    } catch {if(attempt<4)await delay(1000);}
  }
  if(!verified)throw new Error('Upload attempted once; public verification failed; owner review required');
  return {uploadedOnce:true,bundleSha256:HASH,agentsEnabled:false,bindingsPreserved:true,logsEnabled:true,publicChecks:'pass'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {console.log(JSON.stringify(await deployDisabled({token:process.env.CLOUDFLARE_DEPLOY_TOKEN,ref:process.env.GITHUB_REF,approved:process.env.DEPLOY_DISABLED_APPROVED})));}
  catch(error){console.error(error instanceof Error && !/(?:Bearer|[A-Za-z0-9_-]{30,})/.test(error.message)?error.message:'Deployment failed; owner review required');process.exitCode=1;}
}
