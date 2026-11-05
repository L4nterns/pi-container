#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { checkApp, checkOperation, publicUrl, sendBundle, validateManifest } from '../services/protocol.mjs';

function help() {
  console.log(`Usage: appctl <command>
  deploy <app> <reviewed-directory>  Upload and activate a reviewed release
  list                              List this installation's applications
  status <app>                      Inspect process and internal HTTP health
  logs <app>                        Read up to the last 64 KiB of logs
  start <app>                       Enable a stopped application
  restart <app>                     Restart from the persisted release
  stop <app>                        Disable application, preserve all data
  delete <app> --yes                 Permanently delete release, data and logs
  verify <app>                      Check configured public URL from this client
Instructions: /opt/devctl/DEPLOYMENT.md`);
}
async function verify(app) {
  const url = publicUrl(process.env.DEPLOY_PUBLIC_URL, app);
  if (!url) throw new Error('未配置 DEPLOY_PUBLIC_URL，无法验证公网；内部就绪不等于公网可访问');
  const result = await new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: 15000 }, res => {
      const type = res.headers['content-type'] ?? '';
      res.resume();
      resolve({ url, status: res.statusCode, contentType: type,
        note: 'HTTP 响应不证明内容正确；继续抽查页面、资源和业务接口，确认不是登录页或 Cloudflare 质询。' });
    });
    req.on('timeout', () => req.destroy(new Error('公网验证超时')));
    req.on('error', reject);
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status < 200 || result.status >= 400) process.exitCode = 1;
}
async function main() {
  const [action, app, argument, ...extra] = process.argv.slice(2);
  if ((action === '--help' || action === '-h') && !app) { help(); return; }
  if (action === 'verify' && app && argument === undefined && !extra.length) { checkApp(app); await verify(app); return; }
  const valid = !extra.length && (action === 'deploy' ? Boolean(argument)
    : action === 'delete' ? argument === '--yes' : argument === undefined);
  try { if (!valid) throw new Error('参数不合法'); checkOperation(action, app); }
  catch { help(); process.exitCode = 2; return; }
  let deploymentRoot;
  if (action === 'deploy') {
    const root = await fs.realpath(argument);
    deploymentRoot = root;
    const relative = path.relative('/workspace', root);
    if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) throw new Error('部署目录必须位于 /workspace');
    const manifest = path.join(root, 'app-deploy.json');
    const stat = await fs.stat(manifest);
    if (!stat.isFile() || stat.size > 65536) throw new Error('缺少或过大的 app-deploy.json');
    let definition;
    try { definition = JSON.parse(await fs.readFile(manifest, 'utf8')); }
    catch { throw new Error('app-deploy.json 不是有效 JSON，内容未输出'); }
    validateManifest(definition);
  }
  const credentials = '/run/deploy-credentials';
  const user = (await fs.readFile(`${credentials}/user`, 'utf8')).trim();
  if (user !== 'deploy') throw new Error('服务账号不合法');
  const remote = action + (app ? ` ${app}` : '') + (action === 'delete' ? ' --yes' : '');
  const child = spawn('ssh', ['-F', '/dev/null', '-T', '-p', '2222', '-i', `${credentials}/id_ed25519`,
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${credentials}/known_hosts`, '-o', 'ConnectTimeout=10',
    `${user}@app-services`, remote], { stdio: ['pipe', 'pipe', 'inherit'] });
  let response = '';
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    if (['deploy', 'start', 'restart'].includes(action)) response += chunk;
  });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1)); });
  exit.catch(() => {});
  child.stdin.on('error', () => {});
  try {
    if (action === 'deploy') await sendBundle(deploymentRoot, child.stdin);
    child.stdin.end();
    const code = await exit;
    if (code !== 0) process.exitCode = code || 1;
    else if (['deploy', 'start', 'restart'].includes(action)) {
      const result = JSON.parse(response);
      if (result.state === 'ready') console.log('服务内部就绪。公网未验证；配置 DEPLOY_PUBLIC_URL 后运行 appctl verify ' + app + '，并检查实际内容。');
    }
  } catch (err) { child.kill('SIGTERM'); await exit.catch(() => {}); throw err; }
}
main().catch(err => { console.error('应用操作失败：' + err.message); process.exitCode = 1; });
