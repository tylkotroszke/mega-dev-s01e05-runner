import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createGeminiClient} from './gemini.mjs';
import {buildPulse,generateTest} from './agents.mjs';
import {runRedTest} from './sandbox.mjs';
import {MODELS,WORKER,ISSUE,FILES,CONTEXT,PULSE,TEST} from './check-fixture.mjs';

async function publicJSON(url,fetchImpl){
 const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('Public Worker check failed');
 const reader=response.body.getReader();const chunks=[];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>4096)throw new Error('Public response exceeds limit');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Public Worker JSON invalid');}
}
export async function checkGemini({env=process.env,modelFetch=fetch,publicFetch=fetch,measure=runRedTest}={}){
 if(env.GEMINI_CHECK_APPROVED!=='true' || env.GITHUB_REF!=='refs/tags/gemini-check-v1' || env.LIVE_EXECUTION_ENABLED!=='false')throw new Error('Check gate closed');
 if(env.AGENT_ORIGIN!==WORKER || env.PULSE_MODEL!==MODELS.pulse || env.TEST_MODEL!==MODELS.test)throw new Error('Reviewed configuration differs');
 const expected=await Promise.all(['pulse','test'].map(kind=>readFile(new URL(`../requests/gemini-${kind}.json`,import.meta.url),'utf8').then(JSON.parse)));
 const health=await publicJSON(WORKER+'/health',publicFetch);
 const manifest=await publicJSON(WORKER+'/.well-known/mega-pulse.json',publicFetch);
 if(health.ok!==true || health.enabled!==false || !/^own-[A-Za-z0-9-]{1,100}$/.test(manifest.owner??'') || JSON.stringify(manifest.agents)!==JSON.stringify({pulse:{wakes:'pulse',may:['answer']},'test-writer':{wakes:'test',may:['test']}}))throw new Error('Worker must be disabled with reviewed rights');
 let calls=0;
 const guardedFetch=async(url,options)=>{
   const kind=calls===0?'pulse':'test';
   if(calls>=2 || url!==`https://generativelanguage.googleapis.com/v1beta/models/${MODELS[kind]}:generateContent` || options.method!=='POST' || options.redirect!=='error' || JSON.stringify(JSON.parse(options.body))!==JSON.stringify(expected[calls]))throw new Error('Request differs from reviewed synthetic body');
   calls++;return modelFetch(url,options);
 };
 const generate=createGeminiClient({apiKey:env.GEMINI_API_KEY,models:MODELS,fetchImpl:guardedFetch,maxCalls:2,timeoutMs:60000});
 const pulse=await buildPulse({ping:PULSE,context:CONTEXT,issues:[ISSUE],generate});
 if(pulse.text.startsWith('pulse stopped:') || !pulse.text.includes(PULSE.phrase) || !pulse.text.includes('#7 (open):'))throw new Error('Synthetic pulse failed');
 const artifact=await generateTest({ping:TEST,context:CONTEXT,issue:ISSUE,generate});
 const red=await measure({files:FILES,repoFiles:{},testArtifact:artifact,image:'signed-test-toolchain:local'});
 if(!red?.red || red.evidence?.exitCode!==1 || red.evidence?.assertionFailures!==1)throw new Error('No independently measured assertion red');
 return {pulseModel:MODELS.pulse,testModel:MODELS.test,modelCalls:calls,syntheticPulse:'pass',generatedTestSha256:createHash('sha256').update(artifact.test).digest('hex'),sandboxRed:'pass',baseHash:red.baseHash,workerEnabled:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await checkGemini()));}catch{console.error('Synthetic Gemini check stopped. No retry or fallback. Owner review required.');process.exitCode=1;}
}
