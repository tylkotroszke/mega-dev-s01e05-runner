import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CHILD_UID = 65532;
const CHILD_GID = 65532;
const CLI = '/opt/toolchain/node_modules/vitest/vitest.mjs';

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
  if (!/^test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.ts$/.test(testPath) || !/^\d{1,5}$/.test(testTimeout) || Number(testTimeout) < 1 || Number(testTimeout) > 10_000) throw new Error('invalid fixed-controller arguments');
  installUnprivilegedChildren();
  process.argv = [process.execPath, CLI, 'run', testPath, '--config=/opt/toolchain/vitest.config.mjs', '--reporter=json', '--outputFile=/report/result.json', '--maxWorkers=1', '--no-file-parallelism', `--testTimeout=${testTimeout}`, '--silent'];
  await importController(pathToFileURL(CLI).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchTrustedController({ testPath: process.argv[2], testTimeout: process.argv[3] }).catch(() => {
    // No source, payload, stack or credential reaches public runner output.
    process.stderr.write('trusted test controller failed\n'); process.exitCode = 2;
  });
}
