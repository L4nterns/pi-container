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
  for (const file of ['bin/devctl', 'lib/session-lifecycle.sh', 'lib/deployment.sh', 'compose.yaml', 'compose.deploy.yaml', 'compose.services.yaml', '.env.example']) {
    await fs.copyFile(path.join(repo, file), path.join(tool, file));
  }
  await fs.writeFile(path.join(fakeBin, 'ssh-keygen'), `#!/bin/sh
while [ "$1" != '-f' ]; do shift; done
printf 'test-only-not-a-key' > "$2"
printf 'ssh-ed25519 %s\\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' > "$2.pub"
`, { mode: 0o755 });
  await fs.writeFile(path.join(fakeBin, 'id'), `#!/bin/sh
case "$1" in -u|-g) printf '%s\\n' "\${FAKE_UID:-1000}" ;; -G) printf '1000\\n' ;; esac
`, { mode: 0o755 });
  // No daemon: record invocations at the Docker CLI boundary, not inside the wrapper.
  await fs.writeFile(path.join(fakeBin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, workspace: process.env.DEV_WORKSPACE, image: process.env.DEV_IMAGE, deployData: process.env.DEPLOY_DATA_DIR }) + '\\n');
if (args.includes('config') && args.includes('--environment')) {
  for (const key of ['DEPLOY_DATA_DIR', 'DEPLOY_PUBLIC_URL', 'DEPLOY_PORT']) console.log(key + '=' + (process.env[key] || ''));
} else if (args.includes('register')) {
  console.log(JSON.stringify({ user: 'deploy', hostKey: 'ssh-ed25519 ' + 'A'.repeat(68) }));
} else if (args.includes('node') && args.includes('-e')) {
  console.log('deploy\\nssh-ed25519 ' + 'A'.repeat(68));
} else if (args.includes('ps') && args.includes('-q')) {
  console.log('fake-container');
} else if (args[0] === 'inspect') {
  console.log(process.env.FAKE_EXECS || '0');
} else if (args.includes('exec')) {
  process.exitCode = Number(process.env.FAKE_EXIT || 0);
}
`, { mode: 0o755 });
  async function run(args = [], env = {}, cwd = project) {
    const result = spawnSync('bash', [path.join(tool, 'bin/devctl'), ...args], {
      cwd, encoding: 'utf8', env: {
        ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: log,
        DEPLOY_DATA_DIR: '', DEPLOY_PUBLIC_URL: '', DEPLOY_PORT: '18080', ...env,
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
  for (const command of ['unknown', 'root-shell']) {
    const bad = await run([command]);
    assert.equal(bad.status, 2);
    assert.deepEqual(bad.calls, []);
  }
  await assert.rejects(fs.access(path.join(tool, '.runtime')));
  await assert.rejects(fs.access(path.join(tool, 'data')));
});

test('forwards Bash args as separate arguments, uses non-TTY exec and stops after exit', async t => {
  const { project, run } = await fixture(t);
  const result = await run(['shell', '-c', 'printf "hello world"']);
  assert.equal(result.status, 0, result.stderr);
  const exec = result.calls.find(x => x.args.includes('exec'));
  assert.ok(exec.args.includes('-T'));
  assert.deepEqual(exec.args.slice(-3), ['--dev-shell', '-c', 'printf "hello world"']);
  assert.equal(exec.workspace, project);
  assert.ok(result.calls.some(x => x.args.includes('stop')));
  const up = result.calls.find(x => x.args.includes('up'));
  assert.match(up.args[up.args.indexOf('--project-name') + 1], /^dev-r[0-9a-f]{8}-u\d+-[0-9a-f]{16}$/);
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

test('deployment configuration rejects overlapping directories and never starts services without configuration', async t => {
  const { tool, project, run } = await fixture(t);
  for (const dir of ['/', project, tool, path.join(tool, 'bin'), path.join(tool, 'data'), path.join(tool, '.deploy-keys')]) {
    const result = await run([], { DEPLOY_DATA_DIR: dir });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.calls.some(x => x.args.includes('up')));
  }
  const absent = await run(['services', 'up']);
  assert.equal(absent.status, 1);
  const ordinary = await run(['shell', '-c', 'true']);
  assert.equal(ordinary.status, 0);
  assert.ok(!ordinary.calls.some(x => x.args.some(a => a.endsWith('compose.services.yaml'))));
});

test('installation-relative deployment data is resolved, created and private, independent of the caller working directory', async t => {
  const { tool, project, run } = await fixture(t);
  const result = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: './services-data' });
  assert.equal(result.status, 0, result.stderr);
  const directory = path.join(tool, 'services-data');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  await assert.rejects(fs.access(path.join(project, 'services-data')));
  const up = result.calls.find(x => x.args.includes('up') && x.args.includes('services'));
  assert.equal(up.deployData, directory);
  await fs.chmod(directory, 0o711);
  assert.equal((await run(['services', 'ps'], { DEPLOY_DATA_DIR: './services-data' })).status, 0);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o711, 'do not change permissions on an existing service tree');
});

test('workspace bind mounts cannot expose installation state, service data, or symlink aliases', async t => {
  const { tool, root, run } = await fixture(t);
  for (const workspace of [tool, root, path.join(tool, 'data'), path.join(tool, 'services-data')]) {
    await fs.mkdir(workspace, { recursive: true });
    const result = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: './services-data' }, workspace);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.calls.some(x => x.args.includes('up')));
  }
  const alias = path.join(root, 'service-alias');
  await fs.symlink(path.join(tool, 'services-data'), alias);
  const aliased = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: alias }, path.join(tool, 'services-data'));
  assert.equal(aliased.status, 1, aliased.stderr);
  const disabled = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: '' }, tool);
  assert.equal(disabled.status, 1, disabled.stderr);
});

test('invalid deployment ports and install subdirectories fail before directory creation or service startup', async t => {
  const { tool, root, run } = await fixture(t);
  for (const port of ['80', '65536', '01', 'x']) {
    const directory = path.join(root, 'not-created-' + port);
    const result = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: directory, DEPLOY_PORT: port });
    assert.equal(result.status, 1, result.stderr);
    await assert.rejects(fs.access(directory));
    assert.ok(!result.calls.some(x => x.args.includes('up')));
  }
  const invalid = path.join(tool, 'src', 'private');
  const result = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: invalid });
  assert.equal(result.status, 1, result.stderr);
  await assert.rejects(fs.access(invalid));
});

test('deployment provisions an installation key and shared control account without public URL or host Node dependency', async t => {
  const { tool, root, run } = await fixture(t);
  const services = path.join(root, 'service data');
  await fs.mkdir(services);
  const result = await run(['shell', '-c', 'true'], { DEPLOY_DATA_DIR: services });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(x => x.args.includes('--no-recreate') && x.args.includes('services')));
  assert.ok(result.calls.some(x => x.args.includes('register')));
  const up = result.calls.find(x => x.args.includes('up') && x.args.includes('pi'));
  assert.ok(up.args.some(x => x.endsWith('compose.deploy.yaml')));
  const dirs = await fs.readdir(path.join(tool, '.deploy-keys'));
  assert.equal(dirs.length, 1);
  assert.equal(await fs.readFile(path.join(tool, '.deploy-keys', dirs[0], 'user'), 'utf8'), 'deploy\n');
  await assert.rejects(fs.access(path.join(tool, 'data', 'id_ed25519')));
});

test('build, start and recreate share a checkout-specific image, not another checkout or caller override', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const invocations = [
    await first.run(['build']),
    await first.run(['rebuild']),
    await first.run(['shell', '-c', 'true'], { DEV_IMAGE: 'unrelated:caller-override' }),
    await first.run(['recreate']),
  ];
  const images = invocations.flatMap(result => {
    assert.equal(result.status, 0, result.stderr);
    return result.calls.map(call => call.image);
  });
  assert.ok(images.length > 0);
  assert.equal(new Set(images).size, 1);
  assert.match(images[0], /^devctl:r[0-9a-f]{8}$/);
  const other = await second.run(['build'], {}, first.project);
  assert.equal(other.status, 0, other.stderr);
  assert.notEqual(other.calls[0].image, images[0]);
});

test('host apps uses installation credentials without a source mount or project container', async t => {
  const { tool, root, project, run } = await fixture(t);
  const env = { DEPLOY_DATA_DIR: './services-data' };
  assert.equal((await run(['apps', 'list'], env, tool)).status, 0);
  const first = await fs.readFile(path.join(tool, '.deploy-keys', 'installation', 'id_ed25519'), 'utf8');
  await fs.rm(project, { recursive: true });
  const result = await run(['apps', 'restart', 'demo'], env, root);
  assert.equal(result.status, 0, result.stderr);
  const client = result.calls.find(c => c.args[0] === 'run');
  assert.ok(client); assert.ok(client.args.includes('--appctl'));
  assert.ok(!client.args.some(a => a.includes('target=/workspace')));
  assert.ok(!result.calls.some(c => c.args.includes('exec') && c.args.includes('pi')));
  assert.equal(await fs.readFile(path.join(tool, '.deploy-keys', 'installation', 'id_ed25519'), 'utf8'), first);
  assert.deepEqual(await fs.readdir(path.join(tool, '.deploy-keys')), ['installation']);
  const bad = await run(['apps', 'delete', 'demo'], env, root);
  assert.equal(bad.status, 2); assert.ok(!bad.calls.some(c => c.args.includes('register')));
});

test('rejects root user and / workspace before invoking Docker', async t => {
  const { run } = await fixture(t);
  const root = await run([], { FAKE_UID: '0' });
  assert.equal(root.status, 2);
  assert.deepEqual(root.calls, []);
  const result = await run([], {}, '/');
  assert.equal(result.status, 2);
  assert.deepEqual(result.calls, []);
});
