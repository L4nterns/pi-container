import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable, PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { sendBundle, receiveBundle, validateManifest, publicUrl, checkOperation, parseRemoteCommand } from '../services/protocol.mjs';
import { Manager, nginxConfig } from '../services/manager.mjs';

const key = 'ssh-ed25519 ' + 'A'.repeat(68);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devctl-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'bundle'), target = path.join(root, 'received');
  await fs.mkdir(source); await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'app-deploy.json'), JSON.stringify({ command: ['node', 'server.mjs'], healthPath: '/health', readyTimeout: 2 }));
  await fs.writeFile(path.join(source, 'server.mjs'), `import http from 'node:http'; http.createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),process.env.HOST);`);
  const manager = new Manager(root, { system: false }); await manager.load();
  t.after(() => manager.shutdown());
  return { root, source, target, manager };
}
async function bundle(source) {
  const stream = new PassThrough(), chunks = [];
  stream.on('data', c => chunks.push(c));
  await sendBundle(source, stream); stream.end();
  return Readable.from(Buffer.concat(chunks));
}
test('failed first deployment leaves no app tree and can be retried with a fresh runtime identity', async t => {
  const { root, source, manager } = await fixture(t);
  const original = await fs.readFile(path.join(source, 'server.mjs'));
  const uid = manager.installation.nextUid;
  await fs.writeFile(path.join(source, 'server.mjs'), 'process.exit(1)');
  await assert.rejects(manager.command('deploy', 'demo', await bundle(source)), /启动失败/);
  assert.ok(!Object.hasOwn(manager.apps, 'demo'));
  await assert.rejects(fs.access(path.join(root, 'apps', 'demo')), { code: 'ENOENT' });
  await fs.writeFile(path.join(source, 'server.mjs'), original);
  assert.equal((await manager.command('deploy', 'demo', await bundle(source))).state, 'ready');
  assert.ok(manager.apps.demo.uid > uid);
});
test('launcher uses persisted definition from a pipe instead of a writable artifact manifest', async t => {
  const { source } = await fixture(t);
  await fs.writeFile(path.join(source, 'app-deploy.json'), '{"command":["missing-command"]}');
  const child = spawn(process.execPath, [new URL('../services/launch.mjs', import.meta.url).pathname], { cwd: source, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => child.once('close', resolve));
  let output = '', error = '';
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => error += c);
  child.stdio[3].end(JSON.stringify({ command: [process.execPath, '-e', 'console.log(process.env.APP_TEST)'], env: { APP_TEST: 'persisted' } }));
  assert.equal(await exit, 0, error); assert.equal(output.trim(), 'persisted');
});

test('bundle preserves executable files and hidden framework output', async t => {
  const { source, target } = await fixture(t);
  await fs.writeFile(path.join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o700 });
  await fs.mkdir(path.join(source, '.next')); await fs.writeFile(path.join(source, '.next', 'BUILD_ID'), 'id');
  assert.equal((await receiveBundle(await bundle(source), target)).files, 4);
  assert.equal((await fs.stat(path.join(target, 'run.sh'))).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(target, '.next', 'BUILD_ID'), 'utf8'), 'id');
});
test('bundle rejects secrets, symlinks, traversal, duplicate entries, truncation and trailing bytes', async t => {
  const { source, target } = await fixture(t);
  await fs.writeFile(path.join(source, '.env'), 'secret'); await assert.rejects(bundle(source), /敏感路径/);
  await fs.unlink(path.join(source, '.env')); await fs.symlink('server.mjs', path.join(source, 'link'));
  await assert.rejects(bundle(source), /符号链接/);
  for (const data of [
    '{"path":"../escape","size":1,"executable":false}\nx',
    '{"path":"a","size":10,"executable":false}\nx',
    '{"path":"a","size":0,"executable":false}\n{"path":"a","size":0,"executable":false}\n',
    '{"end":true}\nextra', '{"path":"b","size":536870913,"executable":false}\n',
  ]) await assert.rejects(receiveBundle(Readable.from('APP-DEPLOY/1\n' + data), target));
});
test('manifest and public URL enforce reserved variables and host routing', () => {
  assert.deepEqual(validateManifest({ command: ['node'] }), { command: ['node'], env: {}, healthPath: '/', readyTimeout: 30 });
  for (const m of [{ command: [] }, { command: 'sh' }, { command: ['node'], env: { PORT: '1' } }, { command: ['node'], env: { APP_DATA_DIR: '/tmp' } }, { command: ['node'], healthPath: '//bad' }, { command: ['node'], extra: true }]) assert.throws(() => validateManifest(m));
  assert.equal(publicUrl('', 'demo'), null);
  assert.equal(publicUrl('https://app-{app}.example.com', 'demo'), 'https://app-demo.example.com/');
  for (const url of ['https://example.com/{app}/', 'https://{app}.example.com', 'https://app-{app}.example.com/?a=1']) assert.throws(() => publicUrl(url, 'demo'));
});
test('installation registration and token are stable, runtime users cannot authenticate', async t => {
  const { root, manager } = await fixture(t);
  assert.deepEqual(await manager.register(key), { user: 'deploy' });
  assert.deepEqual(await manager.register(key), { user: 'deploy' });
  assert.equal(manager.authenticate('deploy', manager.installation.token), true);
  assert.equal(manager.authenticate('app20000', manager.installation.token), false);
  assert.equal(manager.authenticate('deploy', '0'.repeat(64)), false);
  await assert.rejects(manager.register('../root'));
  assert.match(await fs.readFile(path.join(root, 'control', 'authorized_keys'), 'utf8'), /^restrict,command="\/usr\/local\/bin\/deploy-gateway" /);
  const restored = new Manager(root, { system: false }); await restored.load();
  assert.equal(restored.installation.token, manager.installation.token);
});
test('shared applications survive source deletion, restart, failed replacement and recovery', async t => {
  const { root, source, manager } = await fixture(t);
  assert.equal((await manager.command('deploy', 'demo', await bundle(source))).state, 'ready');
  const original = manager.apps.demo;
  const data = path.join(root, 'apps', 'demo', 'data', 'keep'); await fs.writeFile(data, 'durable');
  await manager.command('deploy', 'other', await bundle(source));
  assert.notEqual(manager.apps.demo.uid, manager.apps.other.uid);
  assert.equal((await manager.command('list')).length, 2);
  await fs.writeFile(path.join(source, 'server.mjs'), 'process.exit(1)');
  await assert.rejects(manager.command('deploy', 'demo', await bundle(source)), /启动失败/);
  assert.equal(manager.apps.demo, original);
  await fs.copyFile(path.join(root, 'apps', 'demo', original.release, 'server.mjs'), path.join(source, 'server.mjs'));
  await manager.command('deploy', 'demo', await bundle(source));
  assert.equal(manager.apps.demo.uid, original.uid, 'updates preserve the per-application runtime identity');
  const child = manager.children.get('demo').child;
  await manager.command('start', 'demo'); assert.equal(manager.children.get('demo').child, child);
  await manager.command('restart', 'demo'); assert.notEqual(manager.children.get('demo').child, child);
  await fs.rm(source, { recursive: true });
  await manager.shutdown();
  const restored = new Manager(root, { system: false }); await restored.load(); t.after(() => restored.shutdown());
  assert.ok(restored.children.has('demo'));
  await restored.command('restart', 'demo');
  assert.equal((await restored.command('status', 'demo')).internalHealthy, true);
  await restored.command('stop', 'demo'); assert.equal(restored.apps.demo.enabled, false);
  assert.equal((await restored.command('start', 'demo')).state, 'ready');
  assert.equal(await fs.readFile(data, 'utf8'), 'durable');
});
test('failed activation persistence preserves process and original release', async t => {
  const { root, source, manager } = await fixture(t);
  await manager.command('deploy', 'demo', await bundle(source)); const old = manager.apps.demo;
  const save = manager.save.bind(manager);
  manager.save = async (name, value) => { if (name === 'apps.json') throw new Error('disk failure'); return save(name, value); };
  await assert.rejects(manager.command('deploy', 'demo', await bundle(source)), /disk failure/);
  assert.equal(manager.apps.demo, old); assert.ok(!manager.children.get('demo').failed);
  assert.deepEqual((await fs.readdir(path.join(root, 'apps', 'demo'))).filter(n => n.startsWith('release-')), [old.release]);
});
test('delete removes only selected application and releases name without following runtime symlinks', async t => {
  const { root, source, manager } = await fixture(t);
  await manager.register(key);
  await manager.command('deploy', 'demo', await bundle(source)); const uid = manager.apps.demo.uid;
  await manager.command('deploy', 'other', await bundle(source));
  const dir = path.join(root, 'apps', 'demo'), outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'keep'); await fs.symlink(outside, path.join(dir, 'data', 'link'));
  await fs.mkdir(path.join(dir, '.cache')); await fs.writeFile(path.join(dir, '.cache', '.hidden'), 'x');
  assert.deepEqual(await manager.command('delete', 'demo'), { app: 'demo', state: 'deleted', dataPreserved: false });
  await assert.rejects(fs.access(dir), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
  assert.equal((await manager.command('list')).length, 1); assert.ok(manager.children.has('other'));
  await fs.access(path.join(source, 'app-deploy.json')); await fs.access(path.join(root, 'control', 'authorized_keys'));
  await manager.command('deploy', 'demo', await bundle(source)); assert.ok(manager.apps.demo.uid > uid);
});
for (const failure of ['intent', 'interruption', 'final']) test(`delete ${failure} failure is safe and retryable`, async t => {
  const { root, source, manager } = await fixture(t);
  await manager.command('deploy', 'demo', await bundle(source));
  const original = manager.apps.demo, child = manager.children.get('demo').child;
  const save = manager.save.bind(manager), finish = manager.finishDelete.bind(manager);
  if (failure === 'interruption') manager.finishDelete = async () => { throw new Error('injected'); };
  else manager.save = async (name, value) => {
    if (name === 'apps.json' && (failure === 'intent' || !Object.hasOwn(value, 'demo'))) throw new Error('injected');
    return save(name, value);
  };
  await assert.rejects(manager.command('delete', 'demo'), /injected/);
  if (failure === 'intent') {
    assert.equal(manager.apps.demo, original); assert.equal(manager.children.get('demo').child, child);
    await fs.access(path.join(root, 'apps', 'demo', original.release));
  } else {
    assert.equal(manager.apps.demo.deleting, true); assert.ok(!manager.children.has('demo'));
    await assert.rejects(manager.command('start', 'demo'), /正在删除/);
    await assert.rejects(manager.command('deploy', 'demo', Readable.from('')), /正在删除/);
  }
  manager.save = save; manager.finishDelete = finish;
  assert.equal((await manager.command('delete', 'demo')).state, 'deleted');
});
test('command and client argument validation requires explicit deletion confirmation', () => {
  for (const action of ['deploy', 'status', 'logs', 'start', 'restart', 'stop', 'delete']) {
    assert.deepEqual(checkOperation(action, 'demo'), { action, app: 'demo' });
    assert.deepEqual(parseRemoteCommand(`${action} demo${action === 'delete' ? ' --yes' : ''}`), { action, app: 'demo' });
  }
  for (const command of ['delete demo', 'list demo', 'stop demo --yes', 'sh', 'list; id']) assert.throws(() => parseRemoteCommand(command));
  const client = new URL('../bin/appctl.mjs', import.meta.url).pathname;
  for (const args of [[], ['list', 'demo'], ['delete', 'demo'], ['stop', 'demo', '--yes']]) {
    const result = spawnSync(process.execPath, [client, ...args], { encoding: 'utf8' }); assert.equal(result.status, 2); assert.equal(result.stderr, '');
  }
});
test('crash supervision and interrupted deletion recovery do not depend on a client session', async t => {
  const { root, source, manager } = await fixture(t);
  await manager.command('deploy', 'demo', await bundle(source));
  await manager.command('deploy', 'other', await bundle(source));
  const first = manager.children.get('other').child;
  first.kill('SIGKILL');
  for (let i = 0; i < 100 && manager.children.get('other')?.child === first; i++) await new Promise(r => setTimeout(r, 50));
  assert.notEqual(manager.children.get('other').child, first);
  manager.finishDelete = async () => { throw new Error('interrupted'); };
  await assert.rejects(manager.command('delete', 'demo'), /interrupted/);
  await manager.shutdown();
  const restored = new Manager(root, { system: false });
  restored.finishDelete = async () => { throw new Error('cleanup failed'); };
  await restored.load(); t.after(() => restored.shutdown());
  assert.equal(restored.apps.demo.deleting, true); assert.ok(restored.children.has('other'));
  await restored.shutdown();
  const recovered = new Manager(root, { system: false }); await recovered.load(); t.after(() => recovered.shutdown());
  assert.ok(!Object.hasOwn(recovered.apps, 'demo')); assert.ok(recovered.children.has('other'));
  await assert.rejects(fs.access(path.join(root, 'apps', 'demo')), { code: 'ENOENT' });
});
test('failed restart preserves the existing process and persisted release', async t => {
  const { root, source, manager } = await fixture(t);
  await manager.command('deploy', 'demo', await bundle(source));
  const app = manager.apps.demo, child = manager.children.get('demo').child;
  const release = path.join(root, 'apps', 'demo', app.release);
  await fs.writeFile(path.join(release, 'server.mjs'), 'process.exit(1)');
  await assert.rejects(manager.command('restart', 'demo'), /启动失败/);
  assert.equal(manager.children.get('demo').child, child); assert.equal(manager.apps.demo, app);
  await fs.access(release);
});

test('gateway uses validated host routing and streaming headers', () => {
  const config = nginxConfig({ demo: { enabled: true, port: 23456 }, stopped: { enabled: false, port: 23457 } });
  assert.match(config, /app-demo/); assert.doesNotMatch(config, /app-stopped/); assert.match(config, /error_log stderr warn;/);
  assert.match(config, /proxy_buffering off/); assert.match(config, /X-Forwarded-Proto \$http_x_forwarded_proto/);
  assert.throws(() => nginxConfig({ 'injected;': { enabled: true, port: 23456 } }));
});
