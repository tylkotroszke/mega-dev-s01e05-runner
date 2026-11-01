import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGeminiClient} from '../src/gemini.mjs';
import {diagnosticDetails, diagnosticError} from '../src/diagnostics.mjs';
import {runAgent, MODEL_TIMEOUTS} from '../src/runner.mjs';

const config={apiKey:'PRIVATE_KEY_SENTINEL',models:{pulse:'model-small',test:'model-writer'}};
const input={kind:'test',system:'Return JSON.',data:{source:'PRIVATE_SOURCE_SENTINEL'}};
const artifact={path:'test/value.test.ts',test:"import {it,expect} from 'vitest'; import {value} from '../src/value'; it('retains',()=>expect(value()).toBe(2));"};
const success=()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(artifact)}]}}]});

test('writer accepts a four-minute response that the old 60-second deadline aborted',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const delayed=(_url,{signal})=>new Promise((resolve,reject)=>{
    setTimeout(()=>resolve(success()),240_000);
    signal.addEventListener('abort',()=>reject(Error(config.apiKey)),{once:true});
  });
  const old=createGeminiClient({...config,timeoutMs:60_000,fetchImpl:delayed});
  const failed=assert.rejects(old(input),error=>diagnosticDetails(error).code==='model_timeout');
  t.mock.timers.tick(60_000);await failed;
  const fixed=createGeminiClient({...config,timeoutMs:MODEL_TIMEOUTS,fetchImpl:delayed});
  const result=fixed(input);t.mock.timers.tick(240_000);
  assert.deepEqual(await result,artifact);
});

test('writer retains its finite deadline and does not restart a timed-out request',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const generate=createGeminiClient({...config,timeoutMs:MODEL_TIMEOUTS,fetchImpl:async(_url,{signal})=>{
    calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private transport '+config.apiKey)),{once:true}));
  }});
  const failed=assert.rejects(generate(input),error=>error.message==='model generation failed'&&diagnosticDetails(error).code==='model_timeout');
  t.mock.timers.tick(299_999);assert.equal(calls,1);
  t.mock.timers.tick(1);await failed;
  assert.equal(calls,1);
});

test('pulse uses the owner-approved five-minute deadline',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const generate=createGeminiClient({...config,timeoutMs:MODEL_TIMEOUTS,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private')),{once:true}))});
  const failed=assert.rejects(generate({...input,kind:'pulse'}),error=>diagnosticDetails(error).code==='model_timeout');
  t.mock.timers.tick(300_000);await failed;
});

test('safe metadata distinguishes HTTP, malformed JSON, truncation and transport without remote text',async()=>{
  const cases=[
    [()=>new Response('PRIVATE_RESPONSE '+config.apiKey,{status:429,headers:{'retry-after':'3600'}}),{code:'model_http_error',httpStatus:429}],
    [()=>new Response('PRIVATE_RESPONSE'),{code:'model_invalid_response'}],
    [()=>Response.json({candidates:[{finishReason:'MAX_TOKENS'}]}),{code:'model_incomplete',finishReason:'MAX_TOKENS'}],
    [()=>Response.json({candidates:[{finishReason:'PRIVATE_RESPONSE'}]}),{code:'model_incomplete'}],
    [()=>{throw Error(config.apiKey);},{code:'model_transport_error'}],
  ];
  for(const [response,expected] of cases){
    const generate=createGeminiClient({...config,timeoutMs:100,fetchImpl:async()=>response()});
    await assert.rejects(generate(input),error=>{
      assert.deepEqual(diagnosticDetails(error),expected);
      assert.equal(JSON.stringify(diagnosticDetails(error)).includes('PRIVATE_'),false);
      assert.equal(error.cause,undefined);return true;
    });
  }
});

const id='11111111-1111-4111-8111-111111111111',course='https://course.example';
const env={LIVE_EXECUTION_ENABLED:'true',JOB_ID:id,RUNNER_ID:'1-1',AGENT_ORIGIN:'https://agent.example',RUNNER_SHARED_KEY:'PRIVATE_SHARED_KEY_SENTINEL'.repeat(2),GEMINI_API_KEY:config.apiKey,PULSE_MODEL:'model-small',TEST_MODEL:'model-writer'};
const issue={number:7,title:'Retain value',state:'open',by:'maintainer',body:'Retain values',comments:[],labels:[]};
const context={plan:'---\nowner: maintainer\n---\nRetain value issue #7',history:[],testInstructions:'One Vitest test.',tests:{},repoFiles:{}};

async function runFailure({model=success,measure=async()=>({red:'Measured one failing assertion.'}),resultStatus=200,reportThrows=false}={}){
  const events=[],calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,method:options.method});
    if(url==='https://agent.example/internal/jobs/'+id)return Response.json({id,ping:{kind:'test',issue:7,files:{'src/value.ts':'PRIVATE_SOURCE_SENTINEL'}},context,courseOrigin:course});
    if(url===course+'/rig/tracker/issues')return Response.json({issues:[issue]});
    if(url.startsWith('https://generativelanguage.googleapis.com/'))return model();
    if(url.endsWith('/failed'))return Response.json({state:'runner_failed'});
    if(url.endsWith('/result'))return new Response(null,{status:resultStatus});
    throw Error('unexpected request');
  };
  await assert.rejects(runAgent({env,fetchImpl,measure,report:entry=>{events.push(entry);if(reportThrows)throw Error('PRIVATE_LOGGER');}}),/agent stopped/);
  const output=JSON.stringify(events);
  assert.equal(output.includes('PRIVATE_'),false);
  assert.equal(calls.filter(x=>x.url.startsWith('https://generativelanguage.googleapis.com/')).length,1);
  assert.equal(calls.filter(x=>x.url.endsWith('/failed')).length,1);
  assert.equal(calls.some(x=>x.url.startsWith(course)&&x.method==='POST'),false);
  return {failure:events.find(x=>x.event==='agent_failure'),calls};
}

test('runner preserves HTTP 429 through generation wrapper, reports no secrets and sends no answer',async()=>{
  const {failure,calls}=await runFailure({model:()=>new Response('PRIVATE_RESPONSE',{status:429,headers:{'retry-after':'3600'}})});
  assert.equal(failure.stage,'test_generation');assert.equal(failure.code,'model_http_error');assert.equal(failure.httpStatus,429);
  assert.equal(calls.some(x=>x.url.endsWith('/result')),false);
});

test('runner distinguishes rejected artifact, sandbox timeout and result failure without retry',async()=>{
  const invalid=await runFailure({model:()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"path":"PRIVATE_PATH","test":"PRIVATE_TEST"}'}]}}]})});
  assert.equal(invalid.failure.code,'invalid_generated_test');
  const sandbox=await runFailure({measure:async()=>{throw diagnosticError('private detail','sandbox_timeout');}});
  assert.equal(sandbox.failure.stage,'sandbox');assert.equal(sandbox.failure.code,'sandbox_timeout');
  const result=await runFailure({resultStatus:503,reportThrows:true});
  assert.equal(result.failure.stage,'result');assert.equal(result.failure.code,'result_failed');
  assert.equal(result.calls.filter(x=>x.url.endsWith('/result')).length,1);
});

test('an untrusted exception cannot inject diagnostic fields',()=>{
  assert.deepEqual(diagnosticDetails(Object.assign(Error('PRIVATE_ERROR'),{code:'model_timeout',httpStatus:429})),{code:'processing_failed'});
});
