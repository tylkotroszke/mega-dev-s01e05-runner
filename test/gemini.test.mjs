import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGeminiClient} from '../src/gemini.mjs';
import {diagnosticDetails} from '../src/diagnostics.mjs';
const config={apiKey:'PRIVATE_KEY_SENTINEL',models:{pulse:'model-small',test:'model-writer'}};
const input={kind:'pulse',system:'Return JSON.',data:{topic:'synthetic'}};
const success=()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"recommendation":"Add a regression."}'}]}}]});
test('schema uses native REST responseFormat without an extra output or call quota',async()=>{
 let call;
 const schema={type:'object',properties:{recommendation:{type:'string'}},required:['recommendation'],additionalProperties:false};
 const generate=createGeminiClient({...config,fetchImpl:async(url,options)=>{call={url,options};return success();}});
 for(let i=0;i<8;i++)await generate({...input,schema});
 const body=JSON.parse(call.options.body);
 assert.deepEqual(body.generationConfig,{responseFormat:{text:{mimeType:'APPLICATION_JSON',schema}}});
 assert.equal(Object.hasOwn(body,'tools'),false);assert.equal(Object.hasOwn(body,'serviceTier'),false);
 assert.equal(call.url,'https://generativelanguage.googleapis.com/v1beta/models/model-small:generateContent');
 assert.equal(call.options.headers['x-goog-api-key'],config.apiKey);assert.equal(call.options.body.includes(config.apiKey),false);
});
test('503 and 429 retry with backoff and Retry-After on the same configured model',async()=>{
 let calls=0,time=0;const waits=[],events=[],urls=[];
 const generate=createGeminiClient({...config,now:()=>time,random:()=>0.5,delay:async ms=>{waits.push(ms);time+=ms;},report:entry=>events.push(entry),fetchImpl:async url=>{
   urls.push(url);calls++;
   if(calls===1)return new Response('PRIVATE_PROVIDER_BODY',{status:503});
   if(calls===2)return new Response(config.apiKey,{status:429,headers:{'retry-after':'3'}});
   return success();
 }});
 assert.deepEqual(await generate(input),{recommendation:'Add a regression.'});
 assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);assert.equal(new Set(urls).size,1);
 assert.equal(JSON.stringify(events).includes('PRIVATE'),false);assert.deepEqual(events.map(x=>x.httpStatus),[503,429]);
});
test('retry stops inside the total deadline instead of imposing an arbitrary call count',async()=>{
 let time=0,calls=0;
 const generate=createGeminiClient({...config,timeoutMs:4000,now:()=>time,random:()=>0.5,delay:async ms=>{time+=ms;},fetchImpl:async()=>{calls++;return new Response('PRIVATE',{status:503});}});
 await assert.rejects(generate(input),error=>diagnosticDetails(error).httpStatus===503);
 assert.equal(time,3000);assert.equal(calls,3);
});
test('permanent API failures and invalid response JSON never get an automatic retry',async()=>{
 for(const make of [()=>new Response('PRIVATE',{status:400}),()=>new Response('PRIVATE',{status:402}),()=>new Response('PRIVATE',{status:403}),()=>new Response('not JSON'),()=>Response.json({candidates:[{finishReason:'MAX_TOKENS'}]})]){
  let calls=0;const generate=createGeminiClient({...config,fetchImpl:async()=>{calls++;return make();}});
  await assert.rejects(generate(input),error=>!error.message.includes('PRIVATE'));assert.equal(calls,1);
 }
});
test('a long provider Retry-After does not sleep past the allowed deadline',async()=>{
 let calls=0;const generate=createGeminiClient({...config,timeoutMs:1000,delay:async()=>assert.fail('must not wait'),fetchImpl:async()=>{calls++;return new Response('PRIVATE',{status:429,headers:{'retry-after':'3600'}});}});
 await assert.rejects(generate(input),error=>diagnosticDetails(error).httpStatus===429);assert.equal(calls,1);
});
test('transport failures retry within deadline without exposing the exception',async()=>{
 let calls=0,time=0;
 const generate=createGeminiClient({...config,now:()=>time,delay:async ms=>{time+=ms;},fetchImpl:async()=>{if(++calls===1)throw Error(config.apiKey);return success();}});
 assert.deepEqual(await generate(input),{recommendation:'Add a regression.'});assert.equal(calls,2);
});
test('configuration cannot redirect model calls or send arbitrary input kinds',async()=>{
 for(const model of ['../model','https://evil.example','model?key=bad','model:method'])assert.throws(()=>createGeminiClient({...config,models:{pulse:model,test:'safe'}}),/invalid model configuration/);
 let calls=0;const generate=createGeminiClient({...config,fetchImpl:async()=>{calls++;return success();}});
 await assert.rejects(generate({...input,kind:'other'}),/invalid generation input/);assert.equal(calls,0);
});
test('the owner deadline aborts a pending request without leaking transport details',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const generate=createGeminiClient({...config,timeoutMs:300_000,fetchImpl:async(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error(config.apiKey)),{once:true}));}});
 const pending=assert.rejects(generate(input),error=>diagnosticDetails(error).code==='model_timeout'&&!error.message.includes(config.apiKey));
 t.mock.timers.tick(300_000);await pending;assert.equal(calls,1);
});
