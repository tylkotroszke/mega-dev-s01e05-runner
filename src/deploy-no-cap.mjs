import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const API='https://api.cloudflare.com/client/v4/accounts/32781e40b48d6ec2b90c3ed6c547d731/workers/scripts/mega-s01e05';
const PUBLIC='https://mega-s01e05.sawczuk-mateusz.workers.dev';
const REF='refs/tags/no-cap-v1';
export const HASHES=Object.freeze({
  "worker.mjs": "00050bb6bbb3f49478261daeca32187121526bb76dbf1b952ffeda86f9d4d047",
  "store.mjs": "1d70f1c19e05220d29618593cd2a947c8bb04254be311b659272870cb0b4571d",
  "protocol.mjs": "31f118a8628338ab561b84d5f3298b179123b7e3cb529da576ced9f0838f5bfe",
  "connection-probe.mjs": "071e203d1ed66ce99fef9821ca2628c27dfc9cc3759770c44b0fae094fb960fa"
});
const D1='e04e51bc-7677-4672-822c-e1d950b77735';
const EXPECTED={AUTONOMOUS_REPLIES_ENABLED:'true',COURSE_ORIGIN:'https://hq.mega.dev',RUNNER_OWNER:'tylkotroszke',RUNNER_REPOSITORY:'mega-dev-s01e05-runner',RUNNER_WORKFLOW:'agents.yml',RUNNER_REF:'no-cap-v1'};
export const METADATA=Object.freeze({main_module:'worker.mjs',compatibility_date:'2026-10-31',keep_bindings:['plain_text','d1','secret_text'],observability:{enabled:true,logs:{enabled:true,invocation_logs:true,persist:true},traces:{enabled:false}}});

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
  if(result?.compatibility_date!=='2026-10-31' || !Array.isArray(result.bindings) || ![11,12].includes(result.bindings.length)) throw new Error('Unexpected Worker settings');
  const variables={},secrets=new Set();let database=false;
  for(const binding of result.bindings){
    if(binding.type==='plain_text' && typeof binding.text==='string' && !Object.hasOwn(variables,binding.name)) variables[binding.name]=binding.text;
    else if(binding.type==='d1' && binding.name==='INBOX' && binding.id===D1 && !database) database=true;
    else if(binding.type==='secret_text'&&['PING_KEY','RUNNER_SHARED_KEY','GITHUB_ACTIONS_TOKEN'].includes(binding.name)&&!secrets.has(binding.name))secrets.add(binding.name);
    else throw new Error('Unexpected Worker binding');
  }
  const legacyLimit=Object.hasOwn(variables,'MAX_JOBS_PER_DAY');
  if(!database || secrets.size!==3 || Object.keys(variables).length!==(legacyLimit?8:7) ||
     (legacyLimit&&variables.MAX_JOBS_PER_DAY!=='6') || Object.entries(EXPECTED).some(([k,v])=>variables[k]!==v) ||
     typeof variables.OWNER_CODE!=='string' || !/^own-[a-zA-Z0-9-]{1,100}$/.test(variables.OWNER_CODE)) throw new Error('Worker must retain approved configuration with agents enabled');
  return variables;
}
export async function deployNoCap({token,ref,approved,modules,fetchImpl=fetch,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(approved!=='true' || ref!==REF) throw new Error('Deployment gate is closed');
  if(typeof token!=='string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('Deployment token is missing or invalid');
  if(Object.keys(HASHES).sort().join(',')!=='connection-probe.mjs,protocol.mjs,store.mjs,worker.mjs')throw new Error('Artifact manifest is incomplete');
  if(modules&&Object.keys(modules).sort().join(',')!==Object.keys(HASHES).sort().join(','))throw new Error('Artifact list differs');
  const artifacts={};
  for(const [name,expectedHash] of Object.entries(HASHES)){
    const bytes=modules?.[name]??await readFile(new URL('./'+name,import.meta.url));
    if(createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw new Error('Worker artifact hash differs from approval');
    artifacts[name]=bytes;
  }
  const api=async(method,path='',body)=>{
    const response=await fetchImpl(API+path,{method,redirect:'error',headers:{authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(30_000)});
    const data=await jsonResponse(response);if(data?.success!==true || !data.result)throw new Error('Cloudflare did not accept the request');return data.result;
  };
  const before=settingsSnapshot(await api('GET','/settings'));
  const form=new FormData();
  form.set('metadata',new Blob([JSON.stringify(METADATA)],{type:'application/json'}));
  for(const [name,bytes] of Object.entries(artifacts))form.set(name,new Blob([bytes],{type:'application/javascript+module'}),name);
  // Exactly one external mutation. A failure or uncertain result never retries it.
  await api('PUT','',form);
  const afterResult=await api('GET','/settings');const after=settingsSnapshot(afterResult);
  if(JSON.stringify(Object.entries(before).sort())!==JSON.stringify(Object.entries(after).sort()) || afterResult.observability?.enabled!==true || afterResult.observability?.logs?.enabled!==true)throw new Error('Post-deployment settings differ');
  let verified=false;
  for(let attempt=0;attempt<5;attempt++){
    try {
      const health=await jsonResponse(await fetchImpl(PUBLIC+'/health',{redirect:'error',headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(10_000)}));
      const manifest=await jsonResponse(await fetchImpl(PUBLIC+'/.well-known/mega-pulse.json',{redirect:'error',headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(10_000)}));
      if(health.ok!==true || health.enabled!==true || manifest.owner!==before.OWNER_CODE || JSON.stringify(manifest.agents)!==JSON.stringify({pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}))throw new Error('Public verification differs');
      verified=true;break;
    } catch {if(attempt<4)await delay(1000);}
  }
  if(!verified)throw new Error('Upload attempted once; public verification failed; owner review required');
  return {uploadedOnce:true,moduleHashes:HASHES,agentsEnabled:true,bindingsPreserved:true,secretsPreserved:true,logsEnabled:true,publicChecks:'pass'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {console.log(JSON.stringify(await deployNoCap({token:process.env.CLOUDFLARE_DEPLOY_TOKEN,ref:process.env.GITHUB_REF,approved:process.env.DEPLOY_NO_CAP_APPROVED})));}
  catch(error){console.error(/^HTTP request failed \([0-9]{3}\)$/.test(error?.message??'')?error.message:'No-cap deployment stopped; inspect safe request status. Upload is never automatically retried.');process.exitCode=1;}
}
