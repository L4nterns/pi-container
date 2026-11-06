import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bootstrap = fileURLToPath(new URL('../scripts/bootstrap-pi.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));

test('native Pi advances an unpinned Git package to later remote commits; offline and failed refresh never claim latest', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pic-native-package-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'fixture'), remote = join(root, 'remote.git'), agent = join(root, 'agent'), project = join(root, 'project');
  for (const dir of [fixture, agent, project]) await mkdir(dir, { recursive: true });
  const source = 'git:github.com/example/pic-update-fixture', manifest = join(root, 'manifest.json'), binary = join(root, 'pi');
  await writeFile(manifest, JSON.stringify({ packages: [{ source, name: 'pic-update-fixture' }] }));
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8',
    PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '0',
    PIC_PI_BOOTSTRAP_MANIFEST: manifest, PIC_PI_BINARY: binary,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/example/pic-update-fixture',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
    NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_USERCONFIG: '/dev/null',
  };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const run = (extra = {}, args = []) => spawnSync(process.execPath, [bootstrap, ...args], { cwd: project, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  git(fixture, 'init', '-b', 'main');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(fixture, 'remote', 'add', 'origin', remote);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'pic-update-fixture', version: '1.0.0', type: 'module', pi: { extensions: [] }, scripts: { postinstall: 'touch lifecycle-script-ran' } }));
  const commit = async marker => {
    await writeFile(join(fixture, 'revision.txt'), marker);
    git(fixture, 'add', '.');
    git(fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', marker);
    git(fixture, 'push', 'origin', 'main');
    return git(fixture, 'rev-parse', 'HEAD');
  };
  const first = await commit('initial');
  const auth = '{"fixture":{"type":"api_key","key":"FAKE"}}', models = '{"providers":{}}';
  await writeFile(join(agent, 'auth.json'), auth);
  await writeFile(join(agent, 'models.json'), models);
  const install = run();
  assert.equal(install.status, 0, install.stderr);
  const checkout = join(agent, 'git', 'github.com', 'example', 'pic-update-fixture');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), first);
  await assert.rejects(access(join(checkout, 'lifecycle-script-ran')));
  const settings = await readFile(join(agent, 'settings.json'), 'utf8');
  const second = await commit('updated');
  const update = run();
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stderr, /Updating Pi package/);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), second);
  assert.equal(await readFile(join(checkout, 'revision.txt'), 'utf8'), 'updated');
  const third = await commit('next-update');
  assert.equal(run({ PI_OFFLINE: '1' }).status, 0);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), second, 'offline startup must not fetch the remote');
  await rename(remote, remote + '.unavailable');
  try {
    assert.notEqual(run().status, 0);
    assert.notEqual(run({}, ['--check']).status, 0, 'failed update must not authorize a concurrent new Pi');
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), second);
  } finally { await rename(remote + '.unavailable', remote); }
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), third);
  assert.equal(run({}, ['--check']).status, 0);
  assert.equal(await readFile(join(agent, 'settings.json'), 'utf8'), settings);
  assert.equal(await readFile(join(agent, 'auth.json'), 'utf8'), auth);
  assert.equal(await readFile(join(agent, 'models.json'), 'utf8'), models);
  await assert.rejects(access(join(checkout, 'lifecycle-script-ran')));
});
