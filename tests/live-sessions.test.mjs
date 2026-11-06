import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pty } from './helpers/pty.mjs';

const tmux = process.env.TEST_TMUX_BINARY || spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(30); }
  throw new Error('live process check timed out');
}

test('real tmux: streaming, input, detach and client SIGHUP preserve the original process with or without deployment', {
  skip: !tmux || process.getuid?.() === 0 ? 'requires non-root tmux; CI installs it' : false,
  timeout: 30000,
}, async t => {
  for (const deployment of [false, true]) await t.test(`deployment=${deployment}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pic-live-session-'));
    const bin = join(root, 'bin'), workspace = join(root, 'project');
    await mkdir(bin); await mkdir(workspace);
    const log = join(root, 'pids'), knownHosts = join(root, 'known_hosts');
    if (deployment) await writeFile(knownHosts, 'synthetic deployment enabled\n');
    // Relocate only the image's deployment marker; never inspect or modify real credentials.
    const helper = join(root, 'pic-session.sh');
    await writeFile(helper, (await readFile(resolve('scripts/pic-session.sh'), 'utf8')).replaceAll('/run/pic-ssh/known_hosts', knownHosts));
    await writeFile(join(bin, 'tmux'), `#!/usr/bin/env bash
args=("$@")
if [[ \${PIC_TEST_FAIL_STATE:-} == 1 && " \${args[*]} " == *" list-sessions "* ]]; then echo state-unreadable >&2; exit 1; fi
for i in "\${!args[@]}"; do
    if [[ "\${args[i]}" == /opt/pic/config/tmux.conf ]]; then args[i]=${JSON.stringify(resolve('config/tmux.conf'))}; fi
    if [[ "\${args[i]}" == /workspace ]]; then args[i]=${JSON.stringify(workspace)}; fi
done
exec ${JSON.stringify(tmux)} "\${args[@]}"
`, { mode: 0o755 });
    // Independent streaming and line input: a timed shell read can discard partial input.
    await writeFile(join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.PIC_TEST_PID_LOG, process.pid + '\\n');
fs.writeFileSync(process.env.PIC_TEST_ARGS_LOG, JSON.stringify(process.argv.slice(2)));
console.log('LIVE-PID:' + process.pid);
require('node:readline').createInterface({ input: process.stdin, terminal: false }).on('line', line => console.log('ECHO:' + line));
let counter = 0;
setInterval(() => {
  counter++;
  console.log('STREAM:' + process.pid + ':' + counter);
  fs.writeFileSync(process.env.PIC_TEST_PROGRESS, String(counter));
}, 50);
`, { mode: 0o755 });
    const env = {
      PATH: bin + ':' + process.env.PATH, HOME: root, TMUX_TMPDIR: root,
      PIC_TEST_PID_LOG: log, PIC_TEST_ARGS_LOG: join(root, 'argv'), PIC_TEST_PROGRESS: join(root, 'progress'),
      TERM: 'xterm-256color', LANG: 'C.UTF-8',
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    };
    const run = (args, extra = {}) => spawnSync('/bin/bash', [helper, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 });
    const clients = [];
    t.after(async () => {
      spawnSync(join(bin, 'tmux'), ['-L', 'pic', 'kill-server'], { env });
      for (const client of clients) if (!client.exited) client.p.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    });
    const expectedArgs = deployment ? ['--skill', '/opt/pic/skills/app-deployment'] : [];
    const created = run(['start', 'main']);
    assert.equal(created.status, 0, created.stderr);
    await wait(async () => !!(await readFile(log, 'utf8').catch(() => '')));
    const original = await readFile(log, 'utf8');
    assert.equal(original.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(await readFile(env.PIC_TEST_ARGS_LOG, 'utf8')), expectedArgs);
    for (const [option, expected] of [['extended-keys', 'on'], ['extended-keys-format', 'csi-u']]) {
      const actual = spawnSync(join(bin, 'tmux'), ['-L', 'pic', 'show', '-gv', option], { env, encoding: 'utf8', timeout: 5000 });
      if (option === 'extended-keys-format' && actual.status !== 0) {
        assert.match(actual.stderr, /invalid option/, 'older tmux may omit CSI-u, but unexpected errors still fail');
      } else {
        assert.equal(actual.status, 0, actual.stderr);
        assert.equal(actual.stdout.trim(), expected, `real hosted tmux must enable Pi's ${option}`);
      }
    }
    assert.equal(run(['start', 'main']).status, 1, 'duplicate process must fail');
    const progress = async () => Number(await readFile(env.PIC_TEST_PROGRESS, 'utf8').catch(() => '0'));
    await wait(async () => await progress() > 0);
    function attach() {
      const p = pty.spawn('/bin/bash', [helper, 'attach', 'main'], { cwd: workspace, env, cols: 90, rows: 25 });
      const client = { p, output: '', exited: false };
      p.onData(data => client.output += data);
      p.onExit(() => client.exited = true);
      clients.push(client); return client;
    }
    const first = attach();
    await wait(() => first.output.includes(`STREAM:${original.trim()}:`));
    first.p.write('first-marker\r');
    await wait(() => first.output.includes('ECHO:first-marker'));
    first.p.write('\x02d'); await wait(() => first.exited);
    assert.match(run(['list']).stdout, /main\t0\t/);
    assert.equal(run(['count']).stdout.trim(), '1');
    const detachedProgress = await progress();
    await wait(async () => await progress() > detachedProgress + 2);
    assert.equal(await readFile(log, 'utf8'), original);
    const second = attach();
    await wait(() => second.output.includes(`STREAM:${original.trim()}:`));
    // Signal the actual foreground tmux client, as a terminal hangup would.
    // Older util-linux script (Ubuntu 2.39) handles SIGHUP differently from
    // 2.41; signaling only that test wrapper is not a portable hangup fixture.
    const attached = spawnSync(join(bin, 'tmux'), ['-L', 'pic', 'list-clients', '-t', '=main', '-F', '#{client_pid}'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(attached.status, 0, attached.stderr);
    const clientPids = attached.stdout.trim().split('\n').filter(Boolean);
    assert.equal(clientPids.length, 1, 'only the second client should be attached');
    assert.match(clientPids[0], /^[1-9][0-9]*$/);
    assert(Number(clientPids[0]) > 1);
    process.kill(Number(clientPids[0]), 'SIGHUP');
    await wait(() => second.exited);
    await wait(() => /main\t0\t/.test(run(['list']).stdout));
    const disconnectedProgress = await progress();
    await wait(async () => await progress() > disconnectedProgress + 2);
    const third = attach();
    await wait(() => [...third.output.matchAll(/STREAM:\d+:(\d+)/g)].some(m => Number(m[1]) > disconnectedProgress));
    third.p.write('third-marker\r');
    await wait(() => third.output.includes('ECHO:third-marker'));
    assert.equal(await readFile(log, 'utf8'), original, 'must not launch a replacement or replay history');
    assert.equal(run(['close', 'main']).status, 0);
    await wait(() => third.exited);
    assert.equal(run(['count']).stdout.trim(), '0');
    assert.equal(run(['attach', 'main']).status, 1, 'missing process never becomes a new Pi');
    assert.equal(run(['count'], { PIC_TEST_FAIL_STATE: '1' }).status, 1, 'unknown state is not idle');
    assert.equal(run(['history', 'restored']).status, 2);
    assert.equal(run(['new', 'conversation']).status, 2);
    assert.equal(await readFile(log, 'utf8'), original);
    assert.equal(run(['start', 'another-process']).status, 0);
    await wait(async () => (await readFile(log, 'utf8')).trim().split('\n').length === 2);
    assert.deepEqual(JSON.parse(await readFile(env.PIC_TEST_ARGS_LOG, 'utf8')), expectedArgs);
    assert.equal(run(['close', 'another-process']).status, 0);
  });
});
