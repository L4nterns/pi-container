import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSkills, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('deployment skill loads cleanly and advertises metadata, not its full workflow', async t => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'pic-skills-'));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const result = loadSkills({ cwd: empty, agentDir: empty, includeDefaults: false, skillPaths: [path.join(repo, 'skills/app-deployment')] });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'app-deployment');
  const prompt = formatSkillsForPrompt(result.skills);
  assert.ok(prompt.includes('app-deployment'));
  assert.ok(!prompt.includes('Stopping preserves application data'));
  const entrypoint = await fs.readFile(path.join(repo, 'pic-entrypoint.sh'), 'utf8');
  assert.ok(entrypoint.includes('--skill /opt/pic/skills/app-deployment'));
  assert.ok(!entrypoint.includes('--append-system-prompt'));
});

test('service health requires exactly two running core processes and an actual default 404', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pic-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'supervisorctl'), '#!/bin/sh\nprintf "%s\\n" "$TEST_STATUS"\nexit "${TEST_STATUS_EXIT:-0}"\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'curl'), '#!/bin/sh\nprintf "%s" "${TEST_HTTP:-404}"\nexit "${TEST_CURL_EXIT:-0}"\n', { mode: 0o755 });
  const run = env => spawnSync('sh', [path.join(repo, 'services/healthcheck.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_STATUS: 'sshd RUNNING pid 1\nnginx RUNNING pid 2', ...env } });
  assert.equal(run({}).status, 0);
  for (const env of [
    { TEST_STATUS: '' }, { TEST_STATUS: 'sshd RUNNING' }, { TEST_STATUS: 'sshd RUNNING\nnginx STOPPED' },
    { TEST_STATUS: 'sshd RUNNING\nnginx RUNNING\nextra RUNNING' }, { TEST_STATUS_EXIT: '3' },
    { TEST_HTTP: '200' }, { TEST_HTTP: '502' }, { TEST_CURL_EXIT: '7' },
  ]) assert.notEqual(run(env).status, 0, JSON.stringify(env));
});

test('service image suppresses package auto-start before installation and replaces packaged configuration', async () => {
  const image = await fs.readFile(path.join(repo, 'services/Dockerfile'), 'utf8');
  const policy = image.indexOf('policy-rc.d');
  const install = image.indexOf('apt-get install');
  const chmod = image.indexOf('chmod 0755 /usr/sbin/policy-rc.d');
  assert.ok(policy >= 0 && policy < chmod && chmod < install);
  assert.match(image, /ln -sf \/opt\/app-services\/supervisord\.conf \/etc\/supervisor\/supervisord\.conf/);
});

test('host gateway template uses DNS label limits and has no application protocol headers', async () => {
  const config = await fs.readFile(path.join(repo, 'config/nginx-apps.conf'), 'utf8');
  assert.doesNotMatch(config, /X-App-Route/);
  const pattern = new RegExp(config.match(/server_name "~([^"]+)";/)[1]);
  for (const host of ['app-demo.example.com', 'app-x.example.com', `app-${'a'.repeat(59)}.example.com`]) assert.match(host, pattern);
  for (const host of ['app--x.example.com', 'app-x-.example.com', 'app-demo.nested.example.com', `app-${'a'.repeat(60)}.example.com`]) assert.doesNotMatch(host, pattern);
});

test('SSH is standard public-key administration with SFTP, not a forced-command API', async () => {
  const ssh = await fs.readFile(path.join(repo, 'services/sshd_config'), 'utf8');
  for (const directive of ['PermitRootLogin no', 'PasswordAuthentication no', 'AllowUsers deploy', 'Subsystem sftp internal-sftp', 'AllowTcpForwarding no', 'AllowAgentForwarding no']) assert.ok(ssh.includes(directive));
  assert.doesNotMatch(ssh, /ForceCommand|PermitTTY no|DisableForwarding yes/);
  const client = await fs.readFile(path.join(repo, 'config/ssh-app-services.conf'), 'utf8');
  assert.match(client, /StrictHostKeyChecking yes/); assert.match(client, /IdentitiesOnly yes/);
  const compose = await fs.readFile(path.join(repo, 'compose.services.yaml'), 'utf8');
  assert.doesNotMatch(compose, /privileged:|SYS_ADMIN|cgroup|no-new-privileges|docker\.sock/);
  const image = await fs.readFile(path.join(repo, 'services/Dockerfile'), 'utf8');
  assert.match(image, /debian:trixie-slim@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(image, /nodejs|node:|systemd/);
});
