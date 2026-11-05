import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.TEST_SERVICE_ROOTFS;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real Debian SSH/SFTP, sudo, non-Node application, supervision and persistent recovery', {
  timeout: 180000,
  skip: !base || process.getuid?.() !== 0 ? 'set TEST_SERVICE_ROOTFS to a disposable Debian rootfs with service dependencies; Docker smoke covers this in CI' : false,
}, async t => {
  for (const port of [2222, 8080, 20000]) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'devctl-ssh-service-'));
  const root = path.join(parent, 'root');
  const copied = spawnSync('cp', ['-a', base, root], { encoding: 'utf8' });
  assert.equal(copied.status, 0, copied.stderr);
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: '/root', USER: 'root', LOGNAME: 'root' };
  const run = (args, options = {}) => spawnSync('chroot', [root, ...args], { encoding: 'utf8', env, timeout: 30000, ...options });
  const ok = (args, options) => { const result = run(args, options); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout; };
  let server;
  const serviceLog = path.join(root, 'run/service-launch.log');
  async function stop() {
    if (!server || server.exitCode !== null) return;
    server.kill('SIGTERM');
    for (let i = 0; i < 200 && server.exitCode === null; i++) await delay(50);
    assert.notEqual(server.exitCode, null, 'Supervisor must shut down promptly');
  }
  t.after(async () => { try { await stop(); } finally { await fs.rm(parent, { recursive: true, force: true }); } });
  async function start() {
    const out = await fs.open(serviceLog, 'a');
    server = spawn('chroot', [root, '/opt/app-services/entrypoint.sh'], { env, stdio: ['ignore', out.fd, out.fd] });
    await out.close();
    for (let i = 0; i < 200; i++) {
      assert.equal(server.exitCode, null, await fs.readFile(serviceLog, 'utf8'));
      if (run(['/opt/app-services/healthcheck.sh']).status === 0) return;
      await delay(100);
    }
    throw new Error('Service readiness failed: ' + await fs.readFile(serviceLog, 'utf8'));
  }
  await fs.cp(path.join(repo, 'services'), path.join(root, 'opt/app-services'), { recursive: true });
  // Execute the Dockerfile's actual final assembly, including replacement of
  // Debian's packaged supervisor config. Do not pre-delete it in the fixture.
  const dockerfile = await fs.readFile(path.join(repo, 'services/Dockerfile'), 'utf8');
  const assembly = dockerfile.replace(/\\\n/g, '').split('\n').filter(line => line.startsWith('RUN ')).at(-1).slice(4);
  ok(['/bin/sh', '-ec', assembly]);
  assert.equal(await fs.readlink(path.join(root, 'etc/supervisor/supervisord.conf')), '/opt/app-services/supervisord.conf');
  await fs.copyFile(path.join(repo, 'dev-entrypoint.sh'), path.join(root, 'usr/local/bin/dev-entrypoint'));
  await fs.chmod(path.join(root, 'usr/local/bin/dev-entrypoint'), 0o755);
  await fs.copyFile(path.join(repo, 'config/ssh-app-services.conf'), path.join(root, 'etc/ssh/ssh_config.d/50-app-services.conf'));
  await fs.writeFile(path.join(root, 'etc/hosts'), `127.0.0.1 localhost app-services ${os.hostname()}\n`);
  // No /proc or devpts is mounted in this fixture. Use regular log sinks and
  // disable sudo's optional PTY wrapper ONLY here. Docker tests use real PTYs.
  for (const stream of ['stdout', 'stderr']) {
    await fs.rm(path.join(root, 'dev', stream), { force: true });
    await fs.symlink('/run/daemon.log', path.join(root, 'dev', stream));
  }
  await fs.copyFile(path.join(repo, 'config/nginx-apps.conf'), path.join(root, 'run/host-nginx-template.conf'));
  ok(['sh', '-s', '--', '/run/host-nginx-template.conf'], { input: await fs.readFile(path.join(repo, 'tests/fixtures/check-host-nginx.sh'), 'utf8') });
  await fs.writeFile(path.join(root, 'etc/sudoers.d/test-no-pty'), 'Defaults !use_pty\n', { mode: 0o440 });
  ok(['groupadd', '--gid', '1000', 'node']);
  ok(['useradd', '--uid', '1000', '--gid', '1000', '--create-home', '--shell', '/bin/bash', 'node']);
  await fs.mkdir(path.join(root, 'run/deploy-credentials'), { recursive: true });
  await fs.mkdir(path.join(root, 'home/node/.pi/agent'), { recursive: true });
  await fs.mkdir(path.join(root, 'proc/self'), { recursive: true });
  await fs.writeFile(path.join(root, 'proc/self/status'), 'NoNewPrivs:\t1\n');
  const guard = run(['/opt/app-services/entrypoint.sh']);
  assert.notEqual(guard.status, 0); assert.match(guard.stderr, /do not set no-new-privileges/);
  await fs.rm(path.join(root, 'proc/self'), { recursive: true });
  await start();
  assert.notEqual(run(['/opt/app-services/entrypoint.sh']).status, 0, 'shared data lock must reject a second supervisor');
  const credentials = path.join(root, 'run/deploy-credentials');
  ok(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/run/deploy-credentials/id_ed25519']);
  const key = (await fs.readFile(path.join(credentials, 'id_ed25519.pub'), 'utf8')).trim();
  const hostKey = ok(['deploy-register', key]).trim();
  assert.match(hostKey, /^ssh-ed25519 /);
  const authorized = path.join(root, 'srv/app-services/control/authorized_keys');
  const before = await fs.readFile(authorized, 'utf8');
  assert.notEqual(run(['deploy-register', 'ssh-ed25519 ' + 'A'.repeat(68)]).status, 0, 'reject structurally invalid keys');
  assert.equal(await fs.readFile(authorized, 'utf8'), before);
  await fs.writeFile(path.join(credentials, 'known_hosts'), '[app-services]:2222 ' + hostKey + '\n', { mode: 0o600 });
  ok(['chown', '-R', '12345:12345', '/run/deploy-credentials']);
  const clientRun = script => run(['/usr/local/bin/dev-entrypoint', '--dev-shell', '-ec', script], { env: { ...env, DEV_UID: '12345', DEV_GID: '12345', DEV_GROUPS: '12345' } });
  const client = script => { const result = clientRun(script); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout; };
  assert.equal(client("ssh app-services 'id -u; sudo -n id -u'").trim(), '19000\n0');
  assert.equal(client("ssh app-services 'printf normal-command'").trim(), 'normal-command');
  assert.equal(clientRun("ssh app-services 'exit 37'").status, 37);
  // Run the same Bash contract through both real entrypoint modes. SSH must
  // preserve argument boundaries rather than interpreting them a second time.
  const values = ['', 'two words', "single'quote", '"double"', '$HOME; $(exit 99) `exit 98` * \\', 'line\nbreak', '中文'];
  const checkArgs = 'printf "<%s>\\n" "$@"; printf error-output >&2; exit 37';
  for (const mode of ['--dev-shell', '--service-shell']) {
    const invoke = (args, input) => run(['/usr/local/bin/dev-entrypoint', mode, ...args], {
      input, env: { ...env, DEV_UID: '12345', DEV_GID: '12345', DEV_GROUPS: '12345' },
    });
    for (const flag of ['-c', '-lc']) {
      const result = invoke([flag, checkArgs, 'argument-zero', ...values]);
      assert.equal(result.status, 37, `${mode} ${flag}: ${result.stderr}`);
      assert.equal(result.stdout, values.map(value => `<${value}>\n`).join(''));
      assert.equal(result.stderr, 'error-output');
    }
    const script = invoke(['-s', '--', ...values], checkArgs + '\n');
    assert.equal(script.status, 37, `${mode} -s: ${script.stderr}`);
    assert.equal(script.stdout, values.map(value => `<${value}>\n`).join(''));
    assert.equal(script.stderr, 'error-output');
    const noArgs = invoke([], 'printf stdin-default; exit 23\n');
    assert.equal(noArgs.status, 23, noArgs.stderr);
    assert.equal(noArgs.stdout, 'stdin-default');
  }
  assert.notEqual(clientRun('ssh -l root app-services true').status, 0, 'root SSH login is denied');
  assert.notEqual(clientRun('ssh -o UserKnownHostsFile=/dev/null app-services true').status, 0, 'unknown host key is never accepted');
  assert.notEqual(clientRun("ssh app-services 'python3 -m ensurepip --version'").status, 0, 'fixture must start without the app dependency');
  assert.equal(client("ssh app-services 'set -eu; printf disposable > ~/staging-proof; printf %s \"$HOME\"'").trim(), '/home/deploy');
  await assert.rejects(fs.access(path.join(root, 'srv/app-services/home')), { code: 'ENOENT' });
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  await fs.cp(path.join(repo, 'skills/app-deployment/examples/python'), path.join(root, 'workspace/reviewed'), { recursive: true });
  await fs.copyFile(path.join(repo, 'tests/fixtures/http-protocols.py'), path.join(root, 'workspace/reviewed/server.py'));
  await fs.chmod(path.join(root, 'workspace'), 0o755);
  for (const name of await fs.readdir(path.join(root, 'workspace/reviewed'))) await fs.chmod(path.join(root, 'workspace/reviewed', name), 0o644);
  client('scp -r /workspace/reviewed app-services:upload');
  client("printf 'get upload/server.py /tmp/downloaded-server.py\\n' | sftp -b - app-services");
  assert.equal(await fs.readFile(path.join(root, 'tmp/downloaded-server.py'), 'utf8'), await fs.readFile(path.join(repo, 'tests/fixtures/http-protocols.py'), 'utf8'));
  const installScript = `set -euo pipefail
umask 077
base=/srv/app-services
stage=/home/deploy/upload
install -o root -g root -m 0700 "$stage/setup.sh" "$base/setup.d/10-demo.sh"
bash -eu "$base/setup.d/10-demo.sh"
install -o root -g root -m 0644 "$stage/server.py" "$base/apps/demo/code/server.py"
install -o root -g root -m 0600 "$stage/supervisor.conf" "$base/supervisor/demo.conf"
install -o root -g root -m 0600 "$stage/nginx.conf" "$base/nginx/demo.conf"
printf 'printf restored > /etc/environment-proof\\n' > "$base/setup.d/20-proof.sh"
chmod 700 "$base/setup.d/20-proof.sh"
bash "$base/setup.d/20-proof.sh"
supervisorctl reread
supervisorctl update demo
nginx -t -c /opt/app-services/nginx.conf
nginx -s reload -c /opt/app-services/nginx.conf
`;
  const installed = run(['/usr/local/bin/dev-entrypoint', '--dev-shell', '-ec', "ssh app-services 'sudo -n bash -s'"], { timeout: 90000, input: installScript, env: { ...env, DEV_UID: '12345', DEV_GID: '12345', DEV_GROUPS: '12345' } });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  async function healthy() {
    for (let i = 0; i < 50; i++) {
      const result = run(['curl', '-fsS', '--max-time', '1', '-H', 'Host: app-demo.example.com', 'http://127.0.0.1:8080/']);
      if (result.status === 0 && result.stdout === 'Hello from Python\n') return;
      await delay(100);
    }
    throw new Error('Application did not become healthy: ' + await fs.readFile(path.join(root, 'run/daemon.log'), 'utf8'));
  }
  await healthy();
  const protocolCheck = await fs.readFile(path.join(repo, 'tests/fixtures/check-protocols.py'), 'utf8');
  assert.match(ok(['python3'], { input: protocolCheck }), /WebSocket upgrade passed/);
  // Prove the streaming assertion detects buffering, not only eventual output.
  const routeFile = path.join(root, 'srv/app-services/nginx/demo.conf');
  const route = await fs.readFile(routeFile, 'utf8');
  try {
    await fs.writeFile(routeFile, route.replace('proxy_buffering off;', 'proxy_buffering on;'));
    ok(['nginx', '-s', 'reload', '-c', '/opt/app-services/nginx.conf']);
    await delay(300);
    const buffered = run(['python3'], { input: protocolCheck });
    assert.notEqual(buffered.status, 0, 'checker must reject buffered SSE');
    assert.match(buffered.stderr, /SSE first event was buffered/);
  } finally {
    await fs.writeFile(routeFile, route);
    ok(['nginx', '-s', 'reload', '-c', '/opt/app-services/nginx.conf']);
  }
  const pid = Number(client("ssh app-services 'sudo supervisorctl pid demo'").trim());
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  assert.match(status, /^Uid:\s+20000\s+20000/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^CapBnd:\s+0+$/m);
  const starts = path.join(root, 'srv/app-services/apps/demo/data/starts');
  assert.equal((await fs.stat(starts)).uid, 20000);
  assert.notEqual(clientRun("ssh app-services 'sudo -u app-demo sudo -n id -u'").status, 0, 'application account cannot become root');
  client("ssh app-services 'sudo kill -KILL $(sudo supervisorctl pid demo)'");
  await healthy();
  for (let i = 0; i < 50; i++) {
    const result = clientRun("ssh app-services 'sudo supervisorctl pid demo'");
    if (result.status === 0 && Number(result.stdout.trim()) > 0 && Number(result.stdout.trim()) !== pid) break;
    await delay(100);
  }
  assert.notEqual(Number(client("ssh app-services 'sudo supervisorctl pid demo'").trim()), pid);
  await fs.rm(path.join(root, 'workspace'), { recursive: true });
  const standalone = run(['/usr/local/bin/dev-entrypoint', '--service-shell', '-c', 'sudo supervisorctl status demo'], { env: { ...env, DEV_UID: '12345', DEV_GID: '12345', DEV_GROUPS: '12345' } });
  assert.equal(standalone.status, 0, standalone.stderr); assert.match(standalone.stdout, /demo\s+(RUNNING|STARTING)/);
  const originalHostKey = await fs.readFile(path.join(root, 'srv/app-services/ssh/ssh_host_ed25519_key.pub'), 'utf8');
  await stop();
  ok(['apt-get', 'purge', '-y', 'python3-venv', 'python3.13-venv'], { timeout: 60000 });
  // Simulate fresh image account databases and /etc, keeping only service state.
  for (const db of ['passwd', 'group', 'shadow', 'gshadow']) {
    const file = path.join(root, 'etc', db);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).split('\n').filter(line => !/^(deploy|app-demo):/.test(line)).join('\n'));
  }
  await fs.rm(path.join(root, 'home/deploy'), { recursive: true });
  await fs.rm(path.join(root, 'etc/environment-proof'));
  await start(); await healthy();
  const proof = path.join(root, 'etc/environment-proof');
  assert.equal((await fs.stat(proof)).mode & 0o777, 0o600);
  const directRead = clientRun("ssh app-services 'cat /etc/environment-proof'");
  assert.notEqual(directRead.status, 0, 'ordinary deploy must not read root-only recovery state');
  assert.match(directRead.stderr, /Permission denied/);
  // Execute the exact same non-root SSH assertion as Docker smoke, not a
  // host-root filesystem read that bypasses the actual permission boundary.
  const recoveryCheck = await fs.readFile(path.join(repo, 'tests/fixtures/check-service-recovery.sh'), 'utf8');
  const checkRecovery = () => run(['/usr/local/bin/dev-entrypoint', '--service-shell', '-s'], {
    input: recoveryCheck, env: { ...env, DEV_UID: '12345', DEV_GID: '12345', DEV_GROUPS: '12345' },
  });
  const recovered = checkRecovery();
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  // Shared assertion must fail closed when privileged reads find wrong data.
  await fs.writeFile(proof, 'not-restored');
  assert.notEqual(checkRecovery().status, 0, 'recovery checks must not hide failed assertions');
  await fs.writeFile(proof, 'restored');
  assert.equal(await fs.readFile(path.join(root, 'srv/app-services/ssh/ssh_host_ed25519_key.pub'), 'utf8'), originalHostKey);
  assert.ok(Number(await fs.readFile(starts, 'utf8')) >= 3);
  client("ssh app-services \"set -eu; sudo sed -i 's/^autostart=true/autostart=false/' /srv/app-services/supervisor/demo.conf; sudo supervisorctl reread; sudo supervisorctl update demo; sudo mv /srv/app-services/nginx/demo.conf /srv/app-services/nginx/demo.disabled; sudo nginx -t -c /opt/app-services/nginx.conf && sudo nginx -s reload -c /opt/app-services/nginx.conf\"");
  await stop(); await start();
  const stopped = clientRun("ssh app-services 'sudo supervisorctl status demo'");
  assert.equal(stopped.status, 3, 'supervisorctl reports stopped programs with exit code 3');
  assert.match(stopped.stdout, /STOPPED/);
  assert.equal(ok(['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: app-demo.example.com', 'http://127.0.0.1:8080/']), '404');
  assert.equal(await fs.readFile(starts, 'utf8').then(Number) >= 3, true);
  const stoppedStarts = await fs.readFile(starts, 'utf8');
  client("ssh app-services 'sudo supervisorctl status sshd nginx'");
  await stop(); await start();
  assert.equal(await fs.readFile(starts, 'utf8'), stoppedStarts, 'disabled application must not restart');
  client("ssh app-services 'set -eu; sudo rm /srv/app-services/supervisor/demo.conf; sudo supervisorctl reread; sudo supervisorctl update; sudo rm /srv/app-services/nginx/demo.disabled /srv/app-services/setup.d/10-demo.sh; sudo rm -rf /srv/app-services/apps/demo; sudo userdel app-demo; if getent group app-demo >/dev/null; then sudo groupdel app-demo; fi'");
  await assert.rejects(fs.access(path.join(root, 'srv/app-services/apps/demo')), { code: 'ENOENT' });
  assert.equal(client("ssh app-services 'printf connected'").trim(), 'connected');
  assert.ok((await fs.stat(authorized)).isFile());
  await stop();
  const setupFile = path.join(root, 'srv/app-services/setup.d/30-test.sh');
  await fs.writeFile(setupFile, 'exit 41\n', { mode: 0o700 });
  const failed = run(['/opt/app-services/entrypoint.sh']);
  assert.equal(failed.status, 41, failed.stderr);
  await fs.chmod(setupFile, 0o722);
  assert.match(run(['/opt/app-services/entrypoint.sh']).stderr, /group\/world writable/);
  await fs.rm(setupFile);
  await fs.symlink('/etc/environment-proof', setupFile);
  assert.match(run(['/opt/app-services/entrypoint.sh']).stderr, /Unsafe setup script/);
  await fs.rm(setupFile);
  await fs.writeFile(path.join(root, 'srv/app-services/nginx/broken.conf'), 'not a valid nginx directive;\n');
  const invalid = run(['/opt/app-services/entrypoint.sh']);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /unknown directive/);
});
