import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

export const APP_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const MAX_BYTES = 512 * 1024 * 1024;
export const MAX_FILES = 20000;
const MAGIC = 'APP-DEPLOY/1\n';
const ACTIONS = ['deploy', 'list', 'status', 'logs', 'start', 'restart', 'stop', 'delete'];

export function checkOperation(action, app) {
  if (!ACTIONS.includes(action) || (action === 'list' ? app !== undefined : !app)) throw new Error('无效的应用操作或参数');
  if (app !== undefined) checkApp(app);
  return { action, app };
}

export function parseRemoteCommand(command) {
  const match = /^(\w+)(?: ([a-z0-9-]+))?( --yes)?$/.exec(command ?? '');
  if (!match || Boolean(match[3]) !== (match[1] === 'delete')) throw new Error('删除应用须显式确认 --yes；不提供交互式 Shell');
  return checkOperation(match[1], match[2]);
}

export function checkApp(app) {
  if (!APP_PATTERN.test(app ?? '')) throw new Error('应用名须为 1–48 位小写字母、数字及内部连字符');
  return app;
}

export function checkPath(name) {
  if (typeof name !== 'string' || name.length > 1024 || /[\\\x00-\x1f\x7f]/.test(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..' || ['.git', '.ssh', '.aws', '.gnupg', '.pi', '.npmrc', '.netrc', '.deploy-keys', '.runtime', 'services-data'].includes(p) || /^\.env(?:\.|$)/i.test(p))) {
    throw new Error('产物包含不安全或敏感路径');
  }
}

export function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['command', 'env', 'healthPath', 'readyTimeout'].includes(k))) throw new Error('app-deploy.json 字段不合法');
  if (!Array.isArray(value.command) || !value.command.length || value.command.length > 64 ||
      value.command.some(v => typeof v !== 'string' || !v || v.length > 4096 || v.includes('\0'))) throw new Error('command 必须是非空参数数组');
  const env = value.env ?? {};
  if (typeof env !== 'object' || !env || Array.isArray(env) || Object.keys(env).length > 100 ||
      Object.entries(env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || ['PORT', 'HOST', 'HOME', 'USER', 'LOGNAME', 'PATH', 'APP_DATA_DIR'].includes(k) || typeof v !== 'string' || v.length > 8192 || v.includes('\0'))) throw new Error('env 字段不合法或覆盖了保留变量');
  const healthPath = value.healthPath ?? '/';
  if (typeof healthPath !== 'string' || !healthPath.startsWith('/') || healthPath.startsWith('//') || /[\s\x00-\x1f\x7f]/.test(healthPath) || healthPath.length > 1024) throw new Error('healthPath 必须是本地 HTTP 路径');
  const readyTimeout = value.readyTimeout ?? 30;
  if (!Number.isInteger(readyTimeout) || readyTimeout < 1 || readyTimeout > 120) throw new Error('readyTimeout 须为 1–120 秒');
  return { command: value.command, env, healthPath, readyTimeout };
}

export function publicUrl(template, app) {
  checkApp(app);
  if (!template) return null;
  if (typeof template !== 'string' || template.split('{app}').length !== 2 ||
      !/^https?:\/\/app-\{app\}\.[a-z0-9.-]+(?::[0-9]+)?\/?$/.test(template)) throw new Error('DEPLOY_PUBLIC_URL 须为 http(s)://app-{app}.域名');
  const url = new URL(template.replace('{app}', app));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !url.hostname.startsWith(`app-${app}.`) || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new Error('DEPLOY_PUBLIC_URL 须为 http(s)://app-{app}.域名，不含路径、凭据或查询');
  return url.origin + '/';
}

async function writeChunk(output, data) {
  if (output.destroyed || output.writableEnded) throw new Error('上传连接已关闭');
  if (!output.write(data)) await new Promise((resolve, reject) => {
    const cleanup = () => { output.off('drain', drained); output.off('error', failed); output.off('close', closed); };
    const drained = () => { cleanup(); resolve(); };
    const failed = err => { cleanup(); reject(err); };
    const closed = () => failed(new Error('上传连接已关闭'));
    output.once('drain', drained); output.once('error', failed); output.once('close', closed);
  });
}

// Explicit, bounded file framing instead of extracting a user-controlled tar as root.
export async function sendBundle(source, output) {
  const root = await fs.realpath(source);
  let files = 0, bytes = 0;
  await writeChunk(output, MAGIC);
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      checkPath(relative);
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`产物不能包含符号链接：${relative}`);
      if (stat.isDirectory()) { await visit(file, `${relative}/`); continue; }
      if (!stat.isFile()) throw new Error(`产物不能包含特殊文件：${relative}`);
      if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new Error('产物超过文件数或大小限制');
      const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const current = await input.stat();
        if (!current.isFile() || current.size !== stat.size) throw new Error('产物在上传期间发生变化');
        await writeChunk(output, JSON.stringify({ path: relative, size: stat.size, executable: Boolean(stat.mode & 0o111) }) + '\n');
        let copied = 0;
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          copied += chunk.length;
          if (copied > stat.size) throw new Error('产物在上传期间发生变化');
          await writeChunk(output, chunk);
        }
        if (copied !== stat.size) throw new Error('产物在上传期间发生变化');
      } finally { await input.close(); }
    }
  }
  await visit(root);
  await writeChunk(output, '{"end":true}\n');
}

class Reader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.done = false; }
  async more() {
    const next = await this.iterator.next();
    this.done = next.done;
    if (!next.done) this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
  }
  async line() {
    while (!this.buffer.includes(10)) {
      if (this.done) throw new Error('上传内容不完整');
      if (this.buffer.length > 8192) throw new Error('上传文件头过长');
      await this.more();
    }
    const end = this.buffer.indexOf(10);
    if (end > 8192) throw new Error('上传文件头过长');
    const line = this.buffer.subarray(0, end).toString('utf8');
    this.buffer = this.buffer.subarray(end + 1);
    return line;
  }
  async file(handle, size) {
    while (size > 0) {
      if (!this.buffer.length) {
        if (this.done) throw new Error('上传文件内容不完整');
        await this.more();
        continue;
      }
      const count = Math.min(size, this.buffer.length);
      await handle.writeFile(this.buffer.subarray(0, count));
      this.buffer = this.buffer.subarray(count);
      size -= count;
    }
  }
  async finish() {
    while (!this.done) {
      if (this.buffer.length) throw new Error('上传结束后存在多余内容');
      await this.more();
    }
    if (this.buffer.length) throw new Error('上传结束后存在多余内容');
  }
}

export async function receiveBundle(stream, directory) {
  const reader = new Reader(stream), names = new Set();
  if (await reader.line() !== MAGIC.trimEnd()) throw new Error('无效的部署上传协议');
  let files = 0, bytes = 0;
  for (;;) {
    let header;
    try { header = JSON.parse(await reader.line()); }
    catch { throw new Error('上传文件头无效或不完整'); }
    if (header?.end === true && Object.keys(header).length === 1) break;
    checkPath(header?.path);
    if (!Number.isSafeInteger(header.size) || header.size < 0 || typeof header.executable !== 'boolean' || names.has(header.path)) throw new Error('上传文件头不合法');
    names.add(header.path);
    if (++files > MAX_FILES || (bytes += header.size) > MAX_BYTES) throw new Error('产物超过文件数或大小限制');
    const dest = path.join(directory, header.path);
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const file = await fs.open(dest, 'wx', header.executable ? 0o700 : 0o600);
    try {
      await reader.file(file, header.size);
      await file.sync();
    } finally { await file.close(); }
  }
  await reader.finish();
  const manifestPath = path.join(directory, 'app-deploy.json');
  const st = await fs.stat(manifestPath);
  if (!st.isFile() || st.size > 65536) throw new Error('缺少或过大的 app-deploy.json');
  let definition;
  try { definition = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch { throw new Error('app-deploy.json 不是有效 JSON，内容未输出'); }
  const manifest = validateManifest(definition);
  // Persist directory entries bottom-up before the application definition can
  // commit a reference to this release. File fsync alone does not persist names.
  async function syncDirectory(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await syncDirectory(path.join(dir, entry.name));
    }
    const handle = await fs.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(directory);
  return { manifest, files, bytes };
}
