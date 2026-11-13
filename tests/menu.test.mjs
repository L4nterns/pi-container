import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pty } from './helpers/pty.mjs';
import { spawnSync } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, { rows = 20, cols = 100, title = '中文菜单', items = ['First', 'Second', '返回'], env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pic-arrow-menu-'));
  const proc = pty.spawn('bash', ['-c', `
source "$1"; shift
saved=$(stty -g)
printf 'WRAPPER:%s\\n' "$BASHPID"
menu_select "$@"
status=$?
[[ "$(stty -g)" == "$saved" ]] && restored=yes || restored=no
printf '\\nRESULT:%s RESTORED:%s\\n' "$status" "$restored"
`, 'menu-test', resolve('lib/menu.sh'), title, ...items], { cwd: dir, env: { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...env }, rows, cols });
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
  assert.match(output, /1\r?\n\x1b\[0m\x1b\[\?2004l/);
  assert.doesNotMatch(output, /[0-9]\) /);
});

test('long lists page, Home/End select edges and small terminals keep all rows within the viewport', async t => {
  const f = await fixture(t, { rows: 9, cols: 90, items: Array.from({ length: 40 }, (_, i) => `Item-${i}`) });
  f.proc.write('\x1b[6~'); await f.wait(s => s.includes('\x1b[7mItem-4'));
  f.proc.write('\x1b[5~'); await f.wait(s => s.split('\x1b[7mItem-0').length >= 3);
  f.proc.write('\x1b[F'); await f.wait(s => s.includes('\x1b[7mItem-39'));
  const output = await f.finish('\r');
  assert.match(output, /39\r?\n\x1b\[0m\x1b\[\?2004l/);
  const frames = output.split('\x1b[?2026h').slice(1).map(s => s.split('\x1b[?2026l')[0]);
  assert(frames.length >= 3, output);
  for (const frame of frames) assert(!frame.includes('\x1b[2J'), 'navigation never erases the whole screen');
  assert(!frames.at(-1).includes('中文菜单'), 'unchanged heading is not repainted');
});

test('disabled rows are dimmed and skipped by initial focus, arrows, Home/End and paging', async t => {
  const env = { MENU_DISABLED: '0 2 4' };
  const f = await fixture(t, { rows: 8, items: ['Disabled-first', 'Enabled-one', 'Disabled-middle', 'Enabled-two', 'Disabled-last'], env });
  assert.match(f.output(), /\x1b\[2mDisabled-first/);
  assert.match(f.output(), /\x1b\[7mEnabled-one/);
  for (const [keys, label] of [['\x1b[A', 'Enabled-two'], ['\x1b[H', 'Enabled-one'], ['\x1bOB', 'Enabled-two'], ['\x1b[B', 'Enabled-one'], ['\x1b[F', 'Enabled-two'], ['\x1b[5~', 'Enabled-one'], ['\x1b[6~', 'Enabled-two']]) {
    const before = f.output().length;
    f.proc.write(keys);
    await f.wait(s => s.slice(before).includes(`\x1b[7m${label}`));
  }
  const out = await f.finish('\r');
  assert.match(out, /3\r?\n\x1b\[0m\x1b\[\?2004l/);
  assert.doesNotMatch(out, /\x1b\[7mDisabled-/);
  assert(!out.includes('\x1b[2J'));
});

test('project path lists use the full row width and horizontal navigation exposes long path suffixes without selecting', async t => {
  const f = await fixture(t, { rows: 9, cols: 50, items: ['/workspace/' + 'long-parent/'.repeat(8) + 'PROJECT-B-MARKER'], env: { MENU_PATH_LIST: '1' } });
  f.proc.write('\x1b[C'.repeat(10)); await f.wait(s => s.includes('PROJECT-B-MARKER'));
  assert(!f.output().includes('RESULT:'), 'horizontal path viewing does not execute the selection');
  await f.finish('\r');
});

test('all-disabled lists stay unavailable; other menus select their first enabled action immediately', async t => {
  const all = await fixture(t, { items: ['Unavailable'], env: { MENU_DISABLED: '0' } });
  const output = await all.finish('\x1b[A\x1b[B\x1b[H\x1b[F\x1b[5~\x1b[6~\r', 1);
  assert.doesNotMatch(output, /\x1b\[7mUnavailable/);
  const enabled = await fixture(t, { items: ['Unavailable', 'Execute'], env: { MENU_DISABLED: '0' } });
  assert.match(enabled.output(), /\x1b\[7mExecute/);
  assert.match(await enabled.finish('\r'), /1\r?\n\x1b\[0m\x1b\[\?2004l/);
});

test('the minimum viewport reserves title, content, notice, footer separator and keys without overlap', async t => {
  const f = await fixture(t, { rows: 6, cols: 50, items: ['Only-action'], env: { MENU_NOTICE: 'NOTICE-MARKER' } });
  const frame = f.output().split('\x1b[?2026h')[1].split('\x1b[?2026l')[0];
  const line = row => new RegExp(`\\x1b\\[${row};1H\\x1b\\[0m(.*?)\\x1b\\[K`, 's').exec(frame)?.[1];
  assert.match(line(3), /Only-action/); assert.match(line(4), /NOTICE-MARKER/);
  assert.equal(line(2), line(5), 'footer separator matches the heading');
  assert.match(line(5), /─{49}/); assert.match(line(6), /「Esc」返回/);
  await f.finish('\r');
  const small = await fixture(t, { rows: 5 });
  await small.finish('', 1);
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

test('clipping reserves ellipsis columns at every Chinese/ASCII boundary', () => {
  const r = spawnSync('bash', ['-c', 'source "$1"; export LC_ALL=C.UTF-8; for ((limit=0; limit<40; limit++)); do for text in 中文中文中文中文中文中文中文中文中文中文 "AAAA中文AAAA中文AAAA中文AAAA" 中文中文中文中文; do menu_clip "$text" "$limit"; (( MENU_WIDTH <= limit )) || { printf "limit=%s width=%s text=%s\\n" "$limit" "$MENU_WIDTH" "$MENU_TEXT"; exit 1; }; done; done', '_', resolve('lib/menu.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('menu labels cannot inject terminal escapes, and CJK labels are clipped without byte corruption', async t => {
  const f = await fixture(t, { rows: 10, cols: 36, title: '项目\x1b[31m\n标题', items: ['中文名称'.repeat(50) + '🟢', '返回'] });
  const output = await f.finish('\r');
  assert(!output.includes('\x1b[31m')); assert(!output.includes('\ufffd'));
  const frame = output.split('\x1b[?2026h')[1].split('\x1b[?2026l')[0];
  assert(frame.includes('…'));
  for (const line of frame.split(/\x1b\[\d+;1H/).filter(Boolean)) {
    const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    const conservativeWidth = [...plain].reduce((n, c) => n + (c.charCodeAt(0) > 127 && c !== '─' ? 2 : 1), 0);
    assert(conservativeWidth < 36, line);
  }
});
