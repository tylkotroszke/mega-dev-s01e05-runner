import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, realpath, mkdir, mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {diagnosticError} from './diagnostics.mjs';
import {isTestPath,importsSource,artifactFits,MEASURED_RED} from './protocol.mjs';

// Constant shell program; the model-supplied path is only a validated positional argument.
const SANDBOX_COMMAND = 'node /opt/toolchain/trusted-bootstrap.mjs "$1" "$2" > /tmp/vitest-output 2>&1; result=$?; if [ -f /report/result.json ]; then cat /report/result.json; else node /opt/toolchain/trusted-bootstrap.mjs --diagnose "$result"; fi; exit "$result"';
const SAFE_FAILURE_CODES = new Set(['NO_REPORT', 'CONFIG_READ_ONLY', 'REPORT_PERMISSION', 'PERMISSION_DENIED', 'TOOLCHAIN_MODULE_MISSING', 'PROCESS_RESOURCE', 'SOURCE_TRANSFORM_FAILED', 'BOOTSTRAP_FAILED']);

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safePath(path) {
  if (typeof path !== 'string' || /[\\\u0000]/.test(path)) throw new Error('invalid sandbox path');
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('invalid sandbox path');
  if (!['src', 'test', 'runs'].includes(parts[0]) || parts.length < 2) throw new Error('sandbox path outside allowed roots');
  return path;
}

/** Validate only the artifact boundary; the OS sandbox enforces write limits. */
export function validateTestArtifact(value) {
  if (!plainRecord(value) || Object.keys(value).some((key) => !['path', 'test'].includes(key))) throw new Error('invalid test artifact');
  const { path, test } = value;
  safePath(path);
  if (!isTestPath(path)) throw new Error('test must be a new test/*.test.ts file');
  if (typeof test !== 'string' || !test.trim() || !artifactFits(path,test) || test.includes('\0')) throw new Error('invalid test source');
  if (!importsSource(test)) throw new Error('test must import src');
  return { path, test };
}

function mergedFiles(files, repoFiles) {
  if (!plainRecord(files) || !plainRecord(repoFiles)) throw new Error('invalid base files');
  const merged = new Map();
  for (const record of [repoFiles, files]) {
    for (const [path, text] of Object.entries(record)) {
      safePath(path);
      if (typeof text !== 'string' || text.includes('\0')) throw new Error('invalid base file');
      merged.set(path, text);
    }
  }
  if (!Object.keys(files).some((path) => path.startsWith('src/'))) throw new Error('ping must carry source base');
  // Portable case-folding prevents duplicate names on Windows and Linux differing.
  if (process.platform === 'win32' && new Set([...merged.keys()].map((path) => path.toLowerCase())).size !== merged.size) throw new Error('ambiguous base paths');
  return [...merged].sort(([a], [b]) => a.localeCompare(b));
}

function hashFiles(entries) {
  const hash = createHash('sha256');
  for (const [path, text] of entries) {
    hash.update(JSON.stringify([path, Buffer.byteLength(text)]));
    hash.update('\0'); hash.update(text); hash.update('\0');
  }
  return hash.digest('hex');
}

async function realDirectory(path) {
  const absolute = resolve(path);
  const entry = await lstat(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('sandbox root must be an existing real directory');
  const canonical = await realpath(absolute);
  const norm = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (norm(canonical) !== norm(absolute)) throw new Error('sandbox root contains a symlink');
  // Docker's --mount parser treats commas as separators, even without a shell.
  if (absolute.includes(',') || absolute.includes('\n') || absolute.includes('\r')) throw new Error('unsafe mount root');
  return absolute;
}

/** Copy the exact ping base over trusted read-only repo fixtures, never over source on disk. */
export async function prepareSandbox({ files, repoFiles = {}, testArtifact, root = tmpdir() }) {
  const artifact = validateTestArtifact(testArtifact);
  const entries = mergedFiles(files, repoFiles);
  if (entries.some(([path]) => path.toLowerCase() === artifact.path.toLowerCase())) throw new Error('test artifact must not overwrite a base file');
  const parent = await realDirectory(root);
  const jobRoot = await mkdtemp(join(parent, 'agent-test-'));
  const baseDir = join(jobRoot, 'project');
  const resultDir = join(jobRoot, 'report');
  try {
    await mkdir(baseDir, { mode: 0o755 });
    for (const directory of ['src', 'test', 'runs']) await mkdir(join(baseDir, directory), { mode: 0o755 });
    for (const [path, text] of [...entries, [artifact.path, artifact.test]]) {
      const target = resolve(baseDir, ...path.split('/'));
      if (!target.startsWith(baseDir + sep)) throw new Error('sandbox path escape');
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, text, { flag: 'wx', mode: 0o444 });
    }
    await mkdir(resultDir, { mode: 0o777 });
    await chmod(resultDir, 0o777);
    return { root: jobRoot, parent, baseDir, resultDir, artifact, baseHash: hashFiles(entries), filesCount: entries.length };
  } catch (error) {
    await rm(jobRoot, { recursive: true, force: true });
    throw error;
  }
}

function dockerArgs(prepared, name, image, timeoutMs) {
  return [
    'run', '--rm', '--pull=never', '--name', name,
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=KILL', '--user=0:0',
    '--ipc=none', '--log-driver=none',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,mode=1777',
    '--tmpfs', '/report:rw,noexec,nosuid,nodev,uid=0,gid=0,mode=0700',
    ...['src', 'test', 'runs'].flatMap((dir) => ['--mount', `type=bind,source=${join(prepared.baseDir, dir)},target=/work/${dir},readonly`]),
    '--workdir=/work', '--entrypoint=/bin/sh', image,
    '-c', SANDBOX_COMMAND, 'agent-test', prepared.artifact.path, String(timeoutMs - 1_000),
  ];
}

function minimalClientEnv() {
  return Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}

function execute(command, args, { spawnImpl, timeoutMs, onTimeout }) {
  return new Promise((resolveResult, reject) => {
    let child;
    let ended = false;
    let outputBytes = 0;
    const stdout = [];
    const finish = (error, result) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      if (error) reject(error); else resolveResult(result);
    };
    let timer;
    try { child = spawnImpl(command, args, { env: minimalClientEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { reject(new Error('sandbox process could not start')); return; }
    timer = setTimeout(() => {
      finish(diagnosticError('sandbox timed out', 'sandbox_timeout')); void onTimeout?.(); child.kill('SIGKILL');
    }, timeoutMs);
    for (const pipe of [child.stdout, child.stderr]) pipe?.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (pipe === child.stdout) stdout.push(Buffer.from(chunk));
    });
    child.once('error', () => finish(new Error('sandbox process failed')));
    child.once('close', (exitCode, signal) => finish(null, { exitCode, signal, outputBytes, stdout: Buffer.concat(stdout).toString('utf8') }));
  });
}

async function removeContainer(spawnImpl, name) {
  try { await execute('docker', ['rm', '--force', name], { spawnImpl, timeoutMs: 3_000 }); } catch { /* --rm or an unavailable daemon may already have removed it. */ }
}

function measureReport(report, path, exitCode) {
  if (!plainRecord(report) || exitCode !== 1 || report.success !== false || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 1 || !Number.isInteger(report.numFailedTests) || report.numFailedTests < 1) throw new Error('no failing test measured');
  if ((report.numRuntimeErrorTestSuites ?? 0) !== 0 || (report.numPendingTests ?? 0) !== 0 || (report.numTodoTests ?? 0) !== 0 || (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length)) throw new Error('test did not fail cleanly');
  if (!Array.isArray(report.testResults) || report.testResults.length !== 1) throw new Error('unexpected test report');
  const suite = report.testResults[0];
  if (!plainRecord(suite) || typeof suite.name !== 'string' || suite.name.replaceAll('\\', '/') !== `/work/${path}` || suite.status !== 'failed') throw new Error('report is not for generated test');
  if (!Array.isArray(suite.assertionResults) || suite.assertionResults.length !== report.numTotalTests) throw new Error('test report count differs');
  const failed = suite.assertionResults.filter(item=>item.status==='failed');
  if(failed.length!==report.numFailedTests)throw Error('inconsistent failed test count');
  for (const assertion of failed) {
  const messages = assertion?.failureMessages;
  if (assertion?.status !== 'failed' || !Array.isArray(messages) || !messages.length || messages.some((message) => typeof message !== 'string')) throw new Error('no failed assertion measured');
  const combined = messages.join('\n');
  if (/^(?:SyntaxError|ReferenceError|TypeError|Error: (?:Cannot find|Cannot resolve|Failed to resolve|ERR_MODULE|ENOENT|Transform failed|No test files|Unhandled Error))/im.test(combined)) throw new Error('infrastructure error is not behavioral red');
  if (!/\bAssertionError\b|\bexpected\b[\s\S]*?\bto\b/i.test(combined)) throw new Error('failure is not an assertion');
  }
  return { assertionFailures: failed.length };
}

/** No host execution fallback: a protected controller must report one failing test. */
export async function runRedTest({ files, repoFiles = {}, testArtifact, root = tmpdir(), spawnImpl = spawn, image = 'signed-agent-test:local', timeoutMs = 300_000, keepArtifacts = false } = {}) {
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9._/:@-]{0,200}$/.test(image)) throw new Error('invalid trusted sandbox image');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 300_000) throw new Error('invalid sandbox timeout');
  const prepared = await prepareSandbox({ files, repoFiles, testArtifact, root });
  const name = `agent-test-${randomUUID()}`;
  try {
    const processResult = await execute('docker', dockerArgs(prepared, name, image, timeoutMs), { spawnImpl, timeoutMs, onTimeout: () => removeContainer(spawnImpl, name) });
    if (processResult.signal) throw new Error('sandbox terminated without result');
    // The report lived on a private tmpfs inside the container. Never mount
    // a writable host directory for model-produced code to fill or modify.
    const text = processResult.stdout;
    if (!text) throw new Error(`invalid sandbox report (exit ${Number.isInteger(processResult.exitCode) ? processResult.exitCode : 'unknown'})`);
    let report;
    try { report = JSON.parse(text); } catch { throw new Error('invalid sandbox report JSON'); }
    if (plainRecord(report?.sandboxFailure)) {
      const failure = report.sandboxFailure;
      const code = SAFE_FAILURE_CODES.has(failure.code) ? failure.code : 'NO_REPORT';
      const exit = Number.isInteger(processResult.exitCode) ? processResult.exitCode : 'unknown';
      throw new Error(`sandbox failed before report: ${code} (exit ${exit})`);
    }
    const measurement = measureReport(report, prepared.artifact.path, processResult.exitCode);
    if (keepArtifacts) await writeFile(join(prepared.resultDir, 'validated-report.json'), text, { flag: 'wx', mode: 0o600 });
    const current = [];
    for (const [path] of mergedFiles(files, repoFiles)) current.push([path, await readFile(join(prepared.baseDir, ...path.split('/')), 'utf8')]);
    if (hashFiles(current) !== prepared.baseHash) throw new Error('base changed during test');
    return {
      red: MEASURED_RED,
      baseHash: prepared.baseHash,
      evidence: { runner: 'vitest-in-docker', testPath: prepared.artifact.path, exitCode: processResult.exitCode, ...measurement, reportHash: createHash('sha256').update(text).digest('hex') },
      ...(keepArtifacts ? { artifactsRoot: prepared.root } : {}),
    };
  } finally {
    await removeContainer(spawnImpl, name);
    if (!keepArtifacts) {
      const absolute = resolve(prepared.root);
      if (!absolute.startsWith(prepared.parent + sep)) throw new Error('unsafe sandbox cleanup target');
      await rm(absolute, { recursive: true, force: true });
    }
  }
}
