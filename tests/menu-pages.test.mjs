import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pty } from './helpers/pty.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, operation) {
  const dir = await mkdtemp(join(tmpdir(), 'pic-menu-page-'));
  const file = join(dir, 'output');
  await writeFile(file, Array.from({ length: 30 }, (_, i) => `LINE-${i + 1} 中文`).join('\n') + '\n\x1b[31mERROR-MARKER\x1b[0m\n');
  const proc = pty.spawn('bash', ['-c', `
source "$1"
saved=$(stty -g)
menu_screen_open
${operation}
result=$?
menu_screen_close
[[ $(stty -g) == "$saved" ]] && restored=yes || restored=no
printf '\\nDONE:%s RESTORED:%s\\n' "$result" "$restored"
`, 'page-test', resolve('lib/menu.sh'), file], { cwd: dir, env: { PATH: process.env.PATH, TERM: 'xterm-256color', LC_ALL: 'C.UTF-8' }, rows: 10, cols: 100 });
  let output = '', ended = false, timedOut = false;
  proc.onData(data => output += data);
  const exit = new Promise(resolve => proc.onExit(result => { ended = true; resolve(result); }));
  const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 8000);
  t.after(async () => { clearTimeout(timeout); if (!ended) proc.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); });
  async function wait(text) {
    for (let i = 0; i < 300 && !output.includes(text) && !ended; i++) await sleep(15);
    assert(output.includes(text), output);
  }
  return { proc, wait, output: () => output, ended: () => ended, async finish(keys, status = 0) {
    proc.write(keys);
    const result = await exit; clearTimeout(timeout);
    assert(!timedOut, output); assert.equal(result.exitCode, 0, output);
    assert(output.includes(`DONE:${status} RESTORED:yes`), output);
    assert.equal((output.match(/\x1b\[\?1049h/g) ?? []).length, 1);
    assert.equal((output.match(/\x1b\[\?1049l/g) ?? []).length, 1);
    return output;
  } };
}

test('output pages ignore Enter, page through diagnostics and return with a single Esc', async t => {
  const f = await fixture(t, 'menu_view "结果" "$2"');
  await f.wait('「Esc」返回');
  f.proc.write('\r'); await sleep(100);
  assert(!f.ended(), 'Enter must not dismiss a result page');
  f.proc.write('\x1b[6~'); await f.wait('7–12 / 31');
  f.proc.write('\x1b[F'); await f.wait('ERROR-MARKER');
  f.proc.write('\x1b[H'); await f.wait('LINE-1');
  const out = await f.finish('\x1b');
  assert(!out.includes('\x1b[31m'), 'captured log escape sequences are data, not instructions');
  assert(!out.includes('\x1b[2J'), 'scrolling and paging never erase the whole screen');
  assert.equal((out.match(/\x1b\[1m结果/g) ?? []).length, 1, 'unchanged heading is not repainted');
  assert(out.includes('\x1b[10;1H\x1b[0m「Esc」返回 · 「↑/↓」滚动 · 「PgUp/PgDn」翻页'));
  assert(out.includes('\x1b[9;1H'), 'line counts live in the footer, not above the content');
  assert(!out.includes('\ufffd'));
});

test('build input isolates pasted newlines and restores the TTY on confirmation or cancellation', async t => {
  const f = await fixture(t, 'value=$(menu_input "构建镜像" "KEY=value"); result=$?; printf "VALUE:%s\\n" "$value"; (exit "$result")');
  await f.wait('「Enter」下一项');
  f.proc.write('\x1b[200~OPTION=value\r\x1b[201~'); await sleep(100);
  assert(!f.output().includes('VALUE:'), 'pasted Enter must not start a build');
  assert((await f.finish('\r')).includes('VALUE:OPTION=value'));
  const cancelled = await fixture(t, 'menu_input "构建镜像" "KEY=value"');
  await cancelled.wait('「Enter」下一项'); await cancelled.finish('\x1b', 1);
});
