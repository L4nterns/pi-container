#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import { parseRemoteCommand } from './protocol.mjs';

const user = process.env.USER;
const home = process.env.HOME;
let operation;
try {
  if (user !== 'deploy' || home !== '/srv/app-services/control') throw new Error('无效身份');
  operation = parseRemoteCommand(process.env.SSH_ORIGINAL_COMMAND);
} catch {
  console.error('仅允许 appctl 的 deploy/list/status/logs/start/restart/stop/delete 操作；delete 须带 --yes，不提供交互式 Shell');
  process.exit(1);
}
const token = (await fs.readFile(`${home}/token`, 'utf8')).trim();
const req = http.request({ hostname: '127.0.0.1', port: 9000, method: 'POST',
  path: `/v1/${operation.action}${operation.app ? '/' + operation.app : ''}`,
  headers: { 'X-Deploy-User': user, 'X-Deploy-Token': token }, timeout: 150000 }, res => {
  res.pipe(process.stdout);
  res.once('end', () => { if (res.statusCode !== 200) process.exitCode = 1; });
});
req.on('error', err => { console.error('服务请求失败：', err.message); process.exitCode = 1; process.stdin.destroy(); });
req.on('timeout', () => req.destroy(new Error('服务请求超时')));
if (operation.action === 'deploy') process.stdin.pipe(req);
else req.end();
