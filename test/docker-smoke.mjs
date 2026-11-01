// Synthetic self-test only. No model, course source, key, reply or tracker is used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {runRedTest} from '../src/sandbox.mjs';
const controllerWarnings=[];
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
    let log='';
    child.stderr?.on('data',chunk=>{
      const remaining=32_000-emitted;
      if(remaining>0) { const part=Buffer.from(chunk).subarray(0,remaining); process.stderr.write(part); log+=part.toString('utf8'); emitted+=part.length; }
    });
    child.once('close',()=>{
      if(/Failed to terminate forks worker|Timeout terminating forks worker/.test(log)) controllerWarnings.push('fork teardown failed');
      if(/Both esbuild and oxc options were set/.test(log)) controllerWarnings.push('JSX configuration ignored');
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
await assert.rejects(()=>runRedTest({...options,files:{'src/items.ts':'export function items(){return [1]}'}}),/no failing test measured/);
await assert.rejects(()=>runRedTest({...options,files:{'src/items.ts':'this is not valid TypeScript {'}}));
// Test code must actually run as the unprivileged user, not as its trusted reporter.
const uidArtifact={path:'test/uid-boundary.test.ts',test:`import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {items} from '../src/items.js';
it('runs outside trusted reporter identity',()=>{
 const capabilities=readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(\\w+)$/m)?.[1];
 if(process.getuid()!==65532 || capabilities!=='0000000000000000') throw new Error('execution identity boundary failed');
 expect(items()).toHaveLength(1);
});`};
await runRedTest({...options,testArtifact:uidArtifact,files:{'src/items.ts':'export function items(){return []}'}});
// JSX must use the installed Hono runtime, including when no project tsconfig exists.
const jsxArtifact={path:'test/jsx-runtime.test.ts',test:`import {it,expect} from 'vitest';
import {render} from '../src/view.js';
it('renders the requested content',()=>expect(render()).toBe('<p>changed</p>'));`};
await runRedTest({...options,testArtifact:jsxArtifact,files:{'src/view.tsx':'export function render(){return (<p>ready</p>).toString()}'}});
await assert.rejects(()=>runRedTest({...options,testArtifact:jsxArtifact,files:{'src/view.tsx':'export function render(){return (<p>changed</p>).toString()}'}}),/no failing test measured/);
// A generated file cannot replace the trusted reporter's result then exit 1.
const forged={numTotalTests:1,numFailedTests:1,numPassedTests:0,success:false,testResults:[{name:'/work/test/forged-report.test.ts',status:'failed',assertionResults:[{status:'failed',failureMessages:['AssertionError: expected true to be false']}]}]};
const forgedArtifact={path:'test/forged-report.test.ts',test:`import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs'; import {items} from '../src/items.js';
it('attempts report forgery',()=>{ writeFileSync('/report/result.json',${JSON.stringify(JSON.stringify(forged))}); process.exit(1); });`};
await assert.rejects(()=>runRedTest({...options,testArtifact:forgedArtifact,files:{'src/items.ts':'export function items(){return []}'}}));
assert.deepEqual(controllerWarnings,[],'controller teardown and JSX configuration must be clean');
// Regressions for removed acceptance restrictions: dotted/nested filename,
// dynamic imports, a source above 16KB, and multiple cases for one behavior.
const expanded={path:'test/nested/dotted.owner.test.ts',test:`import {it,expect} from 'vitest';
it.each([1,2])('retains a valid item case %s',async()=>{
 const {items}=await import('../../src/items.js');
 expect(items()).toHaveLength(1);
});
/*${'synthetic padding '.repeat(1000)}*/`};
const expandedMeasured=await runRedTest({...options,testArtifact:expanded,files:{'src/items.ts':'export function items(){return []}'}});
assert.equal(expandedMeasured.evidence.assertionFailures,2);
console.log('Docker self-test passed: red and JSX red accepted; green, syntax failure and reporter forgery rejected; UID and capabilities isolated; controller teardown clean.');
