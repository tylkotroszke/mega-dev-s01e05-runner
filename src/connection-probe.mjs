import {boundedText,equalSecret,hash} from './protocol.mjs';

export const PROBE_ID='6d795aa2-9807-4df1-9316-fc872fd439cd';
export const PROBE_REF='connection-check-v2';
export const PROBE_PATH='/internal/connection-probe';
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});

// This one-use diagnostic never leases course work, reads context, calls a
// model, or sends a course reply. All its states differ from normal jobs.
export async function handleConnectionProbe(request,env,{now,send}) {
 if(env.AUTONOMOUS_REPLIES_ENABLED!=='false')return json({error:'agents must be disabled'},403);
 if(typeof env.RUNNER_SHARED_KEY!=='string'||env.RUNNER_SHARED_KEY.length<32||
    !equalSecret(request.headers.get('authorization')?.replace(/^Bearer /,''),env.RUNNER_SHARED_KEY))return json({error:'unauthorized'},401);
 if(!env.INBOX||env.RUNNER_OWNER!=='tylkotroszke'||env.RUNNER_REPOSITORY!=='mega-dev-s01e05-runner')return json({error:'probe configuration differs'},503);
 const path=new URL(request.url).pathname;
 if(request.method==='GET'&&path===PROBE_PATH){
  const row=await env.INBOX.prepare('SELECT state,runner_id FROM jobs WHERE id=?').bind(PROBE_ID).first();
  return json({probeId:PROBE_ID,state:row?.state??'not_started',runnerId:row?.runner_id??null});
 }
 if(request.method!=='POST'||![PROBE_PATH,PROBE_PATH+'/lease',PROBE_PATH+'/result'].includes(path))return json({error:'method not allowed'},405);
 let body;
 try{body=JSON.parse(await boundedText(request,1024));}catch{return json({error:'invalid probe body'},400);}
 const result=path===PROBE_PATH+'/result';
 if(!body||body.probeId!==PROBE_ID||Object.keys(body).sort().join(',')!==(result?'ok,probeId':'probeId')||(result&&body.ok!==true))return json({error:'invalid probe body'},400);
 if(path===PROBE_PATH){
  if(typeof env.GITHUB_ACTIONS_TOKEN!=='string'||env.GITHUB_ACTIONS_TOKEN.length<8||/[\r\n]/.test(env.GITHUB_ACTIONS_TOKEN))return json({error:'dispatch secret unavailable'},503);
  // Exactly one admission for this public identifier, across all days.
  // Existing job counts do not impose a daily task quota.
  const created=await env.INBOX.prepare(`INSERT OR IGNORE INTO jobs(id,webhook_id,body_hash,payload,state,created)
   VALUES (?,?,?,NULL,'probe_dispatching',?) RETURNING id`)
   .bind(PROBE_ID,'connection-probe:'+PROBE_ID,await hash(JSON.stringify(body)),now()).first();
  if(!created)return json({error:'probe already used'},409);
  const outcome=await send(PROBE_ID,env,'check-connection.yml',PROBE_REF,{mode:'receive',job_id:PROBE_ID});
  const state=outcome.accepted?'probe_dispatched':outcome.status===null?'probe_uncertain':'probe_failed';
  try{await env.INBOX.prepare("UPDATE jobs SET state=? WHERE id=? AND state='probe_dispatching'").bind(state,PROBE_ID).run();}
  catch{console.log(JSON.stringify({event:'connection_probe',stage:'state_write_failed',httpStatus:outcome.status}));}
  return json({probeId:PROBE_ID,accepted:outcome.accepted},outcome.accepted?202:502);
 }
 const runner=request.headers.get('x-runner-id');
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(runner??''))return json({error:'invalid runner'},400);
 if(path===PROBE_PATH+'/lease'){
  const leased=await env.INBOX.prepare(`UPDATE jobs SET state='probe_leased',runner_id=? WHERE id=?
   AND state IN ('probe_dispatching','probe_dispatched') AND created>=? RETURNING id`)
   .bind(runner,PROBE_ID,now()-15*60000).first();
  return leased?json({probeId:PROBE_ID,diagnostic:true}):json({error:'probe not available'},409);
 }
 const completed=await env.INBOX.prepare("UPDATE jobs SET state='probe_completed' WHERE id=? AND state='probe_leased' AND runner_id=? RETURNING id").bind(PROBE_ID,runner).first();
 return completed?json({probeId:PROBE_ID,completed:true}):json({error:'probe not leased'},409);
}
