import {readTracker,chooseRelevantIssue,buildPulse,generateTest,stopPulse} from './agents.mjs';
import {validateAnswer} from './protocol.mjs';

// No network tools are exposed to the model. URLs and transport are controlled here.
export async function processJob(job,{generate,runRedTest,fetchImpl=fetch,onStage=()=>{}}) {
  const {ping,context,courseOrigin}=job;
  onStage('tracker');
  const trackerURL=ping.kind==='pulse'?ping.tracker:`${courseOrigin}/rig/tracker/issues`;
  let issues;
  try { issues=await readTracker(trackerURL,{fetchImpl,courseOrigin}); }
  catch {
    if (ping.kind==='pulse') return stopPulse('tracker_unavailable');
    throw new Error('test tracker unavailable');
  }
  if (ping.kind==='pulse') {
    onStage('pulse_generation');
    const answer=await buildPulse({ping,context,issues,generate});
    if (answer.text.startsWith('pulse stopped:')) return answer;
    const selected=chooseRelevantIssue(issues,context.plan);
    let latest;
    try { latest=await readTracker(trackerURL,{fetchImpl,courseOrigin}); }
    catch { return stopPulse('tracker_unavailable_before_reply'); }
    if (!selected || !latest.some(issue=>issue.number===selected.number && issue.state==='open')) {
      return stopPulse('issue_no_longer_open');
    }
    return validateAnswer(ping,answer);
  }
  if (ping.kind!=='test') throw new Error('unknown agent kind');
  onStage('test_selection');
  const issue=issues.find(item=>item.number===ping.issue && item.state==='open');
  // The authenticated test ping names the issue; its author grants no authority.
  const eligible=issue;
  if (!eligible) throw new Error('test issue not eligible');
  onStage('test_generation');
  const artifact=await generateTest({ping,context,issue:eligible,generate});
  if (typeof runRedTest!=='function') throw new Error('isolated runner unavailable');
  onStage('sandbox');
  const measured=await runRedTest({files:ping.files,repoFiles:context.repoFiles,testArtifact:artifact});
  onStage('answer_validation');
  if (typeof measured?.red!=='string' || !measured.red || /[\r\n]/.test(measured.red)) throw new Error('no measured red evidence');
  return validateAnswer(ping,{...artifact,red:measured.red});
}
