import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pty } from './helpers/pty.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, operation, { rows = 10, cols = 100 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pic-menu-page-'));
  const file = join(dir, 'output');
  await writeFile(file, Array.from({ length: 30 }, (_, i) => `LINE-${i + 1} 中文`).join('\n') + '\n\x1b[31mERROR-MARKER\x1b[0m\n');
  const proc = pty.spawn('bash', ['-c', `
source "$1"
saved=$(stty -g)
printf 'WRAPPER:%s\\n' "$BASHPID"
menu_screen_open
${operation}
result=$?
menu_screen_close
[[ $(stty -g) == "$saved" ]] && restored=yes || restored=no
printf '\\nDONE:%s RESTORED:%s\\n' "$result" "$restored"
`, 'page-test', resolve('lib/menu.sh'), file], { cwd: dir, env: { PATH: process.env.PATH, TERM: 'xterm-256color', LC_ALL: 'C.UTF-8', TMPDIR: dir }, rows, cols });
  let output = '', ended = false, timedOut = false;
  proc.onData(data => output += data);
  const exit = new Promise(resolve => proc.onExit(result => { ended = true; resolve(result); }));
  const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 8000);
  t.after(async () => { clearTimeout(timeout); if (!ended) proc.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); });
  async function wait(text) {
    for (let i = 0; i < 300 && !output.includes(text) && !ended; i++) await sleep(15);
    assert(output.includes(text), output);
  }
  return { dir, file, proc, wait, output: () => output, ended: () => ended, async finish(keys, status = 0) {
    proc.write(keys);
    const result = await exit; clearTimeout(timeout);
    assert(!timedOut, output); assert.equal(result.exitCode, 0, output);
    assert(output.includes(`DONE:${status} RESTORED:yes`), output);
    assert.equal((output.match(/\x1b\[\?1049h/g) ?? []).length, 1);
    assert.equal((output.match(/\x1b\[\?1049l/g) ?? []).length, 1);
    return output;
  } };
}

function assertFooter(output) {
  const frame = output.split('\x1b[?2026h')[1].split('\x1b[?2026l')[0];
  const heading = /\x1b\[2;1H\x1b\[0m(.*?)\x1b\[K/s.exec(frame)?.[1];
  const footer = /\x1b\[9;1H\x1b\[0m(.*?)\x1b\[K/s.exec(frame)?.[1];
  assert.match(footer, /─{99}/);
  assert.equal(footer, heading, 'footer and heading use the same separator');
}

test('output pages ignore Enter, page through diagnostics and return with a single Esc', async t => {
  const f = await fixture(t, 'menu_view "结果" "$2"');
  await f.wait('「Esc」返回'); assertFooter(f.output());
  f.proc.write('\r'); await sleep(100);
  assert(!f.ended(), 'Enter must not dismiss a result page');
  f.proc.write('\x1b[6~'); await f.wait('6–10 / 31');
  f.proc.write('\x1b[F'); await f.wait('ERROR-MARKER');
  f.proc.write('\x1b[H'); await f.wait('LINE-1');
  const out = await f.finish('\x1b');
  assert(!out.includes('\x1b[31m'), 'captured log escape sequences are data, not instructions');
  assert(!out.includes('\x1b[2J'), 'scrolling and paging never erase the whole screen');
  assert.equal((out.match(/\x1b\[1m结果/g) ?? []).length, 1, 'unchanged heading is not repainted');
  assert(out.includes('\x1b[10;1H\x1b[0m「Esc」返回 · 「↑/↓」滚动 · 「PgUp/PgDn」翻页'));
  assert(out.includes('\x1b[8;1H'), 'line counts live above the footer separator, not in the content');
  assert(!out.includes('\ufffd'));
});

test('confirmation selects its first action, Enter confirms, Esc cancels, and viewing the impact list never executes', async t => {
  for (const key of ['\r', '\x1b']) {
    const f = await fixture(t, 'MENU_CONTEXT="$(<"$2")" menu_confirm "会中断会话"');
    await f.wait('LINE-1'); await f.wait('「PgUp/PgDn」查看清单'); assertFooter(f.output());
    assert(f.output().includes('\x1b[7m确认'), 'first action is preselected');
    f.proc.write('\x1b[6~'); await f.wait('LINE-5');
    assert(!f.ended(), 'paging only views the impact list');
    const out = await f.finish(key, key === '\r' ? 0 : 1);
    assert(!out.includes('\x1b[2J')); assert(!out.includes('  取消'));
  }
  for (const key of ['\x1b[5~', '\x1b[6~', '\x1b[C']) {
    const f = await fixture(t, 'menu_confirm "会中断会话"');
    await f.wait('「Enter」确认');
    await f.finish(key + '\r');
  }
});

test('confirmation separates status and risk from its short question and the impact snapshot', async t => {
  const f = await fixture(t, 'MENU_CONTEXT="范围：测试容器" menu_confirm "仍要更新运行环境？" "检查更新" "开始更新" $\'状态：源码已是最新。\\n影响：会中断会话和应用。\'');
  await f.wait('仍要更新运行环境？');
  const frame = f.output().split('\x1b[?2026h')[1].split('\x1b[?2026l')[0];
  assert.match(frame, /\x1b\[3;1H[^\n]*\x1b\[7m开始更新/);
  assert.match(frame, /\x1b\[5;1H\x1b\[0m状态：源码已是最新。\x1b\[K/);
  assert.match(frame, /\x1b\[6;1H\x1b\[0m影响：会中断会话和应用。\x1b\[K/);
  assert.match(frame, /\x1b\[8;1H\x1b\[0m\x1b\[2m仍要更新运行环境？\x1b\[0m\x1b\[K/);
  await f.finish('\x1b', 1);
});

test('contextual actions cannot authorize in 6/7 rows and resume normally after resizing, with exact TTY restoration', async t => {
  for (const rows of [6, 7]) {
    const f = await fixture(t, 'MENU_CONTEXT="RISK-MARKER" menu_confirm "停止容器？"', { rows });
    await f.wait('说明不可见'); f.proc.write('\r\x1b[6~'); await sleep(100);
    assert(!f.ended(), 'Enter while risks are invisible cannot authorize or dismiss the confirmation');
    assert(!f.output().includes('RISK-MARKER'));
    const wrapper = /WRAPPER:(\d+)/.exec(f.output())[1];
    const resized = spawnSync('stty', ['--file', `/proc/${wrapper}/fd/0`, 'rows', '8', 'cols', '100'], { encoding: 'utf8' });
    assert.equal(resized.status, 0, resized.stderr); f.proc.write('\x1b[5~');
    await f.wait('RISK-MARKER'); await f.finish('\r');
  }
  const f = await fixture(t, 'MENU_CONTEXT="RISK-MARKER" menu_confirm "停止容器？"', { rows: 6 });
  await f.wait('说明不可见'); await f.finish('\x1b', 1);
});

test('a contextual menu reserves a scrollable body even when its actions exceed the viewport', async t => {
  const f = await fixture(t, 'MENU_CONTEXT=$\'TARGET-PATH\\nIMPACT-MARKER\' menu_select "项目操作" 状态 终端 日志 停止 删除', { rows: 8 });
  await f.wait('TARGET-PATH'); f.proc.write('\x1b[6~'); await f.wait('IMPACT-MARKER');
  await f.finish('\x1b', 1);
});

test('live progress shows output before completion, ignores Esc, and returns the exact worker failure', async t => {
  const f = await fixture(t, 'menu_progress "构建" "$2" bash -c \'printf "FIRST-MARKER\\n"; while ! test -f "$1.gate"; do sleep 0.05; done; printf "LAST-MARKER\\n"; exit 37\' _ "$2"');
  await f.wait('FIRST-MARKER'); assertFooter(f.output());
  assert(!f.ended()); f.proc.write('\x1b');
  await f.wait('Ctrl+C');
  await writeFile(f.file + '.gate', 'continue');
  const out = await f.finish('', 37);
  assert(out.includes('正在执行')); assert(!out.includes('\x1b[2J'));
});

test('interrupting live progress terminates its process group and restores terminal modes', async t => {
  const f = await fixture(t, 'menu_progress "构建" "$2" bash -c \'sleep 30 & printf "CHILD:%s\\n" "$!"; wait\'');
  await f.wait('CHILD:');
  const child = /CHILD:(\d+)/.exec(f.output())[1];
  await f.finish('\x03', 130);
  for (let n=0; n<100; n++) {
    try { const stat = await import('node:fs/promises').then(fs => fs.readFile(`/proc/${child}/stat`, 'utf8')); if (stat.split(' ')[2] === 'Z') return; }
    catch { return; }
    await sleep(20);
  }
  assert.fail('operation child survived interruption');
});

test('streaming capture is bounded on disk, retains the output tail and reports the real command status', async t => {
  const f = await fixture(t, 'menu_progress "构建" "$2" bash -c \'printf "FIRST-MARKER\\n"; head -c 3670016 /dev/zero | tr "\\\\0" x; printf "\\nFINAL-MARKER\\n"; while ! test -f "$1.gate"; do sleep 0.05; done; exit 37\' _ "$2"');
  await f.wait('FINAL-MARKER');
  assert(!f.ended(), 'final output must become visible before the command is allowed to finish');
  await writeFile(f.file + '.gate', 'continue');
  await f.finish('', 37);
  const data = await readFile(f.file, 'utf8');
  assert(Buffer.byteLength(data) <= 1048576);
  assert(data.endsWith('FINAL-MARKER\n'));
  assert(!data.includes('FIRST-MARKER'));
  assert.deepEqual((await readdir(f.dir)).sort(), ['output', 'output.gate']);
});

test('capture keeps only two chunks while running and preserves arbitrarily small writes immediately', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pic-capture-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const capture = join(dir, 'capture');
  await import('node:fs/promises').then(fs => fs.mkdir(capture));
  const result = spawnSync('bash', ['-c', 'source "$1"; menu_capture "$2" bash -c \'head -c 4194304 /dev/zero; printf TAIL; exit 23\'', '_', resolve('lib/menu.sh'), capture], { encoding: 'utf8' });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual((await readdir(capture)).sort(), ['current', 'previous', 'sequence']);
  const size = (await stat(join(capture, 'current'))).size + (await stat(join(capture, 'previous'))).size;
  assert(size <= 1048576);
  assert.equal(await readFile(join(capture, 'current'), 'utf8'), 'TAIL');
});

test('hangup and termination of live progress reap its child group and restore the TTY', async t => {
  for (const [signal, status] of [['HUP', 129], ['TERM', 143]]) {
    const f = await fixture(t, 'original=$(declare -f menu_tty_begin); eval "${original/menu_tty_begin/original_tty_begin}"; menu_tty_begin() { original_tty_begin && printf "RENDERER:%s\\n" "$BASHPID"; }; menu_progress "构建" "$2" bash -c \'sleep 30 & printf "CHILD:%s\\n" "$!"; wait\'');
    await f.wait('CHILD:');
    // The fixture records the real renderer PID at its TTY boundary.
    const child = Number(/CHILD:(\d+)/.exec(f.output())[1]);
    const renderer = Number(/RENDERER:(\d+)/.exec(f.output())[1]);
    process.kill(renderer, `SIG${signal}`);
    await f.finish('', status);
    for (let n=0; n<100; n++) {
      try { if ((await readFile(`/proc/${child}/stat`, 'utf8')).split(' ')[2] === 'Z') break; }
      catch { break; }
      await sleep(20); if (n === 99) assert.fail('operation child survived termination');
    }
  }
});

test('operation-time paste and queued navigation cannot authorize the following confirmation', async t => {
  const f = await fixture(t, 'menu_progress "构建" "$2" bash -c \'printf "FIRST-MARKER\\n"; while ! test -f "$1.gate"; do sleep 0.05; done\' _ "$2"; menu_confirm "下一项操作"');
  await f.wait('FIRST-MARKER');
  f.proc.write('x'.repeat(2048) + '\x1b[B\r'.repeat(10));
  await writeFile(f.file + '.gate', 'continue');
  await f.wait('下一项操作');
  await f.finish('\x1b', 1);
});

test('resizing live progress below menu dimensions does not cancel or invent a command failure', async t => {
  const f = await fixture(t, 'menu_progress "构建" "$2" bash -c \'printf "FIRST-MARKER\\n"; while ! test -f "$1.gate"; do sleep 0.05; done; printf "FINAL-MARKER\\n"; exit 37\' _ "$2"');
  await f.wait('FIRST-MARKER');
  const wrapper = /WRAPPER:(\d+)/.exec(f.output())[1];
  const resize = (rows, cols) => {
    const r = spawnSync('stty', ['--file', `/proc/${wrapper}/fd/0`, 'rows', String(rows), 'cols', String(cols)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  resize(3, 30); await f.wait('终端太小');
  assert(!f.ended(), 'the worker must survive a temporary narrow viewport');
  resize(10, 100); await writeFile(f.file + '.gate', 'continue');
  await f.finish('', 37);
});

test('deployment input preserves the initial value, isolates pasted newlines and restores the TTY', async t => {
  const f = await fixture(t, 'value=$(MENU_INPUT_VALUE=initial menu_input "部署配置" "数据目录"); result=$?; printf "VALUE:%s\\n" "$value"; (exit "$result")');
  await f.wait('> initial'); await f.wait('「Enter」采用当前输入'); assertFooter(f.output());
  f.proc.write('\x15\x1b[200~OPTION=value\r\x1b[201~'); await sleep(100);
  assert(!f.output().includes('VALUE:'), 'pasted Enter must not save a setting');
  assert((await f.finish('\r')).includes('VALUE:OPTION=value'));
  const cancelled = await fixture(t, 'menu_input "部署配置" "数据目录"');
  await cancelled.wait('「Enter」采用当前输入'); await cancelled.finish('\x1b', 1);
});
