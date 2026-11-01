import {diagnosticError,preserveDiagnostic} from './diagnostics.mjs';
const API_ROOT='https://generativelanguage.googleapis.com/v1beta/models/';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function wait(ms,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(Error('aborted'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}
function retryAfter(value,now){
  if(!value)return 0;
  const seconds=Number(value);
  return Number.isFinite(seconds)&&seconds>=0?seconds*1000:Math.max(0,Date.parse(value)-now)||0;
}

// Retry only the provider request within the owner's five-minute deadline.
// No fallback, billing changes or retries of course replies/claims/dispatch.
export function createGeminiClient({apiKey,models,fetchImpl=fetch,timeoutMs=300_000,delay=wait,now=Date.now,random=Math.random,report=()=>{},retryTransient=true}={}){
  const timeouts=typeof timeoutMs==='number'?{pulse:timeoutMs,test:timeoutMs}:timeoutMs;
  if(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n]/.test(apiKey)||!record(models)||
    !['pulse','test'].every(kind=>/^[a-z0-9][a-z0-9._-]*$/.test(models[kind]??''))||
    !record(timeouts)||!['pulse','test'].every(kind=>Number.isSafeInteger(timeouts[kind])&&timeouts[kind]>0)||typeof fetchImpl!=='function')throw Error('invalid model configuration');
  const configuredModels={pulse:models.pulse,test:models.test},configuredTimeouts={...timeouts};
  return async function generate({kind,system,data,schema}={}){
    if(!['pulse','test'].includes(kind)||typeof system!=='string'||!system.trim()||!record(data)||schema!==undefined&&!record(schema))throw Error('invalid generation input');
    const generationConfig=schema?{responseFormat:{text:{mimeType:'APPLICATION_JSON',schema}}}:{responseMimeType:'application/json'};
    let body;try{body=JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:JSON.stringify({untrustedEvidence:data})}]}],generationConfig});}catch{throw Error('invalid generation input');}
    const controller=new AbortController(),deadline=now()+configuredTimeouts[kind];
    const timer=setTimeout(()=>controller.abort(),configuredTimeouts[kind]);
    let attempt=0;
    const pause=async(status,header)=>{
      const backoff=Math.min(60_000,1000*2**Math.min(attempt-1,16));
      const delayMs=Math.max(retryAfter(header,now()),Math.round(backoff*(0.5+random())));
      if(delayMs>=deadline-now()||controller.signal.aborted)throw diagnosticError('model generation failed',status?'model_http_error':'model_transport_error',{httpStatus:status});
      try{report({event:'model_retry',attempt,...(status?{httpStatus:status}:{}),delayMs});}catch{}
      await delay(delayMs,controller.signal);
    };
    try{
      for(;;){
        if(controller.signal.aborted||now()>=deadline)throw diagnosticError('model generation failed','model_timeout');
        attempt++;
        let response;
        try{response=await fetchImpl(API_ROOT+configuredModels[kind]+':generateContent',{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-goog-api-key':apiKey},body});}
        catch(error){
          if(controller.signal.aborted)throw diagnosticError('model generation failed','model_timeout');
          if(!retryTransient)throw diagnosticError('model generation failed','model_transport_error');
          await pause(undefined,null);continue;
        }
        if(!response.ok){
          const status=response.status,header=response.headers.get('retry-after');
          await response.body?.cancel().catch(()=>{});
          if(retryTransient&&(status===408||status===429||status>=500&&status<=599)){await pause(status,header);continue;}
          throw diagnosticError('model generation failed','model_http_error',{httpStatus:status});
        }
        let result;try{result=await response.json();}catch(error){throw preserveDiagnostic(error,'model generation failed','model_invalid_response');}
        if(record(result)&&result.promptFeedback?.blockReason)throw diagnosticError('model generation failed','model_blocked');
        if(!record(result)||!Array.isArray(result.candidates)||result.candidates.length!==1)throw diagnosticError('model generation failed','model_invalid_response');
        const candidate=result.candidates[0];
        if(record(candidate)&&candidate.finishReason!=='STOP')throw diagnosticError('model generation failed','model_incomplete',{finishReason:candidate.finishReason});
        if(!record(candidate)||!Array.isArray(candidate.content?.parts)||!candidate.content.parts.length||candidate.content.parts.some(part=>!record(part)||typeof part.text!=='string'))throw diagnosticError('model generation failed','model_invalid_response');
        const answerText=candidate.content.parts.filter(part=>part.thought!==true).map(part=>part.text).join('');
        let answer;try{answer=JSON.parse(answerText);}catch{throw diagnosticError('model generation failed','model_invalid_response');}
        if(!record(answer))throw diagnosticError('model generation failed','model_invalid_response');
        return answer;
      }
    }catch(error){
      if(controller.signal.aborted)throw diagnosticError('model generation failed','model_timeout');
      throw preserveDiagnostic(error,'model generation failed','model_transport_error');
    }finally{clearTimeout(timer);}
  };
}
