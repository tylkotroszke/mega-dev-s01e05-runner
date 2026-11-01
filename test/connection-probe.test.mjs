import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createWorker} from '../src/worker.mjs';
import {PROBE_ID,PROBE_PATH,PROBE_REF} from '../src/connection-probe.mjs';
import {checkConnection} from '../src/check-connection.mjs';
const NOW=1800000000000,KEY='synthetic-shared-key-'.repeat(3);
const ORIGIN='https://mega-s01e05.sawczuk-mateusz.workers.dev';
function fixture(transport){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const INBOX={sql,prepare(query){return {async first(){return sql.prepare(query).get()??null;},bind(...args){return {async first(){return sql.prepare(query).get(...args)??null;},async run(){return sql.prepare(query).run(...args);}};}};}};
 const env={INBOX,AUTONOMOUS_REPLIES_ENABLED:'false',RUNNER_SHARED_KEY:KEY,GITHUB_ACTIONS_TOKEN:'synthetic-token',RUNNER_OWNER:'tylkotroszke',RUNNER_REPOSITORY:'mega-dev-s01e05-runner'};
 const calls=[],logs=[];const worker=createWorker({now:()=>NOW,log:e=>logs.push(e),fetchImpl:async(url,options)=>{calls.push({url,options});return transport?transport(url,options):new Response(null,{status:204});}});
 const request=(path='',body,runner='100-1',auth=KEY)=>new Request(ORIGIN+PROBE_PATH+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+auth,'x-runner-id':runner},body:body?JSON.stringify(body):undefined});
 return {worker,env,calls,logs,request};
}
const body={probeId:PROBE_ID};
test('probe is authenticated, only runs with agents OFF and validates exact body',async()=>{
 const f=fixture();
 assert.equal((await f.worker.fetch(f.request('',body,'100-1','wrong'),f.env)).status,401);
 assert.equal((await f.worker.fetch(f.request('',{...body,extra:'injection'}),f.env)).status,400);
 f.env.AUTONOMOUS_REPLIES_ENABLED='true';assert.equal((await f.worker.fetch(f.request('',body),f.env)).status,403);
 assert.equal(f.calls.length,0);
});
test('concurrent probe starts dispatch once with public synthetic inputs and zero context',async()=>{
 const f=fixture();const responses=await Promise.all([f.worker.fetch(f.request('',body),f.env),f.worker.fetch(f.request('',body),f.env)]);
 assert.deepEqual(responses.map(x=>x.status).sort(),[202,409]);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].url,'https://api.github.com/repos/tylkotroszke/mega-dev-s01e05-runner/actions/workflows/check-connection.yml/dispatches');
 assert.deepEqual(JSON.parse(f.calls[0].options.body),{ref:PROBE_REF,inputs:{mode:'receive',job_id:PROBE_ID}});
 const row=f.env.INBOX.sql.prepare('SELECT * FROM jobs').get();assert.equal(row.payload,null);assert.equal(row.state,'probe_dispatched');
 assert.ok(!JSON.stringify(f.logs).includes(KEY));
});
test('receiver can lease once and confirm once without any model or course request',async()=>{
 const f=fixture();await f.worker.fetch(f.request('',body),f.env);
 assert.deepEqual(await (await f.worker.fetch(f.request('/lease',body,'200-1'),f.env)).json(),{probeId:PROBE_ID,diagnostic:true});
 assert.equal((await f.worker.fetch(f.request('/lease',body,'201-1'),f.env)).status,409);
 assert.equal((await f.worker.fetch(f.request('/result',{...body,ok:true},'201-1'),f.env)).status,409);
 assert.equal((await f.worker.fetch(f.request('/result',{...body,ok:true},'200-1'),f.env)).status,200);
 assert.equal((await f.worker.fetch(f.request('/result',{...body,ok:true},'200-1'),f.env)).status,409);
 assert.deepEqual(await (await f.worker.fetch(f.request(),f.env)).json(),{probeId:PROBE_ID,state:'probe_completed',runnerId:'200-1'});
 assert.equal(f.calls.length,1);
});
test('probe failure is recorded and the one-use identifier cannot trigger a resend',async()=>{
 for(const failure of [()=>{throw new TypeError('private token detail');},()=>new Response(null,{status:403})]){
  const f=fixture(failure);assert.equal((await f.worker.fetch(f.request('',body),f.env)).status,502);
  assert.equal((await f.worker.fetch(f.request('',body),f.env)).status,409);assert.equal(f.calls.length,1);
  assert.ok(['probe_uncertain','probe_failed'].includes(f.env.INBOX.sql.prepare('SELECT state FROM jobs').get().state));
  assert.ok(!JSON.stringify(f.logs).includes('private token detail'));
 }
});
test('historical job count does not block a probe; its one-use identity still applies',async()=>{
 const f=fixture();for(let i=0;i<6;i++)f.env.INBOX.sql.prepare('INSERT INTO jobs(id,webhook_id,body_hash,state,created) VALUES (?,?,?,?,?)').run('existing-'+i,'message-'+i,'hash','answered',NOW);
 assert.equal((await f.worker.fetch(f.request('',body),f.env)).status,202);assert.equal(f.calls.length,1);
 assert.equal((await f.worker.fetch(f.request('',body),f.env)).status,409);assert.equal(f.calls.length,1);
});
test('early receiver lease is not overwritten by the dispatch acknowledgement',async()=>{
 let f;f=fixture(async()=>{assert.equal((await f.worker.fetch(f.request('/lease',body,'200-1'),f.env)).status,200);return new Response(null,{status:204});});
 assert.equal((await f.worker.fetch(f.request('',body),f.env)).status,202);
 assert.equal(f.env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'probe_leased');
});
const controllerEnv={CONNECTION_CHECK_APPROVED:'true',GITHUB_REF:'refs/tags/'+PROBE_REF,LIVE_EXECUTION_ENABLED:'false',AGENT_ORIGIN:ORIGIN,PROBE_MODE:'start',PROBE_JOB_ID:PROBE_ID,PROBE_RUNNER_ID:'100-1',RUNNER_SHARED_KEY:KEY};
test('controller confirms concrete receiver identity and only uses the approved Worker origin',async()=>{
 const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});assert.ok(url.startsWith(ORIGIN+PROBE_PATH));assert.equal(options.redirect,'error');return Response.json(options.method==='POST'?{probeId:PROBE_ID,accepted:true}:{probeId:PROBE_ID,state:'probe_completed',runnerId:'200-1'});};
 assert.deepEqual(await checkConnection({env:controllerEnv,fetchImpl,delay:async()=>{}}),{completed:true,phase:'start',receiverRun:'200-1',modelCalls:0});
 assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});
test('wrong gate, active models or origin mismatch result in no controller network call',async()=>{
 for(const change of [{CONNECTION_CHECK_APPROVED:'false'},{GITHUB_REF:'refs/heads/main'},{LIVE_EXECUTION_ENABLED:'true'},{AGENT_ORIGIN:'https://other.example'},{PROBE_JOB_ID:'other'}]){
  let calls=0;await assert.rejects(checkConnection({env:{...controllerEnv,...change},fetchImpl:async()=>{calls++;}}));assert.equal(calls,0);
 }
});
test('controller never retries POST after timeout or HTTP rejection',async()=>{
 for(const fetchImpl of [async()=>{throw Error('private request detail');},async()=>new Response('private body',{status:502})]){
  let calls=0;await assert.rejects(checkConnection({env:controllerEnv,fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}}),e=>!e.message.includes('private'));
  assert.equal(calls,1);
 }
});
