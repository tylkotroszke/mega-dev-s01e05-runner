import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promoteWriter,SETTINGS} from '../src/promote-writer.mjs';
const token='synthetic-deploy-token-not-a-real-credential';
const options={token,ref:'refs/tags/writer-fix-v1',approved:'true'};
const beforeID='11111111-1111-4111-8111-111111111111',afterID='22222222-2222-4222-8222-222222222222';
const vars={AUTONOMOUS_REPLIES_ENABLED:'true',COURSE_ORIGIN:'https://hq.mega.dev',RUNNER_OWNER:'tylkotroszke',RUNNER_REPOSITORY:'mega-dev-s01e05-runner',RUNNER_WORKFLOW:'agents.yml',RUNNER_REF:'no-cap-v1',OWNER_CODE:'own-synthetic'};
const json=result=>Response.json({success:true,result});
function transport({beforeChange,afterChange,patchResponse,latestMismatch=false,healthBefore=true,healthAfter=true}={}){
  const calls=[];let patched=false;
  const settings=()=>({compatibility_date:'2026-10-31',usage_model:'standard',bindings:[...Object.entries({...vars,RUNNER_REF:patched?'writer-fix-v1':'no-cap-v1'}).map(([name,text])=>({name,type:'plain_text',text})),{name:'INBOX',type:'d1',id:'e04e51bc-7677-4672-822c-e1d950b77735'},...['PING_KEY','RUNNER_SHARED_KEY','GITHUB_ACTIONS_TOKEN'].map(name=>({name,type:'secret_text'}))],observability:{enabled:true,logs:{enabled:true,invocation_logs:true,persist:true},traces:{enabled:false}}});
  return {calls,fetchImpl:async(url,init)=>{
    calls.push({url,init});assert.equal(init.redirect,'error');
    if(url.startsWith('https://api.cloudflare.com/')){
      assert.equal(init.headers.authorization,`Bearer ${token}`);
      if(init.method==='PATCH'){
        assert.ok(url.endsWith('/settings'));
        assert.deepEqual([...init.body.keys()],['settings']);
        const blob=init.body.get('settings');assert.equal(blob.type,'application/json');
        const data=JSON.parse(await blob.text());assert.deepEqual(data,SETTINGS);
        assert.deepEqual(data.bindings.filter(b=>b.type!=='inherit'),[{name:'RUNNER_REF',type:'plain_text',text:'writer-fix-v1'}]);
        patched=true;return patchResponse?.()??json({ok:true});
      }
      assert.equal(init.method,'GET');
      if(url.endsWith('/settings')){const result=settings();(patched?afterChange:beforeChange)?.(result);return json(result);}
      const version=patched?afterID:beforeID;
      if(url.endsWith('/versions'))return json({items:[{id:version}]});
      if(url.endsWith('/deployments'))return json({deployments:[{created_on:'2026-11-01T17:00:00Z',versions:[{version_id:latestMismatch?afterID:version,percentage:100}]}]});
      throw Error('Unexpected API path');
    }
    assert.equal(init.method,'GET');assert.equal(init.headers.authorization,undefined);
    assert.ok(url.startsWith('https://mega-s01e05.sawczuk-mateusz.workers.dev/'));
    if(url.endsWith('/health'))return Response.json({ok:true,enabled:patched?healthAfter:healthBefore});
    return Response.json({owner:vars.OWNER_CODE,agents:{pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}});
  }};
}
const writes=mock=>mock.calls.filter(call=>call.init.method!=='GET');

test('promotion performs exactly one settings PATCH, inherits all other bindings and keeps ON/logs',async()=>{
  const mock=transport(),result=await promoteWriter({...options,fetchImpl:mock.fetchImpl});
  assert.equal(writes(mock).length,1);assert.equal(result.runnerRef,'writer-fix-v1');assert.equal(result.agentsEnabled,true);assert.equal(result.logsPreserved,true);
  assert.equal(result.beforeVersion,beforeID);assert.equal(result.afterVersion,afterID);
  assert.equal(JSON.stringify(result).includes(token),false);assert.equal(JSON.stringify(result).includes(vars.OWNER_CODE),false);
  assert.equal(mock.calls.some(call=>/gemini|generativelanguage|hq\.mega\.dev/.test(call.url)),false);
});

test('wrong ref, missing approval and changed runtime stop before network',async()=>{
  for(const change of [{ref:'refs/heads/main'},{approved:'false'},{readArtifact:async()=>Buffer.from('modified')}]){
    const mock=transport();await assert.rejects(promoteWriter({...options,...change,fetchImpl:mock.fetchImpl}));assert.equal(mock.calls.length,0);
  }
});

test('OFF, unexpected ref, missing secrets/D1 or disabled log persistence block promotion',async()=>{
  for(const beforeChange of [
    s=>s.bindings.find(b=>b.name==='AUTONOMOUS_REPLIES_ENABLED').text='false',
    s=>s.bindings.find(b=>b.name==='RUNNER_REF').text='other',
    s=>s.bindings.pop(),s=>s.bindings.find(b=>b.name==='INBOX').id='other',
    s=>s.observability.logs.persist=false,
    s=>s.bindings.push({name:'MAX_JOBS_PER_DAY',type:'plain_text',text:'6'}),
  ]){const mock=transport({beforeChange});await assert.rejects(promoteWriter({...options,fetchImpl:mock.fetchImpl}));assert.equal(writes(mock).length,0);}
});

test('an undeployed latest version blocks inherit instead of selecting an unreviewed source',async()=>{
  const mock=transport({latestMismatch:true});await assert.rejects(promoteWriter({...options,fetchImpl:mock.fetchImpl}),/single active/);assert.equal(writes(mock).length,0);
});

test('failed or uncertain PATCH is never retried and no OFF/rollback is sent',async()=>{
  for(const patchResponse of [()=>new Response(token,{status:429}),()=>{throw Error('uncertain transport');}]){
    const mock=transport({patchResponse});await assert.rejects(promoteWriter({...options,fetchImpl:mock.fetchImpl}));assert.equal(writes(mock).length,1);
  }
});

test('post-promotion drift or unhealthy public endpoint stops without a second write',async()=>{
  for(const afterChange of [s=>s.observability.logs.enabled=false,s=>s.bindings.find(b=>b.name==='COURSE_ORIGIN').text='https://changed.example',s=>s.limits={cpu_ms:500}]){
    const mock=transport({afterChange});await assert.rejects(promoteWriter({...options,fetchImpl:mock.fetchImpl}));assert.equal(writes(mock).length,1);
  }
  const mock=transport({healthAfter:false});await assert.rejects(promoteWriter({...options,fetchImpl:mock.fetchImpl}),/Public verification/);assert.equal(writes(mock).length,1);
});

test('unhealthy preflight or an HTTP redirect cannot cause a write or credential forwarding',async()=>{
  const mock=transport({healthBefore:false});await assert.rejects(promoteWriter({...options,fetchImpl:mock.fetchImpl}));assert.equal(writes(mock).length,0);
  let calls=0;await assert.rejects(promoteWriter({...options,fetchImpl:async(_url,init)=>{calls++;assert.equal(init.redirect,'error');return new Response(null,{status:302,headers:{location:'https://other.example'}});}}));assert.equal(calls,1);
});
