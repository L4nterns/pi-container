import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../lib/workspace-access.sh', import.meta.url));
const hasAcl = spawnSync('sh', ['-c', 'command -v setfacl'], { encoding: 'utf8' }).status === 0;

test('root workspace ACLs preserve ownership, allow non-root edits and Git, never follow symlinks', {
  skip: process.getuid?.() !== 0 || !hasAcl ? 'requires root and acl in a disposable chroot; Docker smoke covers this path' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devctl-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const copied = new Set();
  async function copy(source, target = source) {
    if (copied.has(target)) return;
    const destination = path.join(root, target);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    copied.add(target);
  }
  for (const name of ['sh', 'id', 'find', 'setfacl', 'git', 'setpriv']) {
    const source = spawnSync('sh', ['-c', 'command -v "$1"', '_', name], { encoding: 'utf8' }).stdout.trim();
    assert.ok(source, `${name} must be installed`);
    await copy(source, name === 'sh' ? '/bin/sh' : `/usr/bin/${name}`);
    const dependencies = spawnSync('ldd', [source], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(dependencies.status, 0, dependencies.stderr);
    for (const match of dependencies.stdout.matchAll(/(?:=>\s+|^\s*)(\/\S+)/gm)) await copy(match[1]);
  }
  await copy(script, '/usr/bin/dev-workspace-init');
  for (const directory of ['etc', 'workspace', 'tmp', 'empty-templates', 'dev']) await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, 'etc/passwd'), 'root:x:0:0::/root:/bin/sh\nnode:x:12345:12345::/tmp:/bin/sh\n');
  await fs.writeFile(path.join(root, 'etc/group'), 'root:x:0:\nnode:x:12345:\n');
  await fs.writeFile(path.join(root, 'etc/nsswitch.conf'), 'passwd: files\ngroup: files\n');
  await fs.writeFile(path.join(root, 'dev/null'), '', { mode: 0o666 });
  await fs.chmod(path.join(root, 'dev/null'), 0o666);
  await fs.chmod(path.join(root, 'tmp'), 0o1777);
  const env = { PATH: '/usr/bin:/bin', HOME: '/tmp', LC_ALL: 'C' };
  const run = args => spawnSync('chroot', [root, ...args], { encoding: 'utf8', timeout: 10000, env });
  const ok = args => { const result = run(args); assert.equal(result.status, 0, result.stderr); return result; };
  const user = args => run(['setpriv', '--reuid', '12345', '--regid', '12345', '--clear-groups', '--no-new-privs', '--bounding-set=-all', ...args]);
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'tmp/private');
  await fs.chmod(workspace, 0o700);
  await fs.writeFile(path.join(workspace, 'private'), 'original', { mode: 0o600 });
  await fs.writeFile(path.join(workspace, 'executable'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(outside, 'outside', { mode: 0o600 });
  await fs.symlink('/tmp/private', path.join(workspace, 'link'));
  ok(['git', '-C', '/workspace', 'init', '--quiet', '--template=/empty-templates']);
  assert.notEqual(user(['sh', '-c', 'printf before > /workspace/private']).status, 0);
  // Git's actual root-ownership refusal must become a scoped trust exception.
  await fs.chmod(workspace, 0o755);
  const unsafe = user(['git', '-C', '/workspace', 'status', '--porcelain']);
  assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /dubious ownership/);
  await fs.chmod(workspace, 0o700);
  for (const uid of ['', '0', '-1', '123:4']) assert.notEqual(run(['sh', '/usr/bin/dev-workspace-init', uid]).status, 0);
  ok(['sh', '/usr/bin/dev-workspace-init', '12345']);
  const edited = user(['sh', '-ec', 'printf updated > /workspace/private; printf created > /workspace/new; /workspace/executable; git -C /workspace status --porcelain']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(await fs.readFile(path.join(workspace, 'private'), 'utf8'), 'updated');
  assert.equal((await fs.stat(path.join(workspace, 'private'))).uid, 0);
  assert.equal((await fs.stat(path.join(workspace, '.git'))).uid, 0);
  assert.equal((await fs.stat(path.join(workspace, 'new'))).uid, 12345);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o600);
  assert.notEqual(user(['sh', '-c', 'read value < /workspace/link']).status, 0, 'symlink target stays private');
  assert.notEqual(user(['sh', '-c', '/workspace/private']).status, 0, 'non-executable files stay non-executable');
  // Files made later by host root inherit ACLs if their creation mode allows it.
  await fs.mkdir(path.join(workspace, 'new-root-dir'), { mode: 0o700 });
  await fs.writeFile(path.join(workspace, 'new-root-dir/file'), 'later', { mode: 0o600 });
  ok(['sh', '/usr/bin/dev-workspace-init', '12345']);
  assert.equal(user(['sh', '-c', 'printf next > /workspace/new-root-dir/file']).status, 0);
  assert.equal((await fs.stat(path.join(workspace, 'new-root-dir/file'))).uid, 0);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o600);
  assert.equal(ok(['git', 'config', '--system', '--get-all', 'safe.directory']).stdout, '/workspace\n/workspace/*\n');
});
