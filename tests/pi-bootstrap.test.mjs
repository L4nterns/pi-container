import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/bootstrap-pi.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../scripts/run-pi.sh', import.meta.url));
const source = 'git:github.com/example/independent-provider';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn) {
  for (let n = 0; n < 200; n++) { if (await fn()) return; await sleep(25); }
  throw new Error('hosted package lifecycle timed out');
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pic-package-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'manifest.json'), log = join(dir, 'commands.jsonl'), fake = join(dir, 'pi');
  await writeFile(fake, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), [action, source] = args;
if (!['install', 'update'].includes(action)) {
  process.stdout.write('READY:' + process.pid + '\\n');
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(process.env.TEST_INSTALL_LOG, JSON.stringify(args) + '\\n');
  if (process.env.TEST_INSTALL_DELAY) await new Promise(r => setTimeout(r, Number(process.env.TEST_INSTALL_DELAY)));
  const status = process.env[action === 'install' ? 'TEST_INSTALL_STATUS' : 'TEST_UPDATE_STATUS'];
  if (status && status !== '0') process.exit(Number(status));
  if (action === 'install') {
    const file = process.env.PI_CODING_AGENT_DIR + '/settings.json';
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    settings.packages = [...(settings.packages ?? []), source];
    fs.writeFileSync(file, JSON.stringify(settings));
  }
}
`, { mode: 0o700 });
  await writeFile(manifest, JSON.stringify({ packages: [{ source, name: 'independent-provider' }] }));
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, PI_CODING_AGENT_DIR: dir, PIC_PI_BOOTSTRAP_MANIFEST: manifest, PIC_PI_BINARY: fake, TEST_INSTALL_LOG: log, PI_OFFLINE: '0' };
  return {
    dir, manifest, log, env,
    run: (extra = {}, args = []) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    commands: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    state: async () => JSON.parse(await readFile(join(dir, '.pic-packages.json'), 'utf8')),
  };
}

test('online bootstrap installs current source, then updates it on subsequent safe starts without provider rewrites', async t => {
  const s = await setup(t);
  const settings = { packages: [], theme: 'dark' };
  await writeFile(join(s.dir, 'settings.json'), JSON.stringify(settings));
  const files = { 'auth.json': '{"test":{"type":"api_key","key":"FAKE"}}', 'models.json': '{"providers":{}}' };
  for (const [name, value] of Object.entries(files)) await writeFile(join(s.dir, name), value);
  assert.equal(s.run().status, 0);
  const afterInstall = await readFile(join(s.dir, 'settings.json'), 'utf8');
  assert.equal(s.run().status, 0);
  assert.deepEqual(await s.commands(), [['install', source, '--no-approve'], ['update', source, '--no-approve']]);
  assert.equal(await readFile(join(s.dir, 'settings.json'), 'utf8'), afterInstall);
  assert.deepEqual(JSON.parse(afterInstall), { ...settings, packages: [source] });
  for (const [name, value] of Object.entries(files)) assert.equal(await readFile(join(s.dir, name), 'utf8'), value);
  assert.equal((await s.state()).pending, undefined);
});
test('deliberate uninstall stays uninstalled despite automatic update checks', async t => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  await writeFile(join(s.dir, 'settings.json'), '{"packages":[]}');
  assert.equal(s.run().status, 0);
  assert.deepEqual(await s.commands(), [['install', source, '--no-approve']]);
  assert.equal(await readFile(join(s.dir, 'settings.json'), 'utf8'), '{"packages":[]}');
});
test('already configured local or explicitly pinned packages are preserved, never automatically migrated', async t => {
  const s = await setup(t), existing = join(s.dir, 'user-package');
  await mkdir(existing);
  await writeFile(join(existing, 'package.json'), '{"name":"independent-provider","version":"0.9.0"}');
  for (const entry of [existing, `${source}@${'a'.repeat(40)}`]) {
    const settings = JSON.stringify({ packages: [{ source: entry, extensions: ['src/index.ts'] }] });
    await writeFile(join(s.dir, 'settings.json'), settings);
    assert.equal(s.run().status, 0);
    assert.equal(await readFile(join(s.dir, 'settings.json'), 'utf8'), settings);
  }
  assert.deepEqual(await s.commands(), []);
});
test('local paths, malformed sources and invalid manifest fields fail before installation', async t => {
  const s = await setup(t);
  for (const item of [{ source: join(s.dir, 'local') }, { source: './local' }, { source: '--help' }, { source: 'git:' }, { source: 'git:invalid source' }, { source, name: '../invalid' }]) {
    await writeFile(s.manifest, JSON.stringify({ packages: [item] }));
    assert.notEqual(s.run().status, 0);
    await assert.rejects(access(s.log));
    await assert.rejects(access(join(s.dir, '.pic-packages.json')));
  }
});
test('initial failure remains incomplete; retry succeeds and read-only checks never install', async t => {
  const s = await setup(t);
  assert.notEqual(s.run({}, ['--check']).status, 0);
  assert.notEqual(s.run({ TEST_INSTALL_STATUS: '1' }).status, 0);
  assert.deepEqual((await s.state()).installed, []);
  assert.equal((await s.state()).pending, source);
  assert.notEqual(s.run({}, ['--check']).status, 0);
  assert.equal(s.run().status, 0);
  assert.equal(s.run({}, ['--check']).status, 0);
  assert.equal((await s.commands()).length, 2);
});
test('failed update blocks new startup and read-only joins until a successful retry', async t => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  assert.notEqual(s.run({ TEST_UPDATE_STATUS: '1' }).status, 0);
  assert.equal((await s.state()).pending, source);
  assert.notEqual(s.run({}, ['--check']).status, 0);
  assert.notEqual(s.run({ PI_OFFLINE: '1' }).status, 0);
  assert.equal((await s.commands()).length, 2);
  assert.equal(s.run().status, 0);
  assert.equal(s.run({}, ['--check']).status, 0);
  assert.deepEqual((await s.commands()).map(args => args[0]), ['install', 'update', 'update']);
});
test('offline mode uses a configured complete installation; missing install fails and empty manifest opts out', async t => {
  const s = await setup(t);
  assert.notEqual(s.run({ PI_OFFLINE: '1' }).status, 0);
  assert.deepEqual(await s.commands(), []);
  assert.equal(s.run().status, 0);
  assert.equal(s.run({ PI_OFFLINE: '1' }).status, 0);
  assert.equal((await s.commands()).length, 1);
  await writeFile(s.manifest, '{"packages":[]}');
  assert.equal(s.run().status, 0);
  assert.equal(s.run({}, ['--check']).status, 0);
});
test('pic follows the public plugin default branch without a ref, version or bundled implementation', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, 'config/pi-bootstrap.json'), 'utf8'));
  assert.deepEqual(manifest.packages, [{ source: 'git:github.com/L4nterns/pi-provider-gateway', name: 'pi-provider-gateway' }]);
  await assert.rejects(access(join(root, 'packages')));
  const image = await readFile(join(root, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(image, /COPY\s+packages\/|\/opt\/pic\/packages\/|pi-provider-gateway\/src/);
  assert.match(image, /COPY scripts\/bootstrap-pi\.mjs scripts\/run-pi\.sh \/opt\/pic\/scripts\//);
  const entrypoint = await readFile(join(root, 'pic-entrypoint.sh'), 'utf8');
  assert.doesNotMatch(entrypoint, /node \/opt\/pic\/scripts\/bootstrap-pi/);
  assert.match(entrypoint, /if \[ "\$\{1:-\}" = start \]; then\n[^\n]+run-pi\.sh --hosted/);
  assert.match(await readFile(join(root, 'scripts/pic-session.sh'), 'utf8'), /new-session[^\n]+run-pi\.sh --prepared/);
});

test('shared process-lifetime lease defers updates across active Pi processes and retries after the last exits', { skip: process.getuid?.() === 0 ? 'hosted Pi must run unprivileged' : false }, async t => {
  const s = await setup(t), processes = [];
  t.after(async () => {
    for (const proc of processes) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await Promise.all(processes.map(proc => proc.exitCode !== null || proc.signalCode !== null ? undefined : new Promise(resolve => proc.once('exit', resolve))));
  });
  const launch = (extra = {}) => {
    const proc = spawn('bash', [launcher], { env: { ...s.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(proc);
    let output = '', errors = '';
    proc.stdout.on('data', data => output += data);
    proc.stderr.on('data', data => errors += data);
    return { proc, get output() { return output; }, get errors() { return errors; } };
  };
  const first = launch({ TEST_INSTALL_DELAY: '250' });
  await wait(async () => (await s.commands()).length === 1);
  const second = launch();
  await wait(() => first.output.includes('READY:') && second.output.includes('READY:'));
  assert.equal((await s.commands()).length, 1, 'concurrent starters must share one initial install');
  assert.equal(spawnSync('flock', ['-n', '-x', join(s.dir, '.pic-packages.lock'), 'true']).status, 1, 'exec Pi must retain its shared lease');
  first.proc.kill('SIGTERM');
  await wait(() => first.proc.signalCode !== null);
  const third = launch();
  await wait(() => third.output.includes('READY:'));
  assert.equal((await s.commands()).length, 1, 'one remaining live Pi is enough to defer updates');
  assert.match(third.errors, /本次不更新插件/);
  second.proc.kill('SIGTERM'); third.proc.kill('SIGTERM');
  await wait(() => second.proc.signalCode !== null && third.proc.signalCode !== null);
  const fourth = launch();
  await wait(() => fourth.output.includes('READY:'));
  assert.deepEqual((await s.commands()).map(args => args[0]), ['install', 'update']);
  assert.equal(Number(first.output.match(/READY:(\d+)/)[1]), first.proc.pid, 'launcher must exec native Pi, not leave a replacement supervisor');
});
