// Synthetic self-test only. No model, course source, key, reply or tracker is used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {runRedTest} from '../src/sandbox.mjs';
// Diagnostic output is limited to this synthetic, secret-free self-test.
// Production runRedTest keeps its default spawn implementation and hidden logs.
function syntheticDiagnosticSpawn(command,args,options) {
  const diagnosticArgs=[...args];
  if(command==='docker' && args[0]==='run') {
    const shellIndex=args.indexOf('-c');
    if(shellIndex<0 || !args[shellIndex+1]?.includes('node /opt/toolchain/trusted-bootstrap.mjs')) throw new Error('unexpected self-test command');
    const marker='result=$?;';
    if(!args[shellIndex+1].includes(marker)) throw new Error('missing self-test status marker');
    diagnosticArgs[shellIndex+1]=args[shellIndex+1].replace(marker,marker+' cat /tmp/vitest-output >&2;');
  }
  const child=spawn(command,diagnosticArgs,options);
  if(command==='docker' && args[0]==='run') {
    let emitted=0;
    child.stderr?.on('data',chunk=>{
      const remaining=32_000-emitted;
      if(remaining>0) { const part=Buffer.from(chunk).subarray(0,remaining); process.stderr.write(part); emitted+=part.length; }
    });
  }
  return child;
}
const artifact={path:'test/retained-item.test.ts',test:`import {it,expect} from 'vitest';
import {items} from '../src/items.js';
it('retains a valid item',()=>expect(items()).toHaveLength(1));`};
const options={repoFiles:{},testArtifact:artifact,image:'signed-test-toolchain:local',spawnImpl:syntheticDiagnosticSpawn};
const measured=await runRedTest({...options,files:{'src/items.ts':'export function items(){return []}'} });
assert.equal(measured.evidence.exitCode,1);
assert.equal(measured.evidence.assertionFailures,1);
await assert.rejects(()=>runRedTest({...options,files:{'src/items.ts':'export function items(){return [1]}'}}),/no single failing test measured/);
await assert.rejects(()=>runRedTest({...options,files:{'src/items.ts':'this is not valid TypeScript {'}}));
// Test code must actually run as the unprivileged user, not as its trusted reporter.
const uidArtifact={path:'test/uid-boundary.test.ts',test:`import {it,expect} from 'vitest';
import {items} from '../src/items.js';
it('runs outside trusted reporter identity',()=>{ expect(typeof items).toBe('function'); expect(process.getuid()).toBe(0); });`};
await runRedTest({...options,testArtifact:uidArtifact,files:{'src/items.ts':'export function items(){return []}'}});
// A generated file cannot replace the trusted reporter's result then exit 1.
const forged={numTotalTests:1,numFailedTests:1,numPassedTests:0,success:false,testResults:[{name:'/work/test/forged-report.test.ts',status:'failed',assertionResults:[{status:'failed',failureMessages:['AssertionError: expected true to be false']}]}]};
const forgedArtifact={path:'test/forged-report.test.ts',test:`import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs'; import {items} from '../src/items.js';
it('attempts report forgery',()=>{ writeFileSync('/report/result.json',${JSON.stringify(JSON.stringify(forged))}); process.exit(1); });`};
await assert.rejects(()=>runRedTest({...options,testArtifact:forgedArtifact,files:{'src/items.ts':'export function items(){return []}'}}));
console.log('Docker self-test passed: red accepted; green, syntax failure and reporter forgery rejected; execution UID isolated.');
