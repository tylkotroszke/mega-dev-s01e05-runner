import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox, validateTestArtifact, runRedTest } from '../src/sandbox.mjs';
import { installUnprivilegedChildren, controllerArguments, classifyControllerFailure } from '../src/trusted-bootstrap.mjs';

const artifact = { path: 'test/value.test.ts', test: "import { value } from '../src/value.js';\nimport { expect, it } from 'vitest';\nit('keeps a value', () => expect(value()).toBe(2));\n" };
const files = { 'src/value.ts': 'export const value = () => 1;\n' };
const repoFiles = { 'src/value.ts': 'export const value = () => 9;\n', 'runs/example.jsonl': '{"value":1}\n' };

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function report(overrides = {}) {
  return { success: false, numTotalTests: 1, numFailedTests: 1, numPassedTests: 0, numPendingTests: 0,
    testResults: [{ name: '/work/test/value.test.ts', status: 'failed', assertionResults: [{ status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\nPRIVATE_SOURCE_SNIPPET'] }] }], ...overrides };
}

function dockerMock(makeReport = report, { code = 1, output = '', hang = false, mutate = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const process = new EventEmitter();
    process.stdout = new PassThrough(); process.stderr = new PassThrough();
    process.kill = () => { process.emit('close', null, 'SIGKILL'); return true; };
    queueMicrotask(async () => {
      if (args[0] !== 'run') { process.emit('close', 0, null); return; }
      if (hang) return;
      try {
        if (output) process.stdout.emit('data', Buffer.from(output));
        if (mutate) {
          const sourceMount = args.find((arg) => arg.startsWith('type=bind,source=') && arg.endsWith(',target=/work/src,readonly'));
          const source = sourceMount.slice('type=bind,source='.length, -',target=/work/src,readonly'.length);
          await writeFile(join(source, 'value.ts'), 'changed');
        }
        const value = makeReport();
        if (value !== undefined) process.stdout.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
        process.emit('close', code, null);
      } catch { process.emit('error', new Error('fixture process failed')); }
    });
    return process;
  };
  return { spawnImpl, calls };
}

test('artifact must be a new top-level TypeScript test importing source', () => {
  assert.deepEqual(validateTestArtifact(artifact), artifact);
  for (const path of ['../test/x.test.ts', '/test/x.test.ts', 'test/../src/x.test.ts', 'test\\x.test.ts', 'test/constructor/x.test.ts', 'src/x.test.ts', 'test/x.ts', 'test/con.test.ts']) {
    assert.throws(() => validateTestArtifact({ ...artifact, path }));
  }
  assert.throws(() => validateTestArtifact({ ...artifact, test: "throw new Error('fail')" }));
  assert.throws(() => validateTestArtifact({ ...artifact, red: 'invented failure' }));
  assert.throws(() => validateTestArtifact({ ...artifact, test: artifact.test + ' '.repeat(16_001) }));
});

test('base uses exact ping files over repo copy, with an independently hashed immutable snapshot', async (t) => {
  const root = await temp(t);
  const prepared = await prepareSandbox({ root, files, repoFiles, testArtifact: artifact });
  assert.equal(await readFile(join(prepared.baseDir, 'src/value.ts'), 'utf8'), files['src/value.ts']);
  assert.equal(await readFile(join(prepared.baseDir, artifact.path), 'utf8'), artifact.test);
  assert.equal(prepared.filesCount, 2);
  const second = await prepareSandbox({ root, files: { ...files }, repoFiles, testArtifact: artifact });
  assert.equal(second.baseHash, prepared.baseHash);
  const third = await prepareSandbox({ root, files: { 'src/value.ts': 'different source' }, repoFiles, testArtifact: artifact });
  assert.notEqual(third.baseHash, prepared.baseHash);
});

test('rejects traversal, prototype keys, dependencies, non-text, oversized and ambiguous files', async (t) => {
  const root = await temp(t);
  const bad = [
    { '../outside.ts': 'x' }, { 'src/../outside.ts': 'x' }, { 'src\\evil.ts': 'x' },
    { 'src/constructor/x.ts': 'x' }, { 'src/__proto__/x.ts': 'x' }, { 'src/a.ts': null },
    { 'src/a.ts': 'a'.repeat(150_001) }, { 'package.json': '{}' }, { 'src/a.ts': 'a\0b' },
    { 'src/A.ts': 'a', 'src/a.ts': 'b' },
  ];
  for (const badFiles of bad) await assert.rejects(prepareSandbox({ root, files: badFiles, testArtifact: artifact }));
  await assert.rejects(prepareSandbox({ root, files, repoFiles: { [artifact.path]: 'existing' }, testArtifact: artifact }), /overwrite/);
  await assert.rejects(prepareSandbox({ root, files: Object.create({ injected: true }), testArtifact: artifact }));
});

test('rejects a symlink root if the platform permits creating one', async (t) => {
  const root = await temp(t);
  await mkdir(join(root, 'real'));
  try { await symlink(join(root, 'real'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('no local symlink permission'); return; } throw error; }
  await assert.rejects(prepareSandbox({ root: join(root, 'link'), files, testArtifact: artifact }), /real directory|symlink/);
});

test('measures a real-report shape, enforces Docker boundaries and returns only sanitized evidence', async (t) => {
  const root = await temp(t);
  const fake = dockerMock();
  const result = await runRedTest({ root, files, repoFiles, testArtifact: artifact, spawnImpl: fake.spawnImpl });
  assert.equal(result.evidence.exitCode, 1);
  assert.equal(result.evidence.assertionFailures, 1);
  assert.match(result.baseHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SOURCE_SNIPPET'), false);
  assert.equal(Object.hasOwn(result, 'stdout'), false);
  const call = fake.calls.find((entry) => entry.args[0] === 'run');
  assert.equal(call.command, 'docker'); assert.equal(call.options.shell, false);
  for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--security-opt=no-new-privileges', '--user=0:0', '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--log-driver=none']) assert.ok(call.args.includes(flag), flag);
  assert.ok(call.args.filter((arg) => arg.startsWith('type=bind,')).filter((arg) => arg.includes('target=/work/')).every((arg) => arg.endsWith(',readonly')));
  assert.equal(call.args.some((arg) => arg.includes('docker.sock')), false);
  assert.equal(call.args.some((arg) => arg.startsWith('type=bind,') && arg.endsWith('target=/report')), false);
  assert.ok(call.args.includes('/report:rw,noexec,nosuid,nodev,size=1048576,uid=0,gid=0,mode=0700'));
  assert.ok(call.args.some((arg) => arg.includes('/opt/toolchain/trusted-bootstrap.mjs')));
  assert.equal(call.args.some((arg) => arg.startsWith('--env')), false);
  assert.ok(Object.keys(call.options.env).every((key) => ['PATH', 'Path', 'SystemRoot', 'WINDIR'].includes(key)));
  assert.ok(fake.calls.some((entry) => entry.args[0] === 'rm'));
});

test('trusted bootstrap forces fork/spawn/execFile children to nonroot and synchronizes ESM bindings', () => {
  const calls = [];
  const api = Object.fromEntries(['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync'].map((name) => [name, (...args) => { calls.push({ name, args }); return name; }]));
  let synced = 0;
  installUnprivilegedChildren({ api, syncExports: () => synced++ });
  const hostile = { uid: 0, gid: 0, shell: true, execPath: '/bad', env: { PATH: '/usr/bin', GEMINI_API_KEY: 'dummy-sensitive', NODE_OPTIONS: '--import=/bad', VITEST_WORKER_ID: '1', VITEST: 'true', TEST: 'true' } };
  assert.equal(api.spawn('node', ['worker.mjs'], hostile), 'spawn');
  api.spawnSync('node', hostile);
  api.fork('worker.mjs', [], hostile);
  api.execFile('node', ['worker.mjs'], hostile, () => {});
  api.execFile('node', () => {});
  api.execFileSync('node', hostile);
  for (const call of calls) {
    const options = call.args[2];
    assert.equal(options.uid, 65532); assert.equal(options.gid, 65532);
    assert.equal(options.shell, false);
    assert.equal(Object.hasOwn(options.env, 'GEMINI_API_KEY'), false);
    assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
  }
  assert.equal(calls.find((call) => call.name === 'fork').args[2].execPath, process.execPath);
  assert.equal(calls.find((call) => call.name === 'fork').args[2].env.VITEST, 'true');
  assert.equal(synced, 1);
  assert.throws(() => api.exec('arbitrary root shell'), /disabled/);
  assert.throws(() => api.execSync('arbitrary root shell'), /disabled/);
});

test('trusted static config uses native loader without widening write permissions', () => {
  const args = controllerArguments('test/value.test.ts', '10000');
  assert.ok(args.includes('--configLoader=native'));
  assert.ok(args.includes('--config=/opt/toolchain/vitest.config.mjs'));
  assert.ok(args.includes('--outputFile=/report/result.json'));
  assert.throws(() => controllerArguments('test/../src/evil.test.ts', '10000'));
  assert.throws(() => controllerArguments('test/value.test.ts', '10001'));
});

test('no-report diagnostics expose finite codes and process status, never raw controller data', async (t) => {
  const root = await temp(t);
  const input = "Error: EROFS read-only file system /opt/toolchain/node_modules/.vite-temp/config.mjs; token=PRIVATE_SECRET source=PRIVATE_SOURCE";
  const diagnostic = classifyControllerFailure(input, 1);
  assert.deepEqual(diagnostic, { sandboxFailure: { code: 'CONFIG_READ_ONLY', exitCode: 1 } });
  assert.equal(JSON.stringify(diagnostic).includes('PRIVATE'), false);
  const fake = dockerMock(() => diagnostic);
  await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl: fake.spawnImpl }), { message: 'sandbox failed before report: CONFIG_READ_ONLY (exit 1)' });
  const malicious = dockerMock(() => ({ sandboxFailure: { code: 'PRIVATE_SECRET', exitCode: 1, source: 'PRIVATE_SOURCE' } }));
  await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl: malicious.spawnImpl }), { message: 'sandbox failed before report: NO_REPORT (exit 1)' });
  assert.equal(classifyControllerFailure('EACCES opening /report/result.json', 1).sandboxFailure.code, 'REPORT_PERMISSION');
  assert.equal(classifyControllerFailure('Error without known category PRIVATE_SECRET', 2).sandboxFailure.code, 'NO_REPORT');
});

test('direct report-forgery topology is denied: only trusted controller owns the output directory', async (t) => {
  const root = await temp(t);
  const attack = { path: 'test/attack.test.ts', test: "import { value } from '../src/value.js';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('/report/result.json', JSON.stringify({success:false,numTotalTests:1,numFailedTests:1,numPassedTests:0}));\nprocess.exit(1);\n" };
  // This mock asserts the OS topology; actual denied-write Docker smoke is still
  // required. No synthetic result is treated as proof of a real permission denial.
  const fake = dockerMock(() => report({ numTotalTests: 0, numFailedTests: 0 }));
  await assert.rejects(runRedTest({ root, files, testArtifact: attack, spawnImpl: fake.spawnImpl }));
  const call = fake.calls.find((entry) => entry.args[0] === 'run');
  assert.ok(call.args.includes('/report:rw,noexec,nosuid,nodev,size=1048576,uid=0,gid=0,mode=0700'));
  assert.equal(call.args.filter((arg) => arg.startsWith('--cap-add=')).length, 2);
});

test('exit 1, syntax/import errors, absent reports and different tests are not accepted as red', async (t) => {
  const root = await temp(t);
  const invalid = [
    () => undefined,
    () => '{not json',
    () => report({ numTotalTests: 0 }),
    () => report({ success: true }),
    () => report({ numRuntimeErrorTestSuites: 1 }),
    () => report({ testResults: [{ name: '/work/test/other.test.ts', status: 'failed', assertionResults: [{ status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2'] }] }] }),
    ...['SyntaxError: expected a token to follow', 'Cannot find module', 'ReferenceError: item is not defined', 'TypeError: broken'].map((message) => () => report({ testResults: [{ name: '/work/test/value.test.ts', status: 'failed', assertionResults: [{ status: 'failed', failureMessages: [message] }] }] })),
  ];
  for (const make of invalid) {
    const fake = dockerMock(make);
    await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl: fake.spawnImpl }));
  }
  const green = dockerMock(report, { code: 0 });
  await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl: green.spawnImpl }), /failing test/);
});

test('excessive output aborts and never returns captured output', async (t) => {
  const root = await temp(t);
  const fake = dockerMock(report, { output: 'x'.repeat(64_001) });
  await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl: fake.spawnImpl }), /output exceeds/);
  assert.ok(fake.calls.some((entry) => entry.args[0] === 'rm'));
});

test('timeout removes the named container instead of leaving it running after CLI termination', async (t) => {
  const root = await temp(t);
  const fake = dockerMock(report, { hang: true });
  await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl: fake.spawnImpl, timeoutMs: 2_000 }), /timed out/);
  const run = fake.calls.find((entry) => entry.args[0] === 'run');
  const name = run.args[run.args.indexOf('--name') + 1];
  assert.ok(fake.calls.some((entry) => entry.args[0] === 'rm' && entry.args[2] === name));
});

test('unavailable Docker fails closed without a host execution fallback', async (t) => {
  const root = await temp(t);
  const spawnImpl = () => { throw new Error('Docker missing, secret text omitted'); };
  await assert.rejects(runRedTest({ root, files, testArtifact: artifact, spawnImpl }), /could not start/);
});

test('Docker smoke: a real assertion is measured but a direct forged report plus process exit is rejected', { skip: process.env.SANDBOX_DOCKER_SMOKE !== '1' }, async (t) => {
  const root = await temp(t);
  const image = process.env.SANDBOX_IMAGE || 'signed-test-toolchain:local';
  const result = await runRedTest({ root, files, testArtifact: artifact, image });
  assert.equal(result.evidence.assertionFailures, 1);
  const forged = report();
  const attack = {
    path: 'test/attack.test.ts',
    test: "import { value } from '../src/value.js';\nimport { writeFileSync } from 'node:fs';\ntry { writeFileSync('/report/result.json', " + JSON.stringify(JSON.stringify(forged)) + "); } catch {}\nprocess.exit(1);\n",
  };
  await assert.rejects(runRedTest({ root, files, testArtifact: attack, image }));
});
