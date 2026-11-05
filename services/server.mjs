#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Manager } from './manager.mjs';
import { checkOperation, publicUrl } from './protocol.mjs';

process.umask(0o077);
publicUrl(process.env.DEPLOY_PUBLIC_URL, 'example');
const manager = new Manager();
let ready = false;
await fs.mkdir('/run/app-services', { recursive: true });
// Reserve control listeners before restoring applications. Otherwise a restored
// application could bind an empty management port during supervisor startup.
const api = http.createServer();
api.requestTimeout = 120000;
api.headersTimeout = 10000;
api.timeout = 150000;
api.maxHeadersCount = 20;
await new Promise((resolve, reject) => { api.once('error', reject); api.listen(9000, '127.0.0.1', resolve); });
await manager.route({});
manager.nginx = spawn('nginx', ['-c', '/run/app-services/nginx.conf', '-g', 'daemon off;'], { stdio: 'inherit' });

api.on('request', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const reply = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value) + '\n'); };
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      reply(ready ? 200 : 503, { ready }); return;
    }
    if (!ready) { reply(503, { error: '服务正在初始化' }); return; }
    const match = /^\/v1\/([a-z]+)(?:\/([a-z0-9-]+))?$/.exec(req.url);
    const authenticated = manager.authenticate(req.headers['x-deploy-user'], req.headers['x-deploy-token']);
    if (!authenticated) { reply(403, { error: '服务身份校验失败' }); return; }
    if (req.method !== 'POST' || !match) { reply(400, { error: '无效的服务请求' }); return; }
    checkOperation(match[1], match[2]);
    const result = await manager.serial(() => manager.command(match[1], match[2], req));
    reply(200, result);
  } catch (err) {
    // Logs may contain application secrets; return command errors, never request bodies.
    reply(400, { error: err.message });
  }
});

// Only host docker exec can register the installation key: root-only Unix socket, not a
// network admin endpoint and not mounted into any Pi container.
const socket = '/run/app-services/admin.sock';
await fs.rm(socket, { force: true });
const admin = http.createServer(async (req, res) => {
  try {
    if (!ready) throw new Error('服务正在初始化');
    if (req.method !== 'POST' || req.url !== '/register') throw new Error('无效管理操作');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) throw new Error('管理请求过大');
    }
    const { key } = JSON.parse(body);
    const result = await manager.serial(() => manager.register(key));
    res.end(JSON.stringify(result) + '\n');
  } catch (err) { res.statusCode = 400; res.end(JSON.stringify({ error: err.message }) + '\n'); }
});
await new Promise((resolve, reject) => { admin.once('error', reject); admin.listen(socket, resolve); });
await fs.chmod(socket, 0o600);

const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', '/opt/app-services/sshd_config'], { stdio: 'inherit' });
await new Promise((resolve, reject) => { sshd.once('spawn', resolve); sshd.once('error', reject); });
async function waitListening(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const connected = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`服务端口 ${port} 无法就绪`);
}
await waitListening(2222);
await waitListening(8080);
await manager.load();
await manager.route();
for (const [name, app] of Object.entries(manager.apps)) {
  if (app.enabled) await manager.gatewayReady(name, app.manifest.healthPath, app.port, false);
}
ready = true;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  ready = false;
  api.close(); admin.close();
  // Bound shutdown even if a client stalls the serialized upload queue.
  setTimeout(() => process.exit(code), 25000).unref();
  api.closeAllConnections(); admin.closeAllConnections();
  await manager.shutdown();
  sshd.kill('SIGTERM'); manager.nginx.kill('SIGQUIT');
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const child of [sshd, manager.nginx]) {
  child.once('error', err => { console.error('服务组件无法启动：', err.message); shutdown(1); });
  child.once('exit', () => { if (!stopping) { console.error('服务组件退出'); shutdown(1); } });
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
console.log('Service gateway ready: HTTP 8080, SSH 2222.');
