import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/docker-smoke.sh');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pic-smoke-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  const log = path.join(root, 'docker.jsonl');
  const runtimeLog = path.join(root, 'host-runtime.log');
  for (const name of ['node', 'python3', 'jq']) {
    await fs.writeFile(path.join(bin, name), '#!/bin/sh\nprintf "Unexpected host runtime\\n" >> "$HOST_RUNTIME_LOG"\nexit 127\n', { mode: 0o755 });
  }
  await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),key='ssh-ed25519 '+'A'.repeat(68);
fs.appendFileSync(process.env.CALL_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='inspect') console.log(args.includes('{{.State.Status}}')?(process.env.CONTAINER_STATE||'running'):'status=exited exit=17 oom=false error=""');
else if(args[0]==='logs') console.log('injected startup failure');
else if(args[0]==='exec') {
  if(args.includes('pic-session')&&args.at(-1)==='count') console.log(fs.existsSync(path.join(process.env.TMUX_TEST_DIR,'closed'))?'0':'1');
  else if(args.includes('pic-session')&&args.includes('close')) fs.writeFileSync(path.join(process.env.TMUX_TEST_DIR,'closed'),'yes');
  else if(args.some(a=>a.includes('test ! -s /tmp/live-pi-pid'))) console.log('123');
  else if(args.includes('/opt/app-services/healthcheck.sh')) process.exitCode=process.env.READY==='yes'?0:1;
  else if(args.includes('deploy-register')) console.log(key);
  else if(args.includes('pic-entrypoint')&&args.at(-1)==='cat /workspace/root-only') process.exitCode=1;
  else if(args.includes('cat')&&args.includes('/srv/app-services/ssh/ssh_host_ed25519_key.pub')) console.log(key);
  else if(args.some(a=>a.includes('exit 37'))||(args.includes('pic-entrypoint')&&args.includes('-s'))) process.exitCode=37;
  else if(args.includes('curl')) console.log(args.includes('%{http_code}')?'404':'Hello from Python');
} else if(args[0]==='run') {
  if(args.includes('no-new-privileges:true')&&args.includes('none')&&!args.includes('--mount')&&!args.includes('--read-only')) {
    console.error('Service administration needs sudo; do not set no-new-privileges on this container');
    process.exitCode=1;
  } else if(args[args.indexOf('--entrypoint')+1]==='ssh-keygen') {
    const mount=args.find(a=>a.includes('target=/keys'));
    const source=mount.split(',').find(a=>a.startsWith('source=')).slice(7);
    fs.writeFileSync(path.join(source,'id_ed25519'),'synthetic-test-key');
    fs.writeFileSync(path.join(source,'id_ed25519.pub'),key);
  }
}
`, { mode: 0o755 });
  return async (args, env = {}) => {
    const result = spawnSync('bash', args, { cwd: repo, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, HOST_RUNTIME_LOG: runtimeLog, TMUX_TEST_DIR:root, ...env } });
    const calls = (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
    await fs.writeFile(log, '');
    return { ...result, calls, hostRuntimeCalls: await fs.readFile(runtimeLog, 'utf8').catch(() => '') };
  };
}

test('smoke fails immediately on exited service, before key enrollment', async t => {
  const run = await fixture(t);
  const result = await run(['-c', 'set -euo pipefail; source "$1"; smoke_wait_service service 5 0; docker exec service deploy-register', '_', helper], { CONTAINER_STATE: 'exited' });
  assert.equal(result.status, 1); assert.match(result.stderr, /在就绪前退出/);
  assert.equal(result.calls.filter(a => a[0] === 'inspect').length, 1);
  assert.ok(!result.calls.some(a => a[0] === 'exec'));
});
test('smoke readiness times out instead of falling through; healthy startup succeeds', async t => {
  const run = await fixture(t);
  const args = ['-c', 'set -euo pipefail; source "$1"; smoke_wait_service service 3 0', '_', helper];
  const failed = await run(args);
  assert.equal(failed.status, 1); assert.match(failed.stderr, /超时/);
  assert.equal(failed.calls.filter(a => a.includes('/opt/app-services/healthcheck.sh')).length, 3);
  assert.equal((await run(args, { READY: 'yes' })).status, 0);
});
test('smoke Docker orchestration needs no host runtime and retains source-independent SSH and recreation checks', async t => {
  const run = await fixture(t);
  const result = await run([path.join(repo, 'tests/docker-smoke.sh')], { READY: 'yes' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Docker smoke checks passed/);
  assert.equal(result.hostRuntimeCalls, '');
  assert.ok(result.calls.some(a => a.includes('deploy-register')));
  const services = result.calls.filter(a => a[0] === 'run' && a.includes('--network-alias'));
  assert.equal(services.length, 3, 'initial service and two recreations');
  assert.ok(services.every(a => !a.includes('no-new-privileges:true')), 'sudo-enabled service must not have NNP');
  assert.ok(result.calls.some(a => a.includes('--service-shell') && a.includes('-c') && a.includes('sudo supervisorctl restart demo')));
  assert.ok(result.calls.some(a => a.includes('--service-shell') && a.includes('-s')), 'recovery assertion runs as deploy over normal SSH, not docker exec root');
  assert.ok(!result.calls.some(a => a[0] === 'run' && a.includes('-p')), 'no public test ports');
  assert.ok(!result.calls.some(a => a.includes('.env')), 'never load real environment');
});
test('failed smoke prints diagnostics before cleanup, preserves failure and never restarts workload', async t => {
  const run = await fixture(t);
  const result = await run([path.join(repo, 'tests/docker-smoke.sh')], { CONTAINER_STATE: 'exited' });
  assert.equal(result.status, 1); assert.match(result.stderr, /status=exited exit=17/);
  assert.match(result.stderr, /injected startup failure/);
  assert.ok(result.calls.findIndex(a => a[0] === 'logs') < result.calls.findIndex(a => a[0] === 'rm'));
  assert.ok(!result.calls.some(a => a[0] === 'start' || a.includes('deploy-register')));
});
