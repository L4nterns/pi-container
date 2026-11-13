import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  if(args.includes('pic-entrypoint')&&!args.includes('--dev-shell')&&!args.includes('--service-shell')) {
    const replaced=fs.existsSync(path.join(process.env.TMUX_TEST_DIR,'pi-replaced'));
    const installed=fs.existsSync(path.join(process.env.TMUX_TEST_DIR,'bootstrapped'));
    if(!installed&&replaced){console.error('bootstrap would invoke the synthetic Pi installer');process.exit(97);}
    if(!installed&&process.env.FAIL_BOOTSTRAP){process.exit(43);}
    fs.writeFileSync(path.join(process.env.TMUX_TEST_DIR,'bootstrapped'),'yes');
  }
  if(args.some(a=>a.includes('mv /usr/local/bin/pi /usr/local/bin/pi.original')))fs.writeFileSync(path.join(process.env.TMUX_TEST_DIR,'pi-replaced'),'yes');
  if(args.some(a=>a.includes('mv /usr/local/bin/pi.original /usr/local/bin/pi')))fs.rmSync(path.join(process.env.TMUX_TEST_DIR,'pi-replaced'),{force:true});
  if(args.includes('stat')&&args.includes('%d:%i')&&args.at(-1)==='/workspace') {
    const bind=JSON.parse(fs.readFileSync(path.join(process.env.TMUX_TEST_DIR,'workspace-bind'),'utf8'));
    const st=fs.statSync(bind.source,{bigint:true});
    console.log(process.env.BAD_WORKSPACE_IDENTITY?'0:1':process.env.LIVE_WORKSPACE_PATH?st.dev+':'+st.ino:bind.identity);
  }
  else if(args.includes('pic-session')&&args.at(-1)==='count') console.log(fs.existsSync(path.join(process.env.TMUX_TEST_DIR,'closed'))?'0':'1');
  else if(args.some(a=>a.includes('kill -TERM "$1"'))) fs.writeFileSync(path.join(process.env.TMUX_TEST_DIR,'closed'),'yes');
  else if(args.some(a=>a.includes('test ! -s /tmp/live-pi-pid'))) console.log('123');
  else if(args.includes('/opt/app-services/healthcheck.sh')) process.exitCode=process.env.READY==='yes'?0:1;
  else if(args.includes('deploy-register')) console.log(key);
  else if(args.includes('pic-entrypoint')&&args.at(-1)==='cat /workspace/root-only') process.exitCode=1;
  else if(args.includes('cat')&&args.includes('/srv/app-services/ssh/ssh_host_ed25519_key.pub')) console.log(key);
  else if(args.some(a=>a.includes('exit 37'))||(args.includes('pic-entrypoint')&&args.includes('-s'))) process.exitCode=37;
  else if(args.includes('curl')) console.log(args.includes('%{http_code}')?'404':'Hello from Python');
} else if(args[0]==='run') {
  const workspace=args.find(a=>a.includes('target=/workspace'));
  if(workspace){const source=workspace.split(',').find(a=>a.startsWith('source=')).slice(7),st=fs.statSync(source,{bigint:true});fs.writeFileSync(path.join(process.env.TMUX_TEST_DIR,'workspace-bind'),JSON.stringify({source,identity:st.dev+':'+st.ino}));}
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
  assert.equal(result.calls.filter(a => a[0] === 'exec' && a.includes('stat') && a.includes('%d:%i')).length, 2, 'real bind identity and the preserved old inode after pathname recreation are checked');
  const replaced = result.calls.findIndex(a => a.some(value => value.includes('mv /usr/local/bin/pi /usr/local/bin/pi.original')));
  const restored = result.calls.findIndex(a => a.some(value => value.includes('mv /usr/local/bin/pi.original /usr/local/bin/pi')));
  const versions = result.calls.flatMap((a, i) => a.includes('pic-entrypoint') && a.includes('--version') ? [i] : []);
  assert.equal(versions.length, 2, 'real first install and second no-op bootstrap remain covered');
  assert(versions.every(i => i < replaced), 'the real CLI must finish bootstrap before replacing Pi');
  assert(replaced >= 0 && restored > replaced);
  assert(result.calls.some((a, i) => i > versions[1] && i < replaced && a.some(value => value.includes('Default package was not installed and recorded'))), 'native settings and success marker are verified before replacement');
  assert.ok(!result.calls.some(a => a.includes('pic-session') && a.includes('close')), 'host session-close is not an interface');
  assert.ok(result.calls.some(a => a[0] === 'exec' && a.includes('12345:12345') && a.some(value => value.includes('kill -TERM "$1"'))), 'the disposable synthetic Pi exits without a production host-close interface');
  assert.ok(result.calls.some(a => a.includes('deploy-register')));
  const services = result.calls.filter(a => a[0] === 'run' && a.includes('--network-alias'));
  assert.equal(services.length, 4, 'initial service, environment recovery, disabled policy and re-enabled policy recreations');
  assert.ok(services.every(a => !a.includes('no-new-privileges:true')), 'sudo-enabled service must not have NNP');
  assert.ok(result.calls.some(a => a.includes('--service-shell') && a.includes('-c') && a.includes('sudo supervisorctl restart demo')));
  assert.ok(result.calls.some(a => a.includes('--service-shell') && a.includes('-s')), 'recovery assertion runs as deploy over normal SSH, not docker exec root');
  assert.ok(!result.calls.some(a => a[0] === 'run' && a.includes('-p')), 'no public test ports');
  assert.ok(!result.calls.some(a => a.includes('.env')), 'never load real environment');
});
test('workspace identity mismatches and a nonpersistent bind fail smoke before any workload preparation', async t => {
  for (const env of [{ BAD_WORKSPACE_IDENTITY: '1' }, { LIVE_WORKSPACE_PATH: '1' }]) {
    const run = await fixture(t), result = await run([path.join(repo, 'tests/docker-smoke.sh')], { READY: 'yes', ...env });
    assert.equal(result.status, 1, result.stderr);
    assert(!result.calls.some(a => a.includes('/usr/local/bin/pic-workspace-init') || a.includes('--version') || a.includes('--pic-session')));
  }
});

test('a failed real package bootstrap stops smoke before replacing Pi or starting a synthetic session', async t => {
  const run = await fixture(t);
  const result = await run([path.join(repo, 'tests/docker-smoke.sh')], { READY: 'yes', FAIL_BOOTSTRAP: '1' });
  assert.equal(result.status, 43, result.stderr);
  assert(result.calls.some(a => a.includes('pic-entrypoint') && a.includes('--version')));
  assert(!result.calls.some(a => a.some(value => value.includes('mv /usr/local/bin/pi /usr/local/bin/pi.original'))));
  assert(!result.calls.some(a => a.includes('--pic-session') && a.includes('start')));
});

test('the actual synthetic Pi refuses package management immediately but still hosts a long-lived process', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pic-live-smoke-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(repo, 'tests/fixtures/pi-live-smoke.sh'), pidFile = path.join(dir, 'pid');
  for (const command of ['install', 'update', 'remove', 'list', '--version']) {
    const result = spawnSync('sh', [file, command, 'git:github.com/example/package'], { encoding: 'utf8', timeout: 2000, env: { ...process.env, PIC_SMOKE_PID_FILE: pidFile } });
    assert.equal(result.status, 97, result.stderr);
    assert.match(result.stderr, /bootstrap must finish before replacing Pi/);
    await assert.rejects(fs.access(pidFile), { code: 'ENOENT' });
  }
  const manifest = path.join(dir, 'manifest.json');
  await fs.writeFile(manifest, JSON.stringify({ packages: [{ source: 'git:github.com/example/smoke-package' }] }));
  const bootstrap = spawnSync(process.execPath, [path.join(repo, 'scripts/bootstrap-pi.mjs')], { encoding: 'utf8', timeout: 2000,
    env: { ...process.env, PI_CODING_AGENT_DIR: dir, PIC_PI_BOOTSTRAP_MANIFEST: manifest, PIC_PI_BINARY: file, PIC_SMOKE_PID_FILE: pidFile } });
  assert.notEqual(bootstrap.status, 0);
  assert.equal(bootstrap.error, undefined, 'the real bootstrap must fail promptly, not wait for the fixture forever');
  assert.match(bootstrap.stderr, /Installing Pi package.*\nSynthetic smoke Pi/s);
  await assert.rejects(fs.access(path.join(dir, '.pic-packages.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(pidFile), { code: 'ENOENT' });
  const child = spawn('sh', [file, '--skill', '/opt/pic/skills/app-deployment'], { stdio: 'ignore', env: { ...process.env, PIC_SMOKE_PID_FILE: pidFile } });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let ended = false; void exited.then(() => { ended = true; });
  t.after(async () => { if (!ended) child.kill('SIGKILL'); await exited; });
  let pid;
  for (let i=0; i<200; i++) { pid = await fs.readFile(pidFile, 'utf8').catch(() => undefined); if (pid) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(Number(pid?.trim()), child.pid, 'exec sleep retains the hosted process PID');
  assert(!ended);
  child.kill('SIGTERM');
  assert.equal((await exited).signal, 'SIGTERM');
});

test('failed smoke prints diagnostics before cleanup, preserves failure and never restarts workload', async t => {
  const run = await fixture(t);
  const result = await run([path.join(repo, 'tests/docker-smoke.sh')], { CONTAINER_STATE: 'exited' });
  assert.equal(result.status, 1); assert.match(result.stderr, /status=exited exit=17/);
  assert.match(result.stderr, /injected startup failure/);
  assert.ok(result.calls.findIndex(a => a[0] === 'logs') < result.calls.findIndex(a => a[0] === 'rm'));
  assert.ok(!result.calls.some(a => a[0] === 'start' || a.includes('deploy-register')));
});
