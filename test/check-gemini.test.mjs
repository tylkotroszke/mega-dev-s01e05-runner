import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkGemini} from '../src/check-gemini.mjs';
import {MODELS,WORKER,FILES} from '../src/check-fixture.mjs';
const key='synthetic-key-not-real';
const env={GEMINI_CHECK_APPROVED:'true',GITHUB_REF:'refs/tags/gemini-check-v1',LIVE_EXECUTION_ENABLED:'false',AGENT_ORIGIN:WORKER,PULSE_MODEL:MODELS.pulse,TEST_MODEL:MODELS.test,GEMINI_API_KEY:key};
const artifact={path:'test/synthetic_visibility.test.ts',test:"import {it,expect} from 'vitest'; import {visibleJobs} from '../src/jobs.js'; it('retains unassigned jobs',()=>expect(visibleJobs([{id:'alpha',owner:'Ada'},{id:'beta',owner:'unassigned'}])).toEqual(['alpha','beta']));"};
function dependencies({enabled=false,rejectModel=false,red=true}={}){
 const calls={public:[],model:[],measured:[]};return {calls,
 publicFetch:async(url,options)=>{calls.public.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);return Response.json(url.endsWith('/health')?{ok:true,enabled}:{owner:'own-synthetic',agents:{pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}});},
 modelFetch:async(url,options)=>{calls.model.push({url,options});assert.equal(options.headers['x-goog-api-key'],key);assert.equal(options.body.includes(key),false);const body=JSON.parse(options.body);assert.equal(Object.hasOwn(body,'tools'),false);if(rejectModel)return new Response('credential echoed: '+key,{status:429,headers:{'retry-after':'3600'}});return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(calls.model.length===1?{issue:7,recommendation:'Add a regression test retaining unassigned jobs.'}:artifact)}]}}]});},
 measure:async(options)=>{calls.measured.push(options);assert.deepEqual(options.files,FILES);assert.equal(options.image,'signed-test-toolchain:local');assert.deepEqual(options.testArtifact,artifact);if(!red)throw new Error('no single failing test measured');return {red:'One assertion failed.',baseHash:'synthetic-hash',evidence:{exitCode:1,assertionFailures:1}};}
 };
}
test('two reviewed synthetic requests exercise real adapters and require independent measurement',async()=>{
 const d=dependencies();const result=await checkGemini({env,...d});assert.equal(result.modelCalls,2);assert.equal(result.workerEnabled,false);assert.equal(d.calls.measured.length,1);assert.equal(JSON.stringify(result).includes(key),false);assert.equal(d.calls.model[0].url.endsWith(MODELS.pulse+':generateContent'),true);assert.equal(d.calls.model[1].url.endsWith(MODELS.test+':generateContent'),true);
});
test('live flag, main branch, missing approval and wrong origin stop before any request',async()=>{
 for(const change of [{LIVE_EXECUTION_ENABLED:'true'},{GITHUB_REF:'refs/heads/main'},{GEMINI_CHECK_APPROVED:'false'},{AGENT_ORIGIN:'https://other.example'}]){const d=dependencies();await assert.rejects(checkGemini({env:{...env,...change},...d}));assert.equal(d.calls.public.length+d.calls.model.length,0);}
});
test('enabled public Worker stops before using the model credential',async()=>{
 const d=dependencies({enabled:true});await assert.rejects(checkGemini({env,...d}),/Worker must be disabled/);assert.equal(d.calls.model.length,0);
});
test('quota denial stops after one model call without retry, fallback or measurement',async()=>{
 const d=dependencies({rejectModel:true});await assert.rejects(checkGemini({env,...d}),error=>!error.message.includes(key));assert.equal(d.calls.model.length,1);assert.equal(d.calls.measured.length,0);
});
test('generated source alone never passes when sandbox reports no assertion red',async()=>{
 const d=dependencies({red:false});await assert.rejects(checkGemini({env,...d}),/no single failing test/);assert.equal(d.calls.model.length,2);assert.equal(d.calls.measured.length,1);
});
