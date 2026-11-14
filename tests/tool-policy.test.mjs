import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { decideTimeout, DEFAULT_TIMEOUT_SECONDS, HARD_MAX_TIMEOUT_SECONDS, WARN_TIMEOUT_SECONDS } from '../extensions/tool-policy/src/policy.ts';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('shell timeout policy bounds silent commands without imposing fallback semantics', () => {
  assert.deepEqual(decideTimeout(undefined), { timeout: DEFAULT_TIMEOUT_SECONDS });
  assert.deepEqual(decideTimeout(''), { timeout: DEFAULT_TIMEOUT_SECONDS });
  assert.deepEqual(decideTimeout(30), { timeout: 30 });
  assert.equal(decideTimeout(WARN_TIMEOUT_SECONDS + 1).timeout, WARN_TIMEOUT_SECONDS + 1);
  assert.match(decideTimeout(WARN_TIMEOUT_SECONDS + 1).notice, /长任务/);
  assert.deepEqual(decideTimeout(HARD_MAX_TIMEOUT_SECONDS + 1), { timeout: HARD_MAX_TIMEOUT_SECONDS, notice: `命令超时 ${HARD_MAX_TIMEOUT_SECONDS + 1}s 超过上限；已限制为 ${HARD_MAX_TIMEOUT_SECONDS}s` });
  assert.deepEqual(decideTimeout(0.5), { timeout: 1, notice: '命令超时 0.5s 低于最小值；已使用 1s' });
  assert.match(decideTimeout(-1).notice, /无效/);
});

test('Pi terminates a timed-out shell process tree', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-policy-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const tool = createBashTool(dir, { exposeSessionEnvironment: false });
  const started = Date.now();
  await assert.rejects(
    tool.execute('timeout-test', { command: `echo $$ > ${quote(pidFile)}; sleep 30`, timeout: 1 }, undefined, undefined),
    /Command timed out after 1 seconds/,
  );
  assert(Date.now() - started < 5000, 'timeout must stop the shell promptly');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert(Number.isInteger(pid) && pid > 0);
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`timed-out shell process ${pid} survived`);
});

test('image packages the tool policy extension and seeds the context rules', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(new URL('../config/pi-bootstrap.json', import.meta.url), 'utf8'));
  assert(manifest.packages.some(item => item.source === '/opt/pic/extensions/tool-policy' && item.name === 'pi-tool-policy'));
  assert.match(await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8'), /COPY extensions\/tool-policy\//);
  assert.match(await fs.readFile(new URL('../pic-entrypoint.sh', import.meta.url), 'utf8'), /config\/AGENTS\.md/);
  assert.match(await fs.readFile(new URL('../config/AGENTS.md', import.meta.url), 'utf8'), /git grep/);
});
