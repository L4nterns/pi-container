import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, 'tool');
  const project = path.join(root, 'project with spaces');
  const fakeBin = path.join(root, 'fake-bin');
  const log = path.join(root, 'docker.jsonl');
  for (const dir of [path.join(tool, 'bin'), path.join(tool, 'lib'), project, fakeBin]) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const file of ['bin/pi-docker', 'lib/session-lifecycle.sh', 'compose.yaml', 'compose.vibe.yaml', '.env.example']) {
    await fs.copyFile(path.join(repo, file), path.join(tool, file));
  }
  // No daemon: record invocations at the Docker CLI boundary, not inside the wrapper.
  await fs.writeFile(path.join(fakeBin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, workspace: process.env.PI_WORKSPACE, image: process.env.PI_DOCKER_IMAGE }) + '\\n');
if (args.includes('config') && args.includes('--environment')) {
  for (const key of ['VIBE_PROJECTS_HOST_DIR', 'VIBE_PUBLIC_URL']) console.log(key + '=' + (process.env[key] || ''));
} else if (args.includes('ps') && args.includes('-q')) {
  console.log('fake-container');
} else if (args[0] === 'inspect') {
  console.log(process.env.FAKE_EXECS || '0');
} else if (args.includes('exec')) {
  process.exitCode = Number(process.env.FAKE_EXIT || 0);
}
`, { mode: 0o755 });
  async function run(args = [], env = {}, cwd = project) {
    const result = spawnSync('bash', [path.join(tool, 'bin/pi-docker'), ...args], {
      cwd, encoding: 'utf8', env: {
        ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: log,
        VIBE_PROJECTS_HOST_DIR: '', VIBE_PUBLIC_URL: '', ...env,
      }, timeout: 10000,
    });
    const calls = (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
    await fs.writeFile(log, '');
    return { ...result, calls };
  }
  return { tool, root, project, run };
}

test('help/unknown commands do not invoke Docker or create runtime data', async t => {
  const { tool, run } = await fixture(t);
  assert.equal((await run(['--help'])).status, 0);
  const bad = await run(['unknown']);
  assert.equal(bad.status, 2);
  assert.deepEqual(bad.calls, []);
  await assert.rejects(fs.access(path.join(tool, '.runtime')));
  await assert.rejects(fs.access(path.join(tool, 'data')));
});

test('forwards Bash args as separate arguments, uses non-TTY exec and stops after exit', async t => {
  const { project, run } = await fixture(t);
  const result = await run(['shell', '-c', 'printf "hello world"']);
  assert.equal(result.status, 0, result.stderr);
  const exec = result.calls.find(x => x.args.includes('exec'));
  assert.ok(exec.args.includes('-T'));
  assert.deepEqual(exec.args.slice(-3), ['--pi-docker-shell', '-c', 'printf "hello world"']);
  assert.equal(exec.workspace, project);
  assert.ok(result.calls.some(x => x.args.includes('stop')));
  const up = result.calls.find(x => x.args.includes('up'));
  assert.match(up.args[up.args.indexOf('--project-name') + 1], /^pi-r[0-9a-f]{8}-u\d+-[0-9a-f]{16}$/);
});

test('preserves application exit code and does not stop raw external exec sessions', async t => {
  const { run } = await fixture(t);
  const failed = await run([], { FAKE_EXIT: '29' });
  assert.equal(failed.status, 29);
  assert.ok(failed.calls.some(x => x.args.includes('stop')));
  const external = await run([], { FAKE_EXECS: '1' });
  assert.equal(external.status, 0);
  assert.ok(!external.calls.some(x => x.args.includes('stop')));
});

test('maintenance works without optional publishing config; build flags precede service', async t => {
  const { tool, run } = await fixture(t);
  await fs.writeFile(path.join(tool, '.env'), 'not a valid dotenv file');
  const built = await run(['build', '--build-arg', 'NPM_REGISTRY=https://example.com']);
  assert.equal(built.status, 0);
  assert.deepEqual(built.calls[0].args.slice(-4), ['build', '--build-arg', 'NPM_REGISTRY=https://example.com', 'pi']);
  const stopped = await run(['stop']);
  assert.equal(stopped.status, 0);
  assert.ok(!stopped.calls.some(x => x.args.includes('config')));
  const down = await run(['down']);
  assert.equal(down.status, 0);
  assert.ok(down.calls.some(x => x.args.includes('down')));
});

test('publishing uses the resolved config and rejects unsafe root/workspace paths', async t => {
  const { project, root, run } = await fixture(t);
  const sites = path.join(root, 'sites');
  await fs.mkdir(sites);
  const env = { VIBE_PROJECTS_HOST_DIR: sites, VIBE_PUBLIC_URL: 'https://example.com' };
  const valid = await run([], env);
  assert.equal(valid.status, 0, valid.stderr);
  assert.ok(valid.calls.find(x => x.args.includes('up')).args.some(x => x.endsWith('compose.vibe.yaml')));
  for (const dir of ['/', project]) {
    const result = await run([], { ...env, VIBE_PROJECTS_HOST_DIR: dir });
    assert.equal(result.status, 1);
    assert.ok(!result.calls.some(x => x.args.includes('up')));
  }
  const noUrl = await run([], { VIBE_PROJECTS_HOST_DIR: sites });
  assert.equal(noUrl.status, 1);
});

test('build, start and recreate share a checkout-specific image, not another checkout or caller override', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const invocations = [
    await first.run(['build']),
    await first.run(['rebuild']),
    await first.run(['shell', '-c', 'true'], { PI_DOCKER_IMAGE: 'unrelated:caller-override' }),
    await first.run(['recreate']),
  ];
  const images = invocations.flatMap(result => {
    assert.equal(result.status, 0, result.stderr);
    return result.calls.map(call => call.image);
  });
  assert.ok(images.length > 0);
  assert.equal(new Set(images).size, 1);
  assert.match(images[0], /^pi-docker:r[0-9a-f]{8}$/);
  const other = await second.run(['build'], {}, first.project);
  assert.equal(other.status, 0, other.stderr);
  assert.notEqual(other.calls[0].image, images[0]);
});

test('rejects / as workspace before invoking Docker', async t => {
  const { run } = await fixture(t);
  const result = await run([], {}, '/');
  assert.equal(result.status, 2);
  assert.deepEqual(result.calls, []);
});
