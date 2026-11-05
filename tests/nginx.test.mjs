import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nginxConfig } from '../services/manager.mjs';

const nginx = process.env.TEST_NGINX_BINARY || '/usr/sbin/nginx';
const mime = process.env.TEST_NGINX_MIME_TYPES || '/etc/nginx/mime.types';
const available = await fs.access(nginx).then(() => true, () => false);

test('real Nginx validates generated configuration with Node pipe-backed stderr', { skip: !available && 'Nginx not installed; required in CI' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-nginx-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tempPaths = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map(name => `${name}_temp_path ${root}/${name};`).join('\n');
  const config = nginxConfig({ demo: { enabled: true, port: 23456 } })
    .replace('/etc/nginx/mime.types', mime)
    .replace('/run/app-services/nginx.pid', root + '/nginx.pid')
    .replace('http {', 'http {\n' + tempPaths);
  const file = path.join(root, 'nginx.conf');
  const check = () => spawnSync(nginx, ['-e', 'stderr', '-t', '-c', file], { encoding: 'utf8', timeout: 10000 });

  await fs.writeFile(file, config);
  const good = check();
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stderr, /test is successful/);

  // Regression reproduction: /dev/stderr reopens the child's inherited socket
  // on Linux instead of using descriptor 2; the previous config cannot start.
  if (process.platform === 'linux') {
    await fs.writeFile(file, config.replace('error_log stderr warn;', 'error_log /dev/stderr warn;'));
    const bad = check();
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /open\(\) "\/dev\/stderr" failed/);
  }
});
