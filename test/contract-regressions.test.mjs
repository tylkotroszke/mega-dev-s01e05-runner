import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPulse,generateTest,pulseOutcome} from '../src/agents.mjs';
import {validatePing,validateAnswer,artifactFits,MEASURED_RED} from '../src/protocol.mjs';
import {validateTestArtifact} from '../src/sandbox.mjs';
import {runAgent} from '../src/runner.mjs';
import {readFile} from 'node:fs/promises';
const course='https://course.example';
const issue={number:7,title:'Digest rows',state:'open',by:'contributor',body:'Retain valid digest rows and owner labels.',labels:[],comments:[]};
const context={plan:'---\nowner: maintainer\n---\nDigest issue #7',history:[],testInstructions:'Vitest. One regression for real src.',tests:{}};
const ping={kind:'pulse',phrase:'synthetic phrase',tracker:course+'/rig/tracker/issues',reply:course+'/reply/synthetic'};
test('Docker build context includes both trusted controller and its shared protocol dependency',async()=>{
 const dockerfile=await readFile(new URL('../Dockerfile.test',import.meta.url),'utf8');
 const ignore=await readFile(new URL('../.dockerignore',import.meta.url),'utf8');
 assert.match(dockerfile,/COPY src\/trusted-bootstrap\.mjs src\/protocol\.mjs \/opt\/toolchain\//);
 assert.ok(ignore.split(/\r?\n/).includes('!src/protocol.mjs'));
});
test('benign shipped negation, UI label, no-close and URL are not rejected by word filters',async()=>{
 for(const recommendation of ['Add a regression ensuring open issues are never marked shipped.','Render the owner label for issue #7 in the digest row.','Do not close issue #7; add a regression.','Compare the URL https://example.org with the value rendered in the digest.']){
  const answer=await buildPulse({ping,context,issues:[issue],generate:async input=>{assert.deepEqual(Object.keys(input.schema.properties),['recommendation']);return {recommendation};}});
  assert.equal(answer.text,JSON.stringify(ping.phrase)+'\n#7 (open): '+recommendation);assert.deepEqual(pulseOutcome(answer),{outcome:'recommendation'});
 }
});
test('the course false-completion constraint still stops direct completed claims',async()=>{
 for(const recommendation of ['Already shipped.','This issue is now shipped.','#7 has been completed.']){
  const answer=await buildPulse({ping,context,issues:[issue],generate:async()=>({recommendation})});
  assert.equal(pulseOutcome(answer).code,'false_completion');assert.match(answer.text,/^pulse stopped:/);
 }
});
test('phrase 501 and recommendation above 1400 work up to the actual full reply limit',async()=>{
 const long={...ping,phrase:'p'.repeat(501)};
 const checked=validatePing(long,course);
 const prefix=JSON.stringify(long.phrase)+'\n#7 (open): ';
 const recommendation='r'.repeat(2000-prefix.length);
 const answer=await buildPulse({ping:checked,context,issues:[issue],generate:async()=>({recommendation})});
 assert.equal(answer.text.length,2000);assert.deepEqual(validateAnswer(long,answer),answer);
 const tooLong=await buildPulse({ping:checked,context,issues:[issue],generate:async()=>({recommendation:recommendation+'x'})});
 assert.equal(pulseOutcome(tooLong).code,'answer_too_long');
 const unicode=await buildPulse({ping:{...ping,phrase:'🙂 "x"'},context,issues:[issue],generate:async()=>({recommendation:'Retain the owner.\nAdd a regression.'})});
 assert.equal(unicode.text.includes(JSON.stringify('🙂 "x"')),true);validateAnswer({...ping,phrase:'🙂 "x"'},unicode);
});
test('test budget is identical in generator, protocol and sandbox, including dots and dynamic import',async()=>{
 const testPing={kind:'test',issue:7,files:{'src/row.ts':'export const row=()=>0;'}};
 for(const path of ['test/row.owner.test.ts','test/nested/row.owner.test.ts']){
  const source='import {it,expect} from "vitest"; it("retains",async()=>{const {row}=await import("../src/row.js");expect(row()).toBe(1);});/*'+'x'.repeat(16400)+'*/';
  const artifact={path,test:source};
  assert.equal(artifactFits(path,source),true);
  assert.deepEqual(await generateTest({ping:testPing,context,issue,generate:async()=>({...artifact,red:'Untrusted model claim ignored.'})}),artifact);
  assert.deepEqual(validateTestArtifact(artifact),artifact);validateAnswer(testPing,{...artifact,red:MEASURED_RED});
 }
 const path='test/boundary.test.ts';let source='import {it} from "vitest"; import {row} from "../src/row.js";';
 while(artifactFits(path,source+' '))source+=' ';
 validateTestArtifact({path,test:source});assert.equal(artifactFits(path,source+' '),false);
 assert.throws(()=>validateTestArtifact({path,test:source+' '}));
 await assert.rejects(generateTest({ping:testPing,context,issue,generate:async()=>({path,test:source+' '})}),/invalid generated test/);
});
test('missing tracker is delivered as stopped and reported separately from recommendation success',async()=>{
 const id='11111111-1111-4111-8111-111111111111',agent='https://agent.example';
 const noTracker={...ping};delete noTracker.tracker;
 const clean=validatePing(noTracker,course);assert.equal(clean.tracker,'');
 const {reply,...safePing}=clean;const events=[];let models=0,posts=0;
 const result=await runAgent({env:{LIVE_EXECUTION_ENABLED:'true',JOB_ID:id,RUNNER_ID:'synthetic',AGENT_ORIGIN:agent,RUNNER_SHARED_KEY:'synthetic'.repeat(8),GEMINI_API_KEY:'synthetic-model-key',PULSE_MODEL:'small-model',TEST_MODEL:'writer-model'},report:entry=>events.push(entry),fetchImpl:async(url,options)=>{
  if(url===`${agent}/internal/jobs/${id}`)return Response.json({id,ping:safePing,context,courseOrigin:course});
  if(url===`${agent}/internal/jobs/${id}/result`){posts++;assert.deepEqual(JSON.parse(options.body),{text:'pulse stopped: tracker unavailable'});return Response.json({state:'received'});}
  if(url.startsWith('https://generativelanguage.googleapis.com/'))models++;
  throw Error('No other network allowed');
 }});
 assert.equal(posts,1);assert.equal(models,0);assert.equal(result.outcome,'stopped');
 assert.deepEqual(events.find(x=>x.event==='agent_outcome'),{event:'agent_outcome',kind:'pulse',delivered:true,outcome:'stopped',code:'tracker_unavailable'});
});
