import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {createWorker} from '../src/worker.mjs';
import {validatePing,verifyWebhook,validateAnswer} from '../src/protocol.mjs';

const NOW=1800000000000;
const KEY='whsec_'+Buffer.alloc(32,8).toString('base64');
const SHARED='s'.repeat(48);
const ORIGIN='https://course.example';
const phrase='a different phrase';
const pulse={kind:'pulse',phrase,text:`pulse? ${phrase}`,reply:ORIGIN+'/reply/test',tracker:ORIGIN+'/rig/tracker/issues'};
function db() {
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO documents VALUES (?,?)').run('context',JSON.stringify({plan:'generic plan',history:[]}));
 return {prepare(query) { return {async first(){return sql.prepare(query).get() ?? null;},bind(...args) {return {
  async first() {return sql.prepare(query).get(...args) ?? null;},
  async run() {return sql.prepare(query).run(...args);}
 };}};},sql};
}
function setup(fetchImpl) {
 const INBOX=db();
 const env={INBOX,COURSE_ORIGIN:ORIGIN,PING_KEY:KEY,RUNNER_SHARED_KEY:SHARED,OWNER_CODE:'public-owner-placeholder',AUTONOMOUS_REPLIES_ENABLED:'true',RUNNER_OWNER:'generic-owner',RUNNER_REPOSITORY:'generic-runner',RUNNER_WORKFLOW:'agents.yml',RUNNER_REF:'approved-v1',GITHUB_ACTIONS_TOKEN:'not-a-real-token'};
 const calls=[],logs=[];
 const worker=createWorker({now:()=>NOW,log:entry=>logs.push(entry),fetchImpl:async(url,options)=>{calls.push({url,options});return fetchImpl?fetchImpl(url,options):new Response(null,{status:204});}});
 return {worker,env,calls,logs};
}
function signed(value=pulse,id='message-1',time=NOW/1000) {
 const raw=JSON.stringify(value);
 const sig=createHmac('sha256',Buffer.from(KEY.slice(6),'base64')).update(`${id}.${time}.${raw}`).digest('base64');
 return new Request('https://worker.example/',{method:'POST',body:raw,headers:{'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(time),'webhook-signature':`v1,${sig}`}});
}
function internal(path,runner='run-1',body) {
 return new Request('https://worker.example'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${SHARED}`,'x-runner-id':runner},body:body?JSON.stringify(body):undefined});
}
test('manifest grants only answer and test; disabled deployment performs no work',async()=>{
 const {worker,env,calls}=setup(); env.AUTONOMOUS_REPLIES_ENABLED='false';
 const res=await worker.fetch(new Request('https://worker.example/.well-known/mega-pulse.json'),env);
 assert.deepEqual((await res.json()).agents,{pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}});
 assert.equal((await worker.fetch(signed(),env)).status,503);assert.equal(calls.length,0);
});
test('tampered, expired, future and invalid signatures never dispatch',async()=>{
 const {worker,env,calls}=setup();
 for(const time of [NOW/1000-301,NOW/1000+301]) assert.equal((await worker.fetch(signed(pulse,'x',time),env)).status,401);
 const request=signed(); const headers=new Headers(request.headers);headers.set('webhook-signature','v1,'+Buffer.alloc(32).toString('base64'));
 assert.equal((await worker.fetch(new Request(request,{headers}),env)).status,401);assert.equal(calls.length,0);
});
test('one rotation signature may verify even when another is invalid',async()=>{
 const request=signed(); const body=await request.text();
 request.headers.set('webhook-signature','v1,bad v2,unknown '+request.headers.get('webhook-signature'));
 assert.equal(await verifyWebhook(request.headers,body,KEY,NOW),true);
});
test('concurrent duplicates reserve once and public dispatch inputs contain only job ID',async()=>{
 const {worker,env,calls}=setup();
 const responses=await Promise.all(Array.from({length:5},()=>worker.fetch(signed(),env)));
 assert.ok(responses.every(x=>x.status===202));assert.equal(calls.length,1);
 assert.equal(calls[0].options.redirect,'manual');
 const body=JSON.parse(calls[0].options.body);assert.deepEqual(Object.keys(body.inputs),['job_id']);
 assert.ok(!calls[0].options.body.includes(pulse.reply));
 assert.equal((await worker.fetch(signed({...pulse,phrase:'changed'}),env)).status,409);
});
test('more than six unique signed pings are accepted without a daily task quota',async()=>{
 const {worker,env,calls}=setup();
 const results=await Promise.all(Array.from({length:12},(_,i)=>worker.fetch(signed(pulse,'unique-'+i),env)));
 assert.ok(results.every(r=>r.status===202));assert.equal(calls.length,12);
 assert.equal(env.INBOX.sql.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,12);
 assert.equal((await worker.fetch(signed(pulse,'unique-0'),env)).status,202);
 assert.equal(calls.length,12);
});

test('historical diagnostic rows and the obsolete setting cannot impose a task quota',async()=>{
 const {worker,env,calls}=setup();env.MAX_JOBS_PER_DAY='1';
 for(let i=0;i<20;i++)env.INBOX.sql.prepare('INSERT INTO jobs(id,webhook_id,body_hash,state,created) VALUES (?,?,?,?,?)').run('old-'+i,'old-webhook-'+i,'hash','probe_uncertain',NOW);
 assert.equal((await worker.fetch(signed(),env)).status,202);assert.equal(calls.length,1);
});
test('job lease is authenticated and one-use; reply token never enters runner',async()=>{
 const {worker,env,calls}=setup();await worker.fetch(signed(),env);const id=JSON.parse(calls[0].options.body).inputs.job_id;
 assert.equal((await worker.fetch(new Request(`https://worker.example/internal/jobs/${id}`),env)).status,401);
 const response=await worker.fetch(internal(`/internal/jobs/${id}`),env); assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.ping.reply,undefined);assert.ok(!JSON.stringify(data).includes(pulse.reply));
 assert.equal((await worker.fetch(internal(`/internal/jobs/${id}`,'run-2'),env)).status,409);
});
test('result sends once to original signed reply; public response contains no data',async()=>{
 const {worker,env,calls}=setup((url)=>new Response(null,{status:url.startsWith(ORIGIN)?202:204}));
 await worker.fetch(signed(),env);const id=JSON.parse(calls[0].options.body).inputs.job_id;
 await worker.fetch(internal(`/internal/jobs/${id}`),env);
 const answer={text:`${JSON.stringify(phrase)} #4: investigate the open issue`};
 assert.equal((await worker.fetch(internal(`/internal/jobs/${id}/result`,'run-1',answer),env)).status,200);
 assert.equal((await worker.fetch(internal(`/internal/jobs/${id}/result`,'run-1',answer),env)).status,409);
 assert.equal(calls.length,2);assert.equal(calls[1].url,pulse.reply);
 assert.equal(calls[1].options.redirect,'manual');
 const row=env.INBOX.sql.prepare('SELECT * FROM jobs WHERE id=?').get(id);
 assert.equal(row.payload,null);assert.equal(row.answer,null);assert.equal(row.state,'answered');
});
test('uncertain reply is never resent automatically',async()=>{
 const {worker,env,calls}=setup((url)=>{if(url.startsWith(ORIGIN))throw Error('network');return new Response(null,{status:204});});
 await worker.fetch(signed(),env);const id=JSON.parse(calls[0].options.body).inputs.job_id;await worker.fetch(internal(`/internal/jobs/${id}`),env);
 const answer={text:'pulse stopped: tracker unavailable'};
 assert.equal((await worker.fetch(internal(`/internal/jobs/${id}/result`,'run-1',answer),env)).status,502);
 assert.equal((await worker.fetch(internal(`/internal/jobs/${id}/result`,'run-1',answer),env)).status,409);
 assert.equal(calls.length,2);
});
test('strict origins, tracker mutations, redirect tricks and traversal rejected',()=>{
 for(const reply of [ORIGIN+'.evil/reply/x',ORIGIN+'@evil.example/x',ORIGIN+'/rig/tracker/issues/1/close',ORIGIN+'/rig/%74racker/issues/1/close',ORIGIN+'/rig/%2574racker/issues/1/label',ORIGIN+'/rig%2ftracker/issues/1/comment',ORIGIN+'/reply/%252e%252e/mcp',ORIGIN+'/mcp',ORIGIN+'/challenges/claim','http://course.example/reply/x',ORIGIN+'/reply/x#fragment']){
  assert.throws(()=>validatePing({...pulse,reply},ORIGIN));
 }
 assert.throws(()=>validatePing({...pulse,tracker:ORIGIN+'/rig/tracker/issues?override=yes'},ORIGIN));
 assert.throws(()=>validatePing({kind:'test',issue:1,reply:pulse.reply,files:{'src/../escape.ts':'bad'}},ORIGIN));
 assert.throws(()=>validateAnswer(pulse,{text:'unquoted phrase'}));
 assert.throws(()=>validateAnswer(pulse,{text:'pulse stopped: error\nmore'}));
});

test('GitHub HTTP rejection is distinct from a thrown transport error and never retried',async()=>{
 for(const status of [401,403,404,422]) {
  const {worker,env,calls,logs}=setup(()=>new Response('private-upstream-body',{status}));
  assert.equal((await worker.fetch(signed(),env)).status,502);
  assert.equal(env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'dispatch_failed');
  assert.deepEqual(logs.map(x=>[x.stage,x.httpStatus,x.errorType]),[['github_response',status,null]]);
  assert.equal((await worker.fetch(signed(),env)).status,202);
  assert.equal(calls.length,1);
  assert.ok(!JSON.stringify(logs).includes('private-upstream-body'));
 }
});

test('timeout and runtime exceptions retain only a bounded type, with no automatic resend',async()=>{
 for(const name of ['TimeoutError','AbortError','TypeError','Error','arbitrary-secret-name']) {
  const error=new Error('private-exception-message '+SHARED);error.name=name;
  const {worker,env,calls,logs}=setup(()=>{throw error;});
  assert.equal((await worker.fetch(signed(),env)).status,502);
  assert.equal(env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'dispatch_uncertain');
  assert.equal(logs[0].stage,'transport_failed');assert.equal(logs[0].httpStatus,null);
  assert.equal(logs[0].errorType,name==='arbitrary-secret-name'?'OtherError':name);
  assert.equal((await worker.fetch(signed(),env)).status,202);assert.equal(calls.length,1);
  for(const secret of [SHARED,KEY,'private-exception-message','arbitrary-secret-name']) assert.ok(!JSON.stringify(logs).includes(secret));
 }
});

test('a failed D1 state write after GitHub acceptance does not poison a queued runner lease',async()=>{
 const {worker,env,calls,logs}=setup();
 const originalPrepare=env.INBOX.prepare.bind(env.INBOX);
 env.INBOX.prepare=query=>{
  const statement=originalPrepare(query);
  if(!query.startsWith('UPDATE jobs SET state=?')) return statement;
  return {bind(...args){
   const bound=statement.bind(...args);
   return {...bound,async run(){if(args[0]==='dispatched')throw Error('private-database-detail');return bound.run();}};
  }};
 };
 assert.equal((await worker.fetch(signed(),env)).status,202);
 assert.equal(env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'dispatching');
 assert.deepEqual(logs.map(x=>[x.stage,x.httpStatus]),[['github_response',204],['state_write_failed',204]]);
 assert.ok(!JSON.stringify(logs).includes('private-database-detail'));
 const id=JSON.parse(calls[0].options.body).inputs.job_id;
 assert.equal((await worker.fetch(internal(`/internal/jobs/${id}`),env)).status,200);
 assert.equal(calls.length,1);
});

test('diagnostics expose only the approved fields and never transport or course secrets',async()=>{
 const {worker,env,logs}=setup();
 await worker.fetch(signed(),env);
 assert.deepEqual(Object.keys(logs[0]).sort(),['elapsedMs','errorType','errorCode','event','httpStatus','jobId','stage'].sort());
 for(const secret of [SHARED,KEY,env.GITHUB_ACTIONS_TOKEN,pulse.reply,phrase,ORIGIN]) assert.ok(!JSON.stringify(logs).includes(secret));
});

test('a failing logging sink cannot turn an accepted dispatch into another send',async()=>{
 const {env}=setup();let sends=0;
 const worker=createWorker({now:()=>NOW,log(){throw Error('sink failed');},fetchImpl:async()=>{sends++;return new Response(null,{status:204});}});
 assert.equal((await worker.fetch(signed(),env)).status,202);
 assert.equal((await worker.fetch(signed(),env)).status,202);
 assert.equal(sends,1);
});

test('known runtime error messages map to fixed diagnostic codes without raw content',async()=>{
 for(const [message,code] of [['Illegal invocation: '+SHARED,'invalid_this'],['Cannot convert secret to ByteString '+KEY,'invalid_header'],['Cannot perform I/O on behalf of a different request '+SHARED,'io_context']]){
  const {worker,env,logs}=setup(()=>{throw new TypeError(message);});
  assert.equal((await worker.fetch(signed(),env)).status,502);assert.equal(logs[0].errorCode,code);
  assert.ok(!JSON.stringify(logs).includes(SHARED));assert.ok(!JSON.stringify(logs).includes(KEY));
 }
});

test('Worker uses supported redirect mode when the transport enforces Cloudflare Request semantics',async()=>{
 const {worker,env,calls}=setup((url,options)=>{
  if(options.redirect==='error')throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
  assert.equal(options.redirect,'manual');return new Response(null,{status:204});
 });
 assert.equal((await worker.fetch(signed(),env)).status,202);
 assert.equal(calls.length,1);
 assert.equal(env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'dispatched');
});

test('manual redirect mode rejects GitHub and course redirects without following Location',async()=>{
 const github=setup(()=>new Response(null,{status:302,headers:{location:'https://other.example/leak'}}));
 assert.equal((await github.worker.fetch(signed(),github.env)).status,502);
 assert.equal(github.calls.length,1);assert.equal(github.env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'dispatch_failed');
 const course=setup(url=>new Response(null,{status:url.startsWith(ORIGIN)?302:204,headers:{location:'https://other.example/leak'}}));
 await course.worker.fetch(signed(),course.env);const id=JSON.parse(course.calls[0].options.body).inputs.job_id;
 await course.worker.fetch(internal(`/internal/jobs/${id}`),course.env);
 assert.equal((await course.worker.fetch(internal(`/internal/jobs/${id}/result`,'run-1',{text:'pulse stopped: tracker unavailable'}),course.env)).status,502);
 assert.equal(course.calls.length,2);assert.equal(course.calls[1].options.redirect,'manual');
 assert.equal(course.env.INBOX.sql.prepare('SELECT state FROM jobs').get().state,'reply_rejected');
 assert.ok([...github.calls,...course.calls].every(c=>!c.url.startsWith('https://other.example')));
});
