import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAgent} from '../src/runner.mjs';
const id='11111111-1111-4111-8111-111111111111';
const course='https://course.example';
const env={LIVE_EXECUTION_ENABLED:'true',JOB_ID:id,RUNNER_ID:'1-1',AGENT_ORIGIN:'https://agent.example',RUNNER_SHARED_KEY:'x'.repeat(48),GEMINI_API_KEY:'synthetic-model-key',PULSE_MODEL:'model-small',TEST_MODEL:'model-writer'};
const issue={number:7,title:'Digest row missing',state:'open',by:'maintainer',body:'Retain each valid row.',comments:[],labels:[]};
const context={plan:'---\nowner: maintainer\n---\nDigest issue #7',history:[],testInstructions:'Vitest with one regression test. Supplied fixtures are read-only.',tests:{},repoFiles:{}};
test('disabled controller makes no network calls',async()=>{
 let requests=0;await assert.rejects(()=>runAgent({env:{...env,LIVE_EXECUTION_ENABLED:'false'},fetchImpl:async()=>{requests++;}}),/disabled/);assert.equal(requests,0);
});
test('pulse controller completes one model call, rereads tracker and posts only to Worker',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url==='https://agent.example/internal/jobs/'+id) return Response.json({id,ping:{kind:'pulse',phrase:'new value',tracker:course+'/rig/tracker/issues'},courseOrigin:course,context});
  if(url===course+'/rig/tracker/issues') return Response.json({issues:[issue]});
  if(url.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({issue:7,recommendation:'Add a regression for valid rows.'})}]}}]});
  if(url==='https://agent.example/internal/jobs/'+id+'/result') {
   assert.deepEqual(Object.keys(JSON.parse(options.body)),['text']);return Response.json({state:'received'});
  }
  throw Error('unexpected URL');
 };
 assert.deepEqual(await runAgent({env,fetchImpl}),{completed:true,kind:'pulse',outcome:'recommendation'});
 assert.equal(calls.filter(x=>x.url.startsWith('https://generativelanguage.googleapis.com/')).length,1);
 assert.equal(calls.filter(x=>x.url===course+'/rig/tracker/issues').length,2);
 assert.ok(!calls.some(x=>x.url.startsWith(course)&&x.options.method==='POST'));
 for(const call of calls.filter(x=>!x.url.startsWith('https://generativelanguage.googleapis.com/'))) assert.ok(!JSON.stringify(call.options).includes(env.GEMINI_API_KEY));
});
test('failed result records failure without resending course answer or model request',async()=>{
 let model=0,posts=0,failures=0;
 const fetchImpl=async(url,options)=>{
  if(url==='https://agent.example/internal/jobs/'+id) return Response.json({id,ping:{kind:'pulse',phrase:'' ,tracker:course+'/rig/tracker/issues'},context,courseOrigin:course});
  if(url===course+'/rig/tracker/issues') return Response.json({issues:[issue]});
  if(url.endsWith('/result')) {posts++;throw Error('uncertain response');}
  if(url.endsWith('/failed')) {failures++;return Response.json({state:'stopped'});}
  model++;throw Error('unexpected model request');
 };
 await assert.rejects(()=>runAgent({env,fetchImpl}),/stopped/);
 assert.equal(model,0);assert.equal(posts,1);assert.equal(failures,1);
});
