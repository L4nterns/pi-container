import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/docker-smoke.sh');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-smoke-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const log = path.join(root, 'docker.jsonl');
  const hostRuntimeLog = path.join(root, 'host-runtime.log');
  await fs.writeFile(path.join(bin, 'node'), `#!/bin/sh
printf 'Unexpected host Node invocation\\n' >> "$HOST_RUNTIME_LOG"
printf 'node: command not found (intentional test guard)\\n' >&2
exit 127
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') {
  if (args.includes('{{.State.Status}}')) console.log(process.env.CONTAINER_STATE || 'running');
  else console.log('status=exited exit=17 oom=false error=""');
} else if (args[0] === 'exec') {
  if (process.env.CONTAINER_STATE === 'exited') process.exitCode = 1;
  else if (args.includes('curl')) {
    if (args.includes('Host: app-missing.example.com')) process.exitCode = 22;
    else if (args.includes('Host: app-smoke.example.com') && fs.existsSync(process.env.CALL_LOG + '.deleted')) process.exitCode = 22;
    else if (process.env.READY !== 'yes') process.exitCode = 7;
    else if (args.some(arg => arg.endsWith(':8080/'))) console.log('persistent service');
  } else if (args.includes('deploy-admin')) {
    if (process.env.SMOKE_FLOW === 'yes') console.log(JSON.stringify({ user: 'deploy', hostKey: 'ssh-ed25519 ' + 'A'.repeat(68) }));
    else process.exitCode = 97;
  } else if (args.includes('-ec') && args.includes('appctl delete smoke')) {
    process.exitCode = 2;
  } else if (args.some(arg => arg.startsWith('appctl delete smoke --yes'))) {
    fs.writeFileSync(process.env.CALL_LOG + '.deleted', 'yes');
  } else if (args.includes('-c') && args.some(arg => arg.startsWith('ssh '))) {
    process.exitCode = 1;
  }
} else if (args[0] === 'run' && args.includes('--entrypoint')) {
  const entrypoint = args[args.indexOf('--entrypoint') + 1];
  const mount = args.find(arg => arg.startsWith('type=bind,') && arg.includes('target=/keys'));
  const keys = mount?.split(',').find(arg => arg.startsWith('source=')).slice(7);
  if (entrypoint === 'ssh-keygen') {
    fs.writeFileSync(path.join(keys, 'id_ed25519'), 'synthetic-test-key');
    fs.writeFileSync(path.join(keys, 'id_ed25519.pub'), 'ssh-ed25519 ' + 'A'.repeat(68));
  } else if (entrypoint === 'node' && args.includes('-e')) {
    // The real parser runs behind the emulated Docker boundary. Bare host
    // "node" is deliberately unavailable, matching a Docker-only host.
    const result = spawnSync(process.execPath, ['-e', args[args.indexOf('-e') + 1], keys], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
} else if (args[0] === 'logs') {
  console.log('nginx: [emerg] injected startup failure');
}
`, { mode: 0o755 });
  return async (args, env = {}) => {
    const result = spawnSync('bash', args, {
      cwd: repo, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, HOST_RUNTIME_LOG: hostRuntimeLog, ...env },
    });
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await fs.writeFile(log, '');
    const hostRuntimeCalls = await fs.readFile(hostRuntimeLog, 'utf8').catch(() => '');
    return { ...result, calls, hostRuntimeCalls };
  };
}

test('smoke runtime identity assertion parses multiline passwd and rejects unsafe identities', async () => {
  const script = await fs.readFile(path.join(repo, 'tests/docker-smoke.sh'), 'utf8');
  const match = /docker exec "\$SERVICE" node -e '([\s\S]*?)\n'/.exec(script);
  assert.ok(match, 'execute the actual shell-embedded assertion, not a duplicate');
  const check = ({ shell = '/usr/sbin/nologin', owner = 20000, uid = 20000, present = true } = {}) => {
    const filesystem = {
      readFileSync(file) {
        if (file === '/srv/app-services/apps.json') return JSON.stringify({ smoke: { uid } });
        if (file === '/etc/passwd') return 'root:x:0:0::/root:/bin/sh\ndeploy:x:19000:19000::/srv/app-services/control:/bin/sh\n' +
          (present ? `app${uid}:x:${uid}:${uid}::/srv/app-services/apps/smoke:${shell}\n` : '');
        throw new Error('Unexpected read: ' + file);
      },
      statSync(file) { assert.equal(file, '/srv/app-services/apps/smoke/data/proof'); return { uid: owner }; },
    };
    return vm.runInNewContext(match[1], { require(name) { assert.equal(name, 'node:fs'); return filesystem; } });
  };
  assert.doesNotThrow(() => check());
  assert.throws(() => check({ shell: '/bin/sh' }), /must not have a shell/);
  assert.throws(() => check({ present: false }), /must not have a shell/);
  assert.throws(() => check({ owner: 0 }), /wrong identity/);
  assert.throws(() => check({ uid: 0 }), /Invalid app UID/);
});

test('smoke readiness fails immediately when the container exits and never continues to registration', async t => {
  const run = await fixture(t);
  const result = await run(['-c', 'set -euo pipefail; source "$1"; smoke_wait_service service 5 0; docker exec service deploy-admin register', '_', helper], { CONTAINER_STATE: 'exited' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /在就绪前退出/);
  assert.equal(result.calls.filter(args => args[0] === 'inspect').length, 1);
  assert.ok(!result.calls.some(args => args[0] === 'exec'));
});

test('smoke readiness timeout fails instead of falling through; healthy startup succeeds', async t => {
  const run = await fixture(t);
  const script = ['-c', 'set -euo pipefail; source "$1"; smoke_wait_service service 3 0', '_', helper];
  const timeout = await run(script);
  assert.equal(timeout.status, 1, timeout.stderr);
  assert.match(timeout.stderr, /超时/);
  assert.equal(timeout.calls.filter(args => args[0] === 'exec').length, 3);
  const healthy = await run(script, { READY: 'yes' });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(healthy.calls.filter(args => args[0] === 'exec').length, 1);
});

test('complete smoke flow parses registration inside Docker without host Node', async t => {
  const run = await fixture(t);
  const result = await run([path.join(repo, 'tests/docker-smoke.sh')], { READY: 'yes', SMOKE_FLOW: 'yes', CONTAINER_STATE: 'running' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Docker smoke checks passed/);
  assert.equal(result.hostRuntimeCalls, '', 'must not invoke host Node');
  const parser = result.calls.find(args => args[0] === 'run' && args[args.indexOf('--entrypoint') + 1] === 'node');
  assert.ok(parser, 'registration JSON parser must execute in the built image');
  assert.ok(parser.includes('-i'), 'registration is piped to the container stdin');
  assert.ok(parser.includes('none'), 'parser does not need network access');
  assert.ok(parser.some(arg => arg.includes('target=/keys')), 'credentials written only to the temporary mounted directory');
  assert.ok(result.calls.some(args => args[0] === 'run' && args.includes('--appctl') && args.includes('restart')), 'exercise source-independent management client');
  assert.ok(result.calls.some(args => args.some(arg => arg.includes('appctl restart smoke'))));
  assert.ok(result.calls.some(args => args.includes('appctl delete smoke')), 'exercise missing-confirmation rejection');
  assert.ok(result.calls.some(args => args.some(arg => arg.startsWith('appctl delete smoke --yes'))));
  assert.ok(result.calls.some(args => args.includes('/srv/app-services/apps/smoke')), 'verify app files were removed');
});

test('failed smoke test prints container exit state and logs before removal, never restarts it, and preserves failure', async t => {
  const run = await fixture(t);
  const result = await run([path.join(repo, 'tests/docker-smoke.sh')], { CONTAINER_STATE: 'exited' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /status=exited exit=17/);
  assert.match(result.stderr, /nginx: \[emerg\] injected startup failure/);
  const diagnostic = result.calls.findIndex(args => args[0] === 'logs');
  const remove = result.calls.findIndex(args => args[0] === 'rm');
  assert.ok(diagnostic >= 0 && remove > diagnostic, 'log before container removal');
  assert.ok(!result.calls.some(args => args[0] === 'start'), 'cleanup must not restart a failed workload');
  assert.ok(!result.calls.some(args => args.includes('deploy-admin')), 'must not register after readiness failure');
});
