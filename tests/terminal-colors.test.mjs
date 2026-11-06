import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pty } from './helpers/pty.mjs';

const tmux = process.env.TEST_TMUX_BINARY || spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(30); }
  throw new Error('terminal color check timed out');
}
const needsTmux = !tmux || process.getuid?.() === 0 ? 'requires non-root tmux; CI installs it' : false;

test('real tmux preserves the advertised 256/RGB palette instead of reducing it to xterm basic colors', {
  skip: needsTmux, timeout: 30000,
}, async t => {
  for (const [term, colorTerm, expectedMode] of [
    ['xterm', '', 'basic'],
    ['xterm-256color', '', '256color'],
    ['xterm-256color', 'truecolor', 'truecolor'],
    ['xterm', '24bit', 'truecolor'],
  ]) await t.test(`${term}, COLORTERM=${colorTerm || '(unset)'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pic-terminal-colors-'));
    const bin = join(root, 'bin'); await mkdir(bin);
    const helper = join(root, 'pic-session.sh');
    await writeFile(helper, (await readFile(resolve('scripts/pic-session.sh'), 'utf8')).replaceAll('/run/pic-ssh/known_hosts', join(root, 'known_hosts')));
    await writeFile(join(bin, 'tmux'), `#!/usr/bin/env bash
args=("$@")
for i in "\${!args[@]}"; do
    if [[ "\${args[i]}" == /opt/pic/config/tmux.conf ]]; then args[i]=${JSON.stringify(resolve('config/tmux.conf'))}; fi
    if [[ "\${args[i]}" == /workspace ]]; then args[i]=${JSON.stringify(root)}; fi
done
exec ${JSON.stringify(tmux)} "\${args[@]}"
`, { mode: 0o755 });
    const modePath = join(root, 'native-mode');
    await writeFile(join(bin, 'pi'), `#!${process.execPath}
(async () => {
  const fs = require('node:fs');
  const { getTerminalColorMode } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-tui'))});
  fs.writeFileSync(${JSON.stringify(modePath)}, getTerminalColorMode());
  setInterval(() => process.stdout.write('\\x1b[38;5;244mGRAY-MARKER\\x1b[0m \\x1b[38;2;138;173;196mRGB-MARKER\\x1b[0m\\r\\n'), 100);
})();
`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMUX_TMPDIR: root,
      LANG: 'C.UTF-8', TERM: term, COLORTERM: colorTerm,
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    };
    let client;
    t.after(async () => {
      spawnSync(join(bin, 'tmux'), ['-L', 'pic', 'kill-server'], { env });
      if (client && !client.exited) client.proc.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    });
    const run = args => spawnSync('bash', [helper, ...args], { env, cwd: root, encoding: 'utf8', timeout: 5000 });
    const started = run(['start', 'colors']);
    assert.equal(started.status, 0, started.stderr);
    await wait(async () => !!(await readFile(modePath, 'utf8').catch(() => '')));
    assert.equal(await readFile(modePath, 'utf8'), colorTerm ? 'truecolor' : '256color', 'native Pi capability detection receives the same truecolor hint');
    function attach() {
      const proc = pty.spawn('bash', [helper, 'attach', 'colors'], { env, cwd: root, cols: 100, rows: 24 });
      client = { proc, output: '', exited: false };
      const current = client;
      proc.onData(data => current.output += data);
      proc.onExit(() => current.exited = true);
      return current;
    }
    function checkColors(output) {
      assert(output.includes('GRAY-MARKER') && output.includes('RGB-MARKER'));
      if (expectedMode === 'basic') {
        assert(!output.includes('\x1b[38;5;244m'), 'a real 8-color client must not be falsely upgraded');
      } else {
        assert(output.includes('\x1b[38;5;244m'), 'gray must retain its palette index, not turn into black/white');
      }
      assert.equal(output.includes('\x1b[38;2;138;173;196m'), expectedMode === 'truecolor', 'RGB is preserved only when the outer terminal advertises it');
    }
    const first = attach();
    await wait(() => first.output.includes('RGB-MARKER'));
    checkColors(first.output);
    first.proc.write('\x02d'); await wait(() => first.exited);
    const second = attach();
    await wait(() => second.output.includes('RGB-MARKER'));
    checkColors(second.output);
    assert.equal(run(['close', 'colors']).status, 0);
    await wait(() => second.exited);
  });
});
