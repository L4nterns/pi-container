import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../dev-entrypoint.sh', import.meta.url));
const ssh = process.env.TEST_SSH_BINARY || '/usr/bin/ssh';
const hasSsh = await fs.access(ssh).then(() => true, () => false);

test('rejects invalid UID/GID/groups before initialization or running a command', () => {
  const invalid = [
    { DEV_UID: '' }, { DEV_UID: '0' }, { DEV_UID: '-1' }, { DEV_UID: '1:2' }, { DEV_GID: '' }, { DEV_GID: '0' }, { DEV_GID: '1:2' },
    { DEV_GROUPS: '' }, { DEV_GROUPS: '0,,1' }, { DEV_GROUPS: ',1' }, { DEV_GROUPS: '1,' }, { DEV_GROUPS: 'abc' },
  ];
  for (const values of invalid) {
    const result = spawnSync('sh', [entrypoint, '--dev-shell', '-c', 'echo should-not-run'], {
      encoding: 'utf8', env: { ...process.env, DEV_UID: '1000', DEV_GID: '1000', DEV_GROUPS: '1000', ...values },
    });
    assert.equal(result.status, 1, JSON.stringify(values));
    assert.match(result.stderr, /不合法/);
    assert.equal(result.stdout, '');
  }
});

test('entrypoint registers non-default UID/GID for real OpenSSH and reuses existing groups', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 ? 'isolated chroot requires root; run separately in CI'
    : !hasSsh && 'OpenSSH client not installed; required in CI',
}, async t => {
  // Never touch the host account database. Copy only the entrypoint, real tools
  // and their libraries into a disposable filesystem, without bind mounts.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-entrypoint-rootfs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o755);
  const copied = new Set();
  async function copy(source, target = source) {
    if (copied.has(target)) return;
    const dest = path.join(root, target);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
    copied.add(target);
  }
  for (const name of ['sh', 'bash', 'mkdir', 'flock', 'getent', 'groupadd', 'usermod', 'id', 'chown', 'find', 'chmod', 'head', 'setpriv', 'ssh']) {
    const lookup = spawnSync('sh', ['-c', 'command -v "$1"', '_', name], { encoding: 'utf8' });
    const source = name === 'ssh' ? ssh : lookup.stdout.trim();
    assert.ok(source, `${name} must be installed`);
    await copy(source, `${name === 'sh' || name === 'bash' ? '/bin' : '/usr/bin'}/${name}`);
    const deps = spawnSync('ldd', [source], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(deps.status, 0, deps.stderr);
    for (const match of deps.stdout.matchAll(/(?:=>\s+|^\s*)(\/\S+)/gm)) await copy(match[1]);
  }
  await copy(entrypoint, '/usr/bin/dev-entrypoint');
  for (const dir of ['etc', 'dev', 'tmp', 'var/log', 'var/mail', 'home/node/.pi/agent']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  const files = {
    'etc/passwd': 'root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/bash\n',
    'etc/group': 'root:x:0:\nnode:x:1000:\nshared:x:23456:\n',
    'etc/shadow': 'root:!:19000:0:99999:7:::\nnode:!:19000:0:99999:7:::\n',
    'etc/gshadow': 'root:!::\nnode:!::\nshared:!::\n',
    'etc/nsswitch.conf': 'passwd: files\ngroup: files\nshadow: files\n',
    'etc/login.defs': 'MAIL_DIR /var/mail\n',
    'etc/ssh_config': '',
    'dev/null': '', // Only used as a writable sink; no real devices needed.
  };
  for (const [file, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(root, file), contents, { mode: file.endsWith('shadow') ? 0o600 : 0o644 });
  }
  await fs.chmod(path.join(root, 'dev/null'), 0o666);
  const env = { ...process.env, PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', USER: 'root', LOGNAME: 'root' };
  const run = (args, extra = {}) => spawnSync('chroot', [root, ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...env, ...extra },
  });
  // Reproduce the reported failure before initialization, without an SSH server.
  const before = run(['/usr/bin/setpriv', '--reuid', '12345', '--regid', '12345', '--clear-groups',
    '/usr/bin/ssh', '-F', '/etc/ssh_config', '-T', '-G', 'app-services']);
  assert.equal(before.status, 255, before.stderr);
  assert.match(before.stderr, /No user exists for uid 12345/);

  const check = 'printf "%s:%s:%s\\n" "$USER" "$LOGNAME" "$HOME"; id -un; getent passwd "$(id -u)"; ssh -F /etc/ssh_config -T -G app-services';
  for (const [uid, gid] of [[12345, 12345], [12345, 12345], [34567, 23456], [1000, 1000]]) {
    const result = run(['/usr/bin/setpriv', '--no-new-privs', '/bin/sh', '/usr/bin/dev-entrypoint', '--dev-shell', '-ec', check], {
      DEV_UID: String(uid), DEV_GID: String(gid), DEV_GROUPS: String(gid),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^node:node:\/home\/node\nnode\n/);
    assert.ok(result.stdout.includes(`node:x:${uid}:${gid}:`), result.stdout);
    assert.match(result.stdout, /hostname app-services/);
    const passwd = await fs.readFile(path.join(root, 'etc/passwd'), 'utf8');
    assert.equal(passwd.trim().split('\n').length, 2, 'update the existing node account instead of adding duplicate users');
    const groups = (await fs.readFile(path.join(root, 'etc/group'), 'utf8')).trim().split('\n');
    assert.equal(groups.filter(line => line.split(':')[2] === String(gid)).length, 1, 'reuse existing groups');
    const agent = await fs.stat(path.join(root, 'home/node/.pi/agent'));
    assert.equal(agent.uid, uid);
    assert.equal(agent.gid, gid);
  }
});
