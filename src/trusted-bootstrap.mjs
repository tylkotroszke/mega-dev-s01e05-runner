import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {isTestPath} from './protocol.mjs';

const CHILD_UID = 65532;
const CHILD_GID = 65532;
const CLI = '/opt/toolchain/node_modules/vitest/vitest.mjs';

export function controllerArguments(testPath, testTimeout) {
  if (!isTestPath(testPath) || !/^\d+$/.test(testTimeout) || Number(testTimeout) < 1 || Number(testTimeout) > 300_000) throw new Error('invalid fixed-controller arguments');
  // The trusted .mjs config needs no bundling. Vite's default bundle loader
  // writes beside it under /opt/toolchain/node_modules/.vite-temp, which is
  // intentionally read-only in this image.
  return [process.execPath, CLI, 'run', testPath, '--config=/opt/toolchain/vitest.config.mjs', '--configLoader=native', '--reporter=json', '--outputFile=/report/result.json', '--maxWorkers=1', '--no-file-parallelism', `--testTimeout=${testTimeout}`, '--silent'];
}

/** Return only a finite diagnosis code. Never echo source, paths, logs or tokens. */
export function classifyControllerFailure(log, exitCode) {
  const text = typeof log === 'string' ? log : '';
  let code = 'NO_REPORT';
  if (/EROFS|read-only file system/i.test(text) && /\.vite-temp|vitest\.config/i.test(text)) code = 'CONFIG_READ_ONLY';
  else if (/EACCES|EPERM|permission denied/i.test(text) && /\/report\b/.test(text)) code = 'REPORT_PERMISSION';
  else if (/EACCES|EPERM|permission denied/i.test(text)) code = 'PERMISSION_DENIED';
  else if (/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/i.test(text)) code = 'TOOLCHAIN_MODULE_MISSING';
  else if (/EAGAIN|ENOMEM|spawn.*failed/i.test(text)) code = 'PROCESS_RESOURCE';
  else if (/SyntaxError|Transform failed/i.test(text)) code = 'SOURCE_TRANSFORM_FAILED';
  else if (/trusted test controller failed/.test(text)) code = 'BOOTSTRAP_FAILED';
  return { sandboxFailure: { code, exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null } };
}

async function printSafeFailure(exitCode) {
  let log = '';
  let file;
  try {
    file = await open('/tmp/vitest-output', 'r');
    const buffer = Buffer.alloc(64_000);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    log = buffer.subarray(0, bytesRead).toString('utf8');
  } catch { /* The safe fallback is NO_REPORT, not the underlying error text. */ }
  finally { await file?.close(); }
  process.stdout.write(JSON.stringify(classifyControllerFailure(log, exitCode)));
}

function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env ?? process.env).filter(([key]) =>
    ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'NODE_ENV', 'FORCE_COLOR', 'FORCE_TTY', 'NO_COLOR', 'TERM', 'TEST', 'VITEST'].includes(key)
    || /^(?:VITEST_|TINYPOOL_)/.test(key)));
}

/** Install before importing the trusted test controller. No model/source code runs here. */
export function installUnprivilegedChildren({ api = childProcess, syncExports = syncBuiltinESMExports } = {}) {
  const originals = Object.fromEntries(['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync'].map((name) => [name, api[name]]));
  const force = (options = {}) => ({ ...options, uid: CHILD_UID, gid: CHILD_GID, shell: false, env: childEnvironment(options.env) });
  for (const name of ['spawn', 'spawnSync']) {
    api[name] = function (command, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      return originals[name].call(this, command, args, force(options));
    };
  }
  api.fork = function (modulePath, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    return originals.fork.call(this, modulePath, args, { ...force(options), execPath: process.execPath });
  };
  api.execFile = function (file, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    return originals.execFile.call(this, file, args, force(options), callback);
  };
  api.execFileSync = function (file, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    return originals.execFileSync.call(this, file, args, force(options));
  };
  // Never let a trusted dependency introduce a root shell subprocess.
  api.exec = api.execSync = () => { throw new Error('shell subprocess disabled in trusted test controller'); };
  syncExports();
}

export async function launchTrustedController({ testPath, testTimeout, importController = (url) => import(url) }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('trusted test controller requires Linux report-owner identity');
  const reportDir = await lstat('/report');
  if (!reportDir.isDirectory() || reportDir.isSymbolicLink() || reportDir.uid !== 0 || (reportDir.mode & 0o077) !== 0) throw new Error('report directory is not protected from test workers');
  const args = controllerArguments(testPath, testTimeout);
  // Vitest 5 always persists its local API token. Keep it in the root-only
  // tmpfs instead of the read-only home/toolchain; children do not inherit XDG.
  process.env.XDG_DATA_HOME = '/report/vitest-data';
  installUnprivilegedChildren();
  process.argv = args;
  await importController(pathToFileURL(CLI).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] === '--diagnose'
    ? printSafeFailure(/^\d{1,3}$/.test(process.argv[3] ?? '') ? Number(process.argv[3]) : null)
    : launchTrustedController({ testPath: process.argv[2], testTimeout: process.argv[3] });
  action.catch(() => {
    // No source, payload, stack or credential reaches public runner output.
    process.stderr.write('trusted test controller failed\n'); process.exitCode = 2;
  });
}
