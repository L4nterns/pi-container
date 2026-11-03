#!/usr/bin/env node
/** Publish reviewed static assets. CLI roots and mount checks are not configurable. */
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SOURCE_ROOT = '/workspace';
const PUBLIC_ROOT = '/vibe-projects';
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.json', '.css', '.svg', '.txt', '.xml']);
const SECRET_SIGNALS = [
  ['私钥材料', /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/i],
  ['AWS 访问密钥格式', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub 令牌格式', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Slack 令牌格式', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];
const CREDENTIAL_FIELD = /["'`]?(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|private[_-]?key)["'`]?\s*[:=]\s*["'`][^"'`\r\n]{8,256}["'`]/i;

function fail(message) {
  throw new Error(message);
}

function publicBaseUrl(value) {
  let url;
  try { url = new URL(value?.trim()); }
  catch { fail('VIBE_PUBLIC_URL 必须是 HTTP(S) 站点根地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    fail('VIBE_PUBLIC_URL 必须是 HTTP(S) 站点根地址，不含路径、凭据、查询参数或片段');
  }
  return url.origin;
}

export async function verifyPublishMount() {
  const info = await fs.readFile('/proc/self/mountinfo', 'utf8');
  if (!info.split('\n').some(line => line.split(' ')[4] === PUBLIC_ROOT)) {
    fail('/vibe-projects 不是独立挂载点；请先配置发布挂载');
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function statMaybe(file) {
  try { return await fs.lstat(file); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function checkFileName(name, isDirectory) {
  if (name.startsWith('.')) fail(`隐藏路径禁止发布：${name}`);
  if (['node_modules', '__pycache__'].includes(name)) fail(`依赖目录禁止发布：${name}`);
  if (isDirectory) return;
  if (/\.map$/i.test(name)) fail(`源码映射文件禁止发布：${name}`);
  if (/\.(?:ts|tsx|jsx|vue|svelte|astro|scss|sass|less|py|sh|bash|php|go|rs|java|kt|swift|c|h|cpp|sql)$/i.test(name)) {
    fail(`疑似源代码禁止发布：${name}`);
  }
  if (/^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Dockerfile|compose\.ya?ml|docker-compose\.ya?ml|tsconfig(?:\..+)?\.json|vite\.config\..+)$/i.test(name)) {
    fail(`疑似源码/项目元数据禁止发布：${name}`);
  }
  if (/\.(?:pem|key|p12|pfx|crt|sqlite|db|log|bak)$/i.test(name)) {
    fail(`敏感或非静态文件禁止发布：${name}`);
  }
}

function wrongRootPath(value, slug) {
  return value.startsWith('/') && !value.startsWith('//') &&
    value !== `/${slug}` && !value.startsWith(`/${slug}/`) && !value.startsWith(`/${slug}#`) &&
    !value.startsWith(`/${slug}?`);
}

// Scan the copied snapshot (not the changing source). Streaming also covers large
// bundles. Overlap catches credential signatures split across stream boundaries.
async function inspectTextFile(file, relative, slug, warnings) {
  const extension = path.extname(file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return;
  let tail = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    const content = tail + chunk;
    for (const [label, pattern] of SECRET_SIGNALS) {
      if (pattern.test(content)) fail(`${relative}：检测到${label}，已中止发布；移除敏感内容后重试`);
    }
    if (CREDENTIAL_FIELD.test(content)) warnings.add(`${relative}：存在疑似凭据字段，请人工审查`);
    if (extension === '.html' || extension === '.htm') {
      for (const match of content.matchAll(/\b(?:src|href|action)\s*=\s*["']([^"'\s]{1,2048})["']/gi)) {
        if (wrongRootPath(match[1], slug)) warnings.add(`${relative}：HTML 引用未使用 /${slug}/ 前缀，子路径部署可能失效`);
      }
    }
    if (['.html', '.htm', '.css'].includes(extension)) {
      for (const match of content.matchAll(/url\(\s*["']?([^\s"')]{1,2048})["']?\s*\)/gi)) {
        if (wrongRootPath(match[1], slug)) warnings.add(`${relative}：CSS url() 未使用 /${slug}/ 前缀，子路径部署可能失效`);
      }
    }
    tail = content.slice(-4096);
  }
}

async function copyValidated(source, target, sourceRoot, slug, stats) {
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, item.name);
    const dest = path.join(target, item.name);
    const st = await fs.lstat(src);
    if (st.isSymbolicLink()) fail(`拒绝发布符号链接：${src}`);
    checkFileName(item.name, st.isDirectory());
    if (st.isDirectory()) {
      await fs.mkdir(dest, { mode: 0o755 });
      await fs.chmod(dest, 0o755);
      await copyValidated(src, dest, sourceRoot, slug, stats);
    } else if (st.isFile()) {
      // Do not follow a file symlink introduced between lstat and open. Projects
      // must still finish building before publication; this is not a hostile FS sandbox.
      const input = await fs.open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await input.stat()).isFile()) fail(`拒绝发布特殊文件：${src}`);
        const output = await fs.open(dest, 'wx', 0o644);
        try { await output.writeFile(input.createReadStream({ autoClose: false })); }
        finally { await output.close(); }
      } finally { await input.close(); }
      await fs.chmod(dest, 0o644);
      await inspectTextFile(dest, path.relative(sourceRoot, src), slug, stats.warnings);
      stats.files += 1;
      stats.bytes += (await fs.stat(dest)).size;
    } else {
      fail(`拒绝发布特殊文件：${src}`);
    }
  }
}

// Explicit roots make the filesystem transaction testable in private temporary
// directories. The CLI below always enforces /workspace and the publish mount.
export async function publishSite({ slug, source, workspaceRoot, publicRoot, publicUrl }) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug ?? '')) {
    fail('slug 只能使用小写字母、数字及内部连字符，长度 1–63');
  }
  const url = `${publicBaseUrl(publicUrl)}/${slug}/`;
  if (!source) fail('必须显式指定静态文件目录');
  const rootStat = await fs.lstat(publicRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('发布根目录必须是真实目录');
  const workspace = await fs.realpath(workspaceRoot);
  publicRoot = await fs.realpath(publicRoot);
  if (inside(workspace, publicRoot) || inside(publicRoot, workspace)) {
    fail('源码根目录和发布根目录必须独立，不能相互包含');
  }
  const src = await fs.realpath(path.resolve(source));
  if (!inside(workspace, src)) fail(`静态文件目录必须位于 ${workspace} 内`);
  if (!(await fs.stat(src)).isDirectory()) fail('构建路径不是目录');

  const target = path.join(publicRoot, slug);
  const privateDir = path.join(publicRoot, '.publish-internal');
  // mkdir is safe for simultaneous publications of different slugs.
  try { await fs.mkdir(privateDir, { mode: 0o700 }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  const privateSt = await fs.lstat(privateDir);
  if (!privateSt.isDirectory() || privateSt.isSymbolicLink()) fail('发布暂存区必须是真实目录');
  await fs.chmod(privateDir, 0o700);
  const lockPath = path.join(privateDir, `${slug}.publish.lock`);
  const backup = path.join(privateDir, `${slug}.previous-${crypto.randomUUID()}`);
  const stats = { files: 0, bytes: 0, warnings: new Set() };
  let lock, stage;
  let previousMoved = false;
  try {
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (err) {
      if (err.code === 'EEXIST') fail(`项目 ${slug} 正在发布或有残留锁：${lockPath}；确认没有发布进程后再手动清理`);
      throw err;
    }
    const before = await statMaybe(target);
    if (before && (before.isSymbolicLink() || !before.isDirectory())) fail(`发布目标不是普通目录，拒绝覆盖：${target}`);
    stage = await fs.mkdtemp(path.join(privateDir, `${slug}.stage-`));
    await fs.chmod(stage, 0o755);
    await copyValidated(src, stage, src, slug, stats);
    const index = await statMaybe(path.join(stage, 'index.html'));
    if (!index?.isFile() || index.size === 0) fail('构建目录必须有非空的普通文件 index.html');

    if (before) {
      await fs.rename(target, backup);
      previousMoved = true;
    }
    try {
      await fs.rename(stage, target);
      stage = undefined;
    } catch (err) {
      if (previousMoved) {
        try { await fs.rename(backup, target); previousMoved = false; }
        catch { fail(`发布切换和恢复失败；旧站点保存在 ${backup}，请人工恢复`); }
      }
      throw err;
    }
    if (previousMoved) {
      try { await fs.rm(backup, { recursive: true, force: true }); }
      catch { stats.warnings.add(`新版本已发布；旧临时目录未删除：${backup}`); }
    }
    return { target, url, files: stats.files, bytes: stats.bytes, warnings: [...stats.warnings] };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

async function main() {
  if (process.argv.length !== 4) fail('用法：node publish.mjs <slug> <已核实的静态目录>');
  await verifyPublishMount();
  const result = await publishSite({
    slug: process.argv[2], source: process.argv[3], publicUrl: process.env.VIBE_PUBLIC_URL,
    workspaceRoot: SOURCE_ROOT, publicRoot: PUBLIC_ROOT,
  });
  console.log(`已发布：${result.target}\n访问：${result.url}\n文件：${result.files} 个，${result.bytes} 字节`);
  for (const warning of result.warnings) console.warn(`审查提醒：${warning}`);
  console.log('仅完成本地文件发布，未验证公网可访问；不保留历史版本。');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(err => { console.error(`发布失败：${err.message}`); process.exitCode = 1; });
}
