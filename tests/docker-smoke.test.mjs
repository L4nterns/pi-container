import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./docker-smoke.sh', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-smoke-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const assertions = path.join(root, 'assertions');
  await fs.mkdir(bin);
  await fs.mkdir(assertions);
  for (const [name, body] of Object.entries({
    id: "console.log(process.env.BAD_UID ? '0' : '12345');",
    grep: 'process.exitCode = process.env.BAD_PRIVS ? 1 : 0;',
    touch: "require('node:fs').writeFileSync(process.env.ASSERTION_PASSED, 'yes');",
  })) {
    await fs.writeFile(path.join(assertions, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  }
  // Emulate only the Docker CLI boundary. Assertion bodies run in real Bash;
  // container privilege/mount behavior remains covered by the real Docker CI job.
  await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'run') {
  const mount = a.find(x => x.includes('target=/vibe-projects'));
  const sites = mount.split(',').find(x => x.startsWith('source=')).slice(7);
  fs.writeFileSync(process.env.STATE, JSON.stringify({ sites }));
} else if (a.includes('--pi-docker-shell')) {
  const args = a.slice(a.indexOf('--pi-docker-shell') + 1);
  const result = spawnSync('bash', args, { env: { ...process.env, PATH: process.env.ASSERTION_BIN + ':' + process.env.PATH }, stdio: 'inherit' });
  process.exitCode = result.status;
} else if (a.includes('/opt/pi-docker/skills/vibe-projects/scripts/publish.mjs')) {
  const { sites } = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
  const target = path.join(sites, 'smoke');
  if (fs.existsSync(target)) process.exitCode = 1;
  else { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'index.html'), 'ok'); }
}
`, { mode: 0o755 });
  return async (env = {}) => {
    const log = path.join(root, 'log');
    const state = path.join(root, 'state');
    const passed = path.join(root, 'passed');
    const result = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, STATE: state,
        ASSERTION_BIN: assertions, ASSERTION_PASSED: passed, BAD_UID: '', BAD_PRIVS: '', ...env },
    });
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const assertionPassed = await fs.access(passed).then(() => true, () => false);
    const chown = calls.findIndex(a => a.includes('chown'));
    const remove = calls.findIndex(a => a[0] === 'rm');
    assert.ok(chown >= 0 && chown < remove, 'ownership restored before container removal');
    const run = calls.find(a => a[0] === 'run');
    const tmp = path.dirname(run.find(x => x.includes('target=/vibe-projects')).split(',').find(x => x.startsWith('source=')).slice(7));
    await assert.rejects(fs.access(tmp), 'temporary files should be removed');
    return { ...result, calls, assertionPassed };
  };
}

test('smoke tests publish with the host UID and clean temporary ownership before removing the container', async t => {
  const run = await fixture(t);
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.assertionPassed);
  const publications = result.calls.filter(a => a.includes('/opt/pi-docker/skills/vibe-projects/scripts/publish.mjs'));
  assert.equal(publications.length, 2);
  for (const args of publications) {
    assert.equal(args[args.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
  }
});

for (const failure of ['BAD_UID', 'BAD_PRIVS']) {
  test(`smoke test fails immediately on ${failure}, preserves failure status and still cleans up`, async t => {
    const run = await fixture(t);
    const result = await run({ [failure]: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.assertionPassed, 'a failed assertion must not fall through to touch');
    assert.ok(!result.calls.some(a => a.includes('/opt/pi-docker/skills/vibe-projects/scripts/publish.mjs')));
  });
}
