import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deployDisabled,METADATA} from '../src/deploy-disabled.mjs';
const token='synthetic-deploy-token-not-a-real-credential';
const vars={AUTONOMOUS_REPLIES_ENABLED:'false',MAX_JOBS_PER_DAY:'6',COURSE_ORIGIN:'https://hq.mega.dev',RUNNER_OWNER:'tylkotroszke',RUNNER_REPOSITORY:'mega-dev-s01e05-runner',RUNNER_WORKFLOW:'agents.yml',RUNNER_REF:'approved-v1',OWNER_CODE:'own-synthetic'};
const settings=()=>({compatibility_date:'2026-10-31',bindings:[...Object.entries(vars).map(([name,text])=>({type:'plain_text',name,text})),{type:'d1',name:'INBOX',id:'e04e51bc-7677-4672-822c-e1d950b77735'}],observability:{enabled:true,logs:{enabled:true}}});
const options={token,ref:'refs/tags/deploy-disabled-v1',approved:'true',delay:async()=>{}};
const json=x=>Response.json(x);
function transport({changeSettings,putResponse,health}={}){
 const calls=[];
 return {calls,fetchImpl:async(url,init={})=>{
   calls.push({url,init}); assert.equal(init.redirect,'error');
   if(url.startsWith('https://api.cloudflare.com/')){
     assert.equal(init.headers.authorization,`Bearer ${token}`);
     if(init.method==='PUT'){
       assert.deepEqual(JSON.parse(await init.body.get('metadata').text()),METADATA);
       assert.equal(init.body.get('worker.mjs').type,'application/javascript+module');
       assert.equal(init.body.get('metadata').type,'application/json');
       return putResponse?.() ?? json({success:true,result:{id:'synthetic-worker'}});
     }
     const result=settings();changeSettings?.(result);return json({success:true,result});
   }
   assert.equal(Object.hasOwn(init.headers??{},'authorization'),false);
   if(url.endsWith('/health'))return health?.() ?? json({ok:true,enabled:false});
   return json({owner:vars.OWNER_CODE,agents:{pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}});
 }};
}
test('single fixed upload retains binding types and verifies disabled public endpoints without credential leakage',async()=>{
 const mock=transport();const result=await deployDisabled({...options,fetchImpl:mock.fetchImpl});
 assert.equal(mock.calls.filter(c=>c.init.method==='PUT').length,1);assert.equal(result.agentsEnabled,false);
 assert.equal(JSON.stringify(result).includes(token),false);assert.deepEqual(METADATA.keep_bindings,['plain_text','d1']);assert.equal(METADATA.observability.logs.enabled,true);
});
test('main ref, missing approval and modified artifact make no network request',async()=>{
 for(const change of [{ref:'refs/heads/main'},{approved:'false'},{scriptBytes:Buffer.from('changed artifact')}]){const mock=transport();await assert.rejects(deployDisabled({...options,...change,fetchImpl:mock.fetchImpl}));assert.equal(mock.calls.length,0);}
});
test('active agents or extra binding abort before any mutation',async()=>{
 for(const changeSettings of [r=>r.bindings[0].text='true',r=>r.bindings.push({type:'secret_text',name:'unexpected'})]){const mock=transport({changeSettings});await assert.rejects(deployDisabled({...options,fetchImpl:mock.fetchImpl}));assert.equal(mock.calls.filter(c=>c.init.method==='PUT').length,0);}
});
test('Cloudflare rejection is not retried and untrusted response text is not in the error',async()=>{
 const mock=transport({putResponse:()=>new Response(token,{status:429})});await assert.rejects(deployDisabled({...options,fetchImpl:mock.fetchImpl}),error=>!error.message.includes(token));assert.equal(mock.calls.filter(c=>c.init.method==='PUT').length,1);
});
test('public verification failure performs read-only probes and never another upload',async()=>{
 const mock=transport({health:()=>new Response('Hello World!')});await assert.rejects(deployDisabled({...options,fetchImpl:mock.fetchImpl}),/public verification failed/);assert.equal(mock.calls.filter(c=>c.init.method==='PUT').length,1);assert.equal(mock.calls.filter(c=>c.url.endsWith('/health')).length,5);
});
test('redirect response aborts before upload instead of forwarding the credential',async()=>{
 let count=0;await assert.rejects(deployDisabled({...options,fetchImpl:async(_url,init)=>{count++;assert.equal(init.redirect,'error');return new Response(null,{status:302,headers:{location:'https://other.example'}});}}));assert.equal(count,1);
});
