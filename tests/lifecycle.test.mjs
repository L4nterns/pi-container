import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const library = fileURLToPath(new URL('../lib/session-lifecycle.sh', import.meta.url));
const worker = `set -euo pipefail
source "$LIBRARY"
session_lifecycle_init "$STATE"
start() { printf 'started\\n'; }
stop() { printf 'stopped\\n' >> "$STATE/stops"; }
session_start start
trap 'session_finish stop' EXIT
printf 'ready\\n'
IFS= read -r command
if [[ "$command" == crash ]]; then kill -KILL $$; fi
`;

async function fixture(t) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lease-test-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  return state;
}

function run(script, state) {
  const child = spawn('bash', ['-c', script], {
    env: { ...process.env, LIBRARY: library, STATE: state }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited, output: () => stdout };
}

async function waitReady(proc) {
  for (let i = 0; i < 200; i++) {
    if (proc.output().includes('ready\n')) return;
    if (proc.child.exitCode !== null) throw new Error(JSON.stringify(await proc.exited));
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('session did not become ready');
}

async function stopCount(state) {
  try { return (await fs.readFile(path.join(state, 'stops'), 'utf8')).trim().split('\n').length; }
  catch (err) { if (err.code === 'ENOENT') return 0; throw err; }
}

async function session(t, state) {
  const proc = run(worker, state);
  t.after(() => { if (proc.child.exitCode === null) proc.child.kill('SIGKILL'); });
  await waitReady(proc);
  return proc;
}

test('only the last of overlapping sessions stops the container', { timeout: 10000 }, async t => {
  const state = await fixture(t);
  const first = await session(t, state);
  const second = await session(t, state);
  first.child.stdin.end('quit\n');
  assert.equal((await first.exited).code, 0);
  assert.equal(await stopCount(state), 0);
  second.child.stdin.end('quit\n');
  assert.equal((await second.exited).code, 0);
  assert.equal(await stopCount(state), 1);
  assert.deepEqual((await fs.readdir(state)).filter(x => x.startsWith('session.')), []);
});

test('idle-only maintenance rejects active sessions and works after they leave', { timeout: 10000 }, async t => {
  const state = await fixture(t);
  const active = await session(t, state);
  const script = 'set -euo pipefail; source "$LIBRARY"; session_lifecycle_init "$STATE"; session_require_idle touch "$STATE/maintenance"';
  const blocked = await run(script, state).exited;
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /活动终端连接/);
  active.child.stdin.end('quit\n');
  await active.exited;
  assert.equal((await run(script, state).exited).code, 0);
  await fs.access(path.join(state, 'maintenance'));
});

test('crashed sessions leave reclaimable leases, not permanent activity', { timeout: 10000 }, async t => {
  const state = await fixture(t);
  const crashed = await session(t, state);
  crashed.child.stdin.end('crash\n');
  assert.equal((await crashed.exited).signal, 'SIGKILL');
  const next = await session(t, state);
  next.child.stdin.end('quit\n');
  assert.equal((await next.exited).code, 0);
  assert.equal(await stopCount(state), 1);
  assert.deepEqual((await fs.readdir(state)).filter(x => x.startsWith('session.')), []);
});

test('failed startup preserves status, releases lease and does not run idle-stop', { timeout: 10000 }, async t => {
  const state = await fixture(t);
  const result = await run(`set -euo pipefail
source "$LIBRARY"
session_lifecycle_init "$STATE"
stop() { touch "$STATE/stopped"; }
trap 'session_finish stop' EXIT
start() { return 37; }
session_start start
`, state).exited;
  assert.equal(result.code, 37);
  assert.deepEqual(await fs.readdir(state), ['lifecycle.lock']);
});

test('startup holds the lifecycle lock until its lease is registered', { timeout: 10000 }, async t => {
  const state = await fixture(t);
  const first = await session(t, state);
  const second = run(worker.replace("printf 'started\\n';", "printf 'starting\\n'; sleep 0.2;"), state);
  t.after(() => { if (second.child.exitCode === null) second.child.kill('SIGKILL'); });
  for (let i = 0; !second.output().includes('starting\n') && i < 200; i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.match(second.output(), /starting/);
  first.child.stdin.end('quit\n');
  await waitReady(second);
  assert.equal((await first.exited).code, 0);
  assert.equal(await stopCount(state), 0);
  second.child.stdin.end('quit\n');
  assert.equal((await second.exited).code, 0);
  assert.equal(await stopCount(state), 1);
});
