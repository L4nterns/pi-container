import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pty } from './helpers/pty.mjs';
import { spawnSync } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, { rows = 20, cols = 100, title = '中文菜单', items = ['First', 'Second', '返回'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pic-arrow-menu-'));
  const proc = pty.spawn('bash', ['-c', `
source "$1"; shift
saved=$(stty -g)
printf 'WRAPPER:%s\\n' "$BASHPID"
menu_select "$@"
status=$?
[[ "$(stty -g)" == "$saved" ]] && restored=yes || restored=no
printf '\\nRESULT:%s RESTORED:%s\\n' "$status" "$restored"
`, 'menu-test', resolve('lib/menu.sh'), title, ...items], { cwd: dir, env: { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, rows, cols });
  let output = '', ended = false, timedOut = false;
  proc.onData(data => output += data);
  const exit = new Promise(resolve => proc.onExit(result => { ended = true; resolve(result); }));
  const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 8000);
  t.after(async () => { clearTimeout(timeout); if (!ended) proc.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); });
  async function wait(check) {
    for (let i = 0; i < 250 && !check(output) && !ended; i++) await sleep(15);
    assert(check(output), output);
  }
  await wait(s => s.includes('↑/↓') || s.includes('终端太小'));
  return {
    proc, wait, output: () => output,
    async finish(keys, status = 0) {
      if (keys) proc.write(keys);
      const result = await exit; clearTimeout(timeout);
      assert(!timedOut, output); assert.equal(result.exitCode, 0, output);
      assert(output.includes(`RESULT:${status} RESTORED:yes`), output);
      assert(output.includes('\x1b[?25h\x1b[?1049l'), 'cursor and primary screen restored');
      return output;
    },
  };
}

test('arrow selector ignores digits and bracketed paste; standard/application cursor keys select without line input', async t => {
  const f = await fixture(t);
  f.proc.write('2\x1b[200~\x1b[B\r\x1b[201~');
  await sleep(100);
  assert(!f.output().includes('RESULT:'), 'pasted Enter must not execute an action');
  const output = await f.finish('\x1bOB\r');
  assert.match(output, /\x1b\[7mSecond/);
  assert.match(output, /1\r?\n\x1b\[\?2004l/);
  assert.doesNotMatch(output, /[0-9]\) /);
});

test('long lists page, Home/End select edges and small terminals keep all rows within the viewport', async t => {
  const f = await fixture(t, { rows: 9, cols: 90, items: Array.from({ length: 40 }, (_, i) => `Item-${i}`) });
  f.proc.write('\x1b[6~'); await f.wait(s => s.includes('\x1b[7mItem-5'));
  f.proc.write('\x1b[5~'); await f.wait(s => s.split('\x1b[7mItem-0').length >= 3);
  f.proc.write('\x1b[F'); await f.wait(s => s.includes('\x1b[7mItem-39'));
  const output = await f.finish('\r');
  assert.match(output, /39\r?\n\x1b\[\?2004l/);
  for (const frame of output.split('\x1b[H\x1b[2J').slice(1)) assert(frame.split('\x1b[?2004l')[0].split('\n').length <= 9, frame);
});

test('Escape and Ctrl-D cancel with exact TTY restoration', async t => {
  for (const key of ['\x1b', '\x04']) await t.test(JSON.stringify(key), async t => {
    const f = await fixture(t); await f.finish(key, 1);
  });
});

test('terminal resize is applied on the next key without corrupting selection or terminal modes', async t => {
  const f = await fixture(t);
  f.proc.write('\x1b[B'); await f.wait(s => s.includes('\x1b[7mSecond'));
  const before = f.output().length;
  const parent = /WRAPPER:(\d+)/.exec(f.output())[1];
  const result = spawnSync('stty', ['--file', `/proc/${parent}/fd/0`, 'rows', '8', 'cols', '42'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  f.proc.write('\x1b[A');
  await f.wait(s => s.slice(before).includes('\x1b[7mFirst'));
  await f.finish('\r');
});

test('termination signal restores TTY and does not confirm the selected action', async t => {
  const f = await fixture(t);
  const parent = /WRAPPER:(\d+)/.exec(f.output())[1];
  let child = '';
  for (let i = 0; i < 100 && !child; i++) {
    child = (await readFile(`/proc/${parent}/task/${parent}/children`, 'utf8')).trim().split(' ')[0];
    if (!child) await sleep(15);
  }
  assert(child); process.kill(Number(child), 'SIGTERM');
  await f.finish('', 143);
});

test('menu labels cannot inject terminal escapes, and CJK labels are clipped without byte corruption', async t => {
  const f = await fixture(t, { rows: 10, cols: 36, title: '项目\x1b[31m\n标题', items: ['中文名称'.repeat(50) + '🟢', '返回'] });
  const output = await f.finish('\r');
  assert(!output.includes('\x1b[31m')); assert(!output.includes('\ufffd'));
  const frame = output.split('\x1b[H\x1b[2J')[1].split('\x1b[?2004l')[0];
  assert(frame.includes('…'));
  for (const line of frame.split('\n')) {
    const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    const conservativeWidth = [...plain].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    assert(conservativeWidth < 36, line);
  }
});
