import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { pty } from './helpers/pty.mjs';

const tmux = process.env.TEST_TMUX_BINARY || spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(30); }
  throw new Error('UTF-8 terminal check timed out');
}
const needsTmux = !tmux || process.getuid?.() === 0 ? 'requires non-root tmux; CI installs it' : false;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function fixture(t, inheritedLocale) {
  const root = await mkdtemp(join(tmpdir(), 'pic-utf8-terminal-'));
  const bin = join(root, 'bin'), workspace = join(root, 'project');
  await mkdir(bin); await mkdir(workspace);
  const config = resolve('config/tmux.conf'), helper = join(root, 'pic-session.sh');
  await writeFile(helper, (await readFile(resolve('scripts/pic-session.sh'), 'utf8')).replaceAll('/run/pic-ssh/known_hosts', join(root, 'known_hosts')));
  await writeFile(join(bin, 'tmux'), `#!/usr/bin/env bash
args=("$@")
for i in "\${!args[@]}"; do
    if [[ "\${args[i]}" == /opt/pic/config/tmux.conf ]]; then args[i]=${JSON.stringify(config)}; fi
    if [[ "\${args[i]}" == /workspace ]]; then args[i]=${JSON.stringify(workspace)}; fi
done
exec ${JSON.stringify(tmux)} "\${args[@]}"
`, { mode: 0o755 });
  // No real Pi credentials, configuration, history or model calls.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, TERM: 'xterm-256color',
    LANG: inheritedLocale, LC_ALL: inheritedLocale, LC_CTYPE: 'C', TMUX_TMPDIR: root,
    PIC_UTF8_PID: join(root, 'pid'), PIC_UTF8_CHARMAP: join(root, 'charmap'),
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  };
  const run = args => spawnSync('bash', [helper, ...args], { env, cwd: workspace, encoding: 'utf8', timeout: 5000 });
  const clients = [];
  t.after(async () => {
    spawnSync(join(bin, 'tmux'), ['-L', 'pic', 'kill-server'], { env });
    for (const client of clients) if (!client.exited) client.proc.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });
  function attach() {
    const proc = pty.spawn('bash', [helper, 'attach', 'unicode'], { cwd: workspace, env, cols: 120, rows: 38 });
    const client = { proc, output: '', exited: false };
    proc.onData(data => {
      client.output += data;
      if (data.includes('\x1b[6n')) proc.write('\x1b[1;1R');
    });
    proc.onExit(() => client.exited = true);
    clients.push(client); return client;
  }
  return { root, bin, workspace, env, run, attach };
}

test('hosted tmux preserves Chinese/emoji output, UTF-8 input and reattachment even with an inherited C locale', { skip: needsTmux, timeout: 30000 }, async t => {
  for (const inheritedLocale of ['C.UTF-8', 'C']) await t.test(inheritedLocale, async t => {
    const f = await fixture(t, inheritedLocale);
    await writeFile(join(f.bin, 'pi'), `#!/bin/bash
printf '%s\\n' "$$" > "$PIC_UTF8_PID"
locale charmap > "$PIC_UTF8_CHARMAP"
printf 'OUTPUT:中文测试，终端正常 🟢\\n'
while IFS= read -r line; do printf 'REPLY:%s\\n' "$line"; done
`, { mode: 0o755 });
    const created = f.run(['start', 'unicode']);
    assert.equal(created.status, 0, created.stderr);
    await wait(async () => !!(await readFile(f.env.PIC_UTF8_PID, 'utf8').catch(() => '')));
    const originalPid = await readFile(f.env.PIC_UTF8_PID, 'utf8');
    const first = f.attach();
    await wait(() => /OUTPUT:/.test(first.output));
    assert(first.output.includes('OUTPUT:中文测试，终端正常 🟢'), 'Chinese/emoji must reach the attached PTY intact, not become underscores or replacement characters');
    assert.equal((await readFile(f.env.PIC_UTF8_CHARMAP, 'utf8')).trim(), 'UTF-8', 'Pi and its tools must inherit a UTF-8 locale');
    first.proc.write('中文输入，第二轮 🚀\r');
    await wait(() => first.output.includes('REPLY:中文输入，第二轮 🚀'));
    assert(!first.output.includes('\uFFFD'), 'terminal output must not contain Unicode replacement characters');
    first.proc.write('\x02d'); await wait(() => first.exited);
    assert.match(f.run(['list']).stdout, /unicode\t0\t/);
    const second = f.attach();
    await wait(() => /OUTPUT:/.test(second.output));
    assert(second.output.includes('OUTPUT:中文测试，终端正常 🟢'), 'reattachment must redraw original Chinese scrollback');
    second.proc.write('接回后继续输入 ✅\r');
    await wait(() => second.output.includes('REPLY:接回后继续输入 ✅'));
    assert.equal(await readFile(f.env.PIC_UTF8_PID, 'utf8'), originalPid);
    process.kill(Number(originalPid), 'SIGTERM');
    await wait(() => second.exited);
    assert.equal(f.run(['count']).stdout.trim(), '0');
  });
});

test('native offline Pi TUI renders Chinese history and editor input through actual tmux, retaining its PID after reconnect', { skip: needsTmux, timeout: 30000 }, async t => {
  const f = await fixture(t, 'C');
  const agent = join(f.root, 'agent'), history = join(agent, 'history');
  await mkdir(history, { recursive: true });
  const piVersion = JSON.parse(await readFile(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enableAnalytics: false, lastChangelogVersion: piVersion }));
  const manager = SessionManager.create(f.workspace, history);
  manager.appendSessionInfo('中文回归测试');
  manager.appendMessage({ role: 'user', content: '中文历史消息，显示正常 🟢', timestamp: Date.now() });
  const file = manager.getSessionFile(), before = await readFile(file, 'utf8');
  Object.assign(f.env, { PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: history, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' });
  const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const args = [process.execPath, cli, '--session', file, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files'];
  await writeFile(join(f.bin, 'pi'), `#!/bin/bash
printf '%s\\n' "$$" > "$PIC_UTF8_PID"
locale charmap > "$PIC_UTF8_CHARMAP"
exec ${args.map(quote).join(' ')} "$@"
`, { mode: 0o755 });
  const created = f.run(['start', 'unicode']);
  assert.equal(created.status, 0, created.stderr);
  const first = f.attach();
  await wait(() => first.output.includes('中文历史消息，显示正常 🟢'));
  const originalPid = await readFile(f.env.PIC_UTF8_PID, 'utf8');
  assert.equal((await readFile(f.env.PIC_UTF8_CHARMAP, 'utf8')).trim(), 'UTF-8');
  first.proc.write('中文编辑输入'); // Do not submit: no model or provider is involved.
  await wait(() => first.output.includes('中文编辑输入'));
  first.proc.write('\x02d'); await wait(() => first.exited);
  const second = f.attach();
  await wait(() => second.output.includes('中文历史消息，显示正常 🟢') && second.output.includes('中文编辑输入'));
  assert.equal(await readFile(f.env.PIC_UTF8_PID, 'utf8'), originalPid);
  assert(!second.output.includes('Failed to load extension'));
  assert(![first.output, second.output].some(output => output.includes('tmux extended-keys is off') || output.includes('tmux extended-keys-format is xterm')), 'the actual native Pi startup must not warn about the hosted tmux keyboard configuration');
  assert((await readFile(file, 'utf8')).startsWith(before), 'synthetic history is preserved; Pi may append native runtime metadata');
  second.proc.write('\x15/quit\r');
  await wait(() => second.exited);
});
