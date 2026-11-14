import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decideTimeout, DEFAULT_TIMEOUT_SECONDS, HARD_MAX_TIMEOUT_SECONDS, WARN_TIMEOUT_SECONDS } from '../extensions/tool-policy/src/policy.ts';

test('shell timeout policy bounds silent commands without imposing fallback semantics', () => {
  assert.deepEqual(decideTimeout(undefined), { timeout: DEFAULT_TIMEOUT_SECONDS });
  assert.deepEqual(decideTimeout(''), { timeout: DEFAULT_TIMEOUT_SECONDS });
  assert.deepEqual(decideTimeout(30), { timeout: 30 });
  assert.equal(decideTimeout(WARN_TIMEOUT_SECONDS + 1).timeout, WARN_TIMEOUT_SECONDS + 1);
  assert.match(decideTimeout(WARN_TIMEOUT_SECONDS + 1).notice, /长任务/);
  assert.deepEqual(decideTimeout(HARD_MAX_TIMEOUT_SECONDS + 1), { timeout: HARD_MAX_TIMEOUT_SECONDS, notice: `命令超时 ${HARD_MAX_TIMEOUT_SECONDS + 1}s 超过上限；已限制为 ${HARD_MAX_TIMEOUT_SECONDS}s` });
  assert.match(decideTimeout(-1).notice, /无效/);
});

test('image packages the tool policy extension and seeds the context rules', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(new URL('../config/pi-bootstrap.json', import.meta.url), 'utf8'));
  assert(manifest.packages.some(item => item.source === '/opt/pic/extensions/tool-policy' && item.name === 'pi-tool-policy'));
  assert.match(await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8'), /COPY extensions\/tool-policy\//);
  assert.match(await fs.readFile(new URL('../pic-entrypoint.sh', import.meta.url), 'utf8'), /config\/AGENTS\.md/);
  assert.match(await fs.readFile(new URL('../config/AGENTS.md', import.meta.url), 'utf8'), /git grep/);
});
