import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {boundedText} from './protocol.mjs';

const API='https://api.cloudflare.com/client/v4/accounts/32781e40b48d6ec2b90c3ed6c547d731/workers/scripts/mega-s01e05';
const PUBLIC='https://mega-s01e05.sawczuk-mateusz.workers.dev';
const TARGET='writer-fix-v1',BEFORE='no-cap-v1';
const D1='e04e51bc-7677-4672-822c-e1d950b77735';
const EXPECTED={AUTONOMOUS_REPLIES_ENABLED:'true',COURSE_ORIGIN:'https://hq.mega.dev',RUNNER_OWNER:'tylkotroszke',RUNNER_REPOSITORY:'mega-dev-s01e05-runner',RUNNER_WORKFLOW:'agents.yml'};
const SECRETS=['GITHUB_ACTIONS_TOKEN','PING_KEY','RUNNER_SHARED_KEY'];
export const SETTINGS=Object.freeze(JSON.parse(await readFile(new URL('../requests/promote-writer-settings.json',import.meta.url),'utf8')));
export const HASHES=Object.freeze({
  "src/runner.mjs": "a694fa3a69ccf314f9edfb385ba8250da82e87169f98e9d685e636c0fc34a681",
  "src/gemini.mjs": "b83446c8d1dac0c4fc4788d435ff5bac7e29f6bc1dc4d62bfc1c34ddaeb936d9",
  "src/agents.mjs": "2078457cc03c4dd0a20baa2d45e80a95590bffcf991ec8d26753e7fe70fb15b6",
  "src/orchestrate.mjs": "df143253dffcf3d28bcac87336ecbfb83bbaf242895bcefd1652e5dbe1e5e2b2",
  "src/sandbox.mjs": "27cc324f076c183ea8c31a580d2b8dbdd4a25aec83e7ce7d3bfa4862e6debd1e",
  "src/diagnostics.mjs": "1f1cca93543ec3bf589b24b90fc7a68b6002669014de96705e60145fc87dbf20",
  ".github/workflows/agents.yml": "d4bad177590da866cc7dc63edfc96fec01037ae0bdd2331e2689bcaf7f794857"
});
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value??'');

function snapshot(result,ref){
  if(result?.compatibility_date!=='2026-10-31'||!Array.isArray(result.bindings)||result.bindings.length!==11)throw Error('Unexpected Worker settings');
  const variables={},secrets=new Set();let database=false;
  for(const binding of result.bindings){
    if(binding.type==='plain_text'&&typeof binding.text==='string'&&!Object.hasOwn(variables,binding.name))variables[binding.name]=binding.text;
    else if(binding.type==='d1'&&binding.name==='INBOX'&&(binding.id??binding.database_id)===D1&&!database)database=true;
    else if(binding.type==='secret_text'&&SECRETS.includes(binding.name)&&!secrets.has(binding.name))secrets.add(binding.name);
    else throw Error('Unexpected Worker binding');
  }
  if(Object.keys(variables).length!==7||!database||secrets.size!==3||variables.RUNNER_REF!==ref||Object.entries(EXPECTED).some(([name,value])=>variables[name]!==value)||!/^own-[A-Za-z0-9-]{1,100}$/.test(variables.OWNER_CODE??''))throw Error('Worker differs from approved ON configuration');
  if(result.observability?.enabled!==true||!['enabled','invocation_logs','persist'].every(key=>result.observability?.logs?.[key]===true))throw Error('Required persisted invocation logs are not ON');
  const protectedSettings={};
  for(const key of ['compatibility_date','compatibility_flags','usage_model','limits','observability','logpush','placement','tail_consumers','cache_options','tags'])if(Object.hasOwn(result,key))protectedSettings[key]=result[key];
  return {variables,protectedSettings};
}

async function readJSON(response){
  if(!response.ok)throw Error(`HTTP request failed (${response.status})`);
  return JSON.parse(await boundedText(response,256_000));
}

export async function promoteWriter({token,ref,approved,fetchImpl=fetch,readArtifact=path=>readFile(new URL('../'+path,import.meta.url))}={}){
  if(approved!=='true'||ref!=='refs/tags/'+TARGET)throw Error('Promotion gate is closed');
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{20,256}$/.test(token))throw Error('Deployment token unavailable');
  for(const [path,expected] of Object.entries(HASHES))if(createHash('sha256').update(await readArtifact(path)).digest('hex')!==expected)throw Error('Approved runtime hash differs');
  // Check the complete request, including all inherited binding names, before I/O.
  const names=[...Object.keys(EXPECTED),'RUNNER_REF','OWNER_CODE','INBOX',...SECRETS].sort();
  const expectedSettings={bindings:names.map(name=>name==='RUNNER_REF'?{name,type:'plain_text',text:TARGET}:{name,type:'inherit'})};
  if(canonical({...SETTINGS,bindings:[...SETTINGS.bindings].sort((a,b)=>a.name.localeCompare(b.name))})!==canonical(expectedSettings))throw Error('Approved settings body differs');
  const api=async(method,path,body)=>{
    const response=await fetchImpl(API+path,{method,redirect:'error',headers:{authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(15_000)});
    const data=await readJSON(response);if(data?.success!==true||!data.result)throw Error('Cloudflare request not accepted');return data.result;
  };
  const publicJSON=path=>fetchImpl(PUBLIC+path,{method:'GET',redirect:'error',headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(10_000)}).then(readJSON);
  const latestActive=async()=>{
    const versions=await api('GET','/versions');
    const deployments=await api('GET','/deployments');
    if(!Array.isArray(deployments.deployments)||!deployments.deployments.length||deployments.deployments.some(item=>!Number.isFinite(Date.parse(item.created_on))))throw Error('Deployment metadata unavailable');
    const active=[...deployments.deployments].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0]?.versions;
    const latest=versions.items?.[0]?.id;
    if(!uuid(latest)||!Array.isArray(active)||active.length!==1||active[0].percentage!==100||active[0].version_id!==latest)throw Error('Latest Worker version is not the single active version');
    return latest;
  };
  const before=snapshot(await api('GET','/settings'),BEFORE);
  const beforeVersion=await latestActive();
  const healthBefore=await publicJSON('/health');
  if(healthBefore.ok!==true||healthBefore.enabled!==true)throw Error('Public agents are not ON');
  const form=new FormData();form.set('settings',new Blob([JSON.stringify(SETTINGS)],{type:'application/json'}));
  // The only Cloudflare mutation. Never upload code, retry, roll back or toggle OFF.
  await api('PATCH','/settings',form);
  const after=snapshot(await api('GET','/settings'),TARGET);
  const expected={...before,variables:{...before.variables,RUNNER_REF:TARGET}};
  if(canonical(after)!==canonical(expected))throw Error('Post-promotion settings differ');
  const afterVersion=await latestActive();
  const health=await publicJSON('/health'),manifest=await publicJSON('/.well-known/mega-pulse.json');
  if(health.ok!==true||health.enabled!==true||manifest.owner!==before.variables.OWNER_CODE||canonical(manifest.agents)!==canonical({pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}))throw Error('Public verification differs');
  return {patchedOnce:true,runnerRef:TARGET,agentsEnabled:true,bindingsPreserved:true,logsPreserved:true,beforeVersion,afterVersion,publicChecks:'pass'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await promoteWriter({token:process.env.CLOUDFLARE_DEPLOY_TOKEN,ref:process.env.GITHUB_REF,approved:process.env.PROMOTE_WRITER_APPROVED})));}
  catch(error){console.error(/^HTTP request failed \([0-9]{3}\)$/.test(error?.message??'')?error.message:'Writer promotion stopped; no automatic retry or OFF. Inspect the safe status and obtain owner review.');process.exitCode=1;}
}
