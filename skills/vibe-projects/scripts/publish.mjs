#!/usr/bin/env node
/**
 * 将 /workspace 中的静态构建产物校验后发布到 /vibe-projects/<项目标识>。
 * 不保留历史版本。需要 Node.js 20 或更高版本，无需额外依赖。
 *
 * 用法：node publish.mjs 项目标识 静态文件目录
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_ROOT = '/workspace';
const PUBLIC_ROOT = '/vibe-projects';
const PUBLIC_URL = process.env.VIBE_PUBLIC_URL;
const slug = process.argv[2];
const sourceArg = process.argv[3];

function fail(message) {
  throw new Error(message);
}

function publicBaseUrl() {
  if (!PUBLIC_URL?.trim()) fail('未设置 VIBE_PUBLIC_URL；请通过 Docker Compose 注入容器环境变量');
  let url;
  try { url = new URL(PUBLIC_URL.trim()); }
  catch { fail('VIBE_PUBLIC_URL 不是合法的 URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    fail('VIBE_PUBLIC_URL 必须是 HTTP(S) 站点根地址，不含路径、凭据、查询参数或片段');
  }
  return url.origin;
}

async function verifyPublishMount() {
  // 即使用户直接执行脚本，也必须验证发布目录是独立挂载点。
  const info = await fs.readFile('/proc/self/mountinfo', 'utf8');
  if (!info.split('\n').some(line => line.split(' ')[4] === '/vibe-projects')) {
    fail('/vibe-projects 不是独立挂载点；请先配置 Docker Compose 挂载');
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function statMaybe(file) {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// 拒绝隐藏文件、源码映射、敏感项目元数据和符号链接。
function checkFileName(name, isDirectory) {
  if (name.startsWith('.')) fail(`隐藏路径禁止发布：${name}`);
  if (name === 'node_modules' || name === '__pycache__') fail(`依赖目录禁止发布：${name}`);
  if (isDirectory) return;
  if (/\.map$/i.test(name)) fail(`源码映射文件禁止发布：${name}`);
  if (/\.(?:ts|tsx|jsx|vue|svelte|astro|scss|sass|less|py|sh|bash|php|go|rs|java|kt|swift|c|h|cpp|sql)$/i.test(name)) {
    fail(`疑似源代码禁止发布：${name}`);
  }
  if (/^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Dockerfile|compose\.ya?ml|docker-compose\.ya?ml|tsconfig(?:\..+)?\.json|vite\.config\..+|\.npmrc)$/i.test(name)) {
    fail(`疑似源码/项目元数据禁止发布：${name}`);
  }
  if (/\.(?:pem|key|p12|pfx|crt|sqlite|db|log|bak)$/i.test(name)) {
    fail(`敏感或非静态文件禁止发布：${name}`);
  }
}

async function copyValidated(source, target, excluded) {
  const items = await fs.readdir(source, { withFileTypes: true });
  for (const item of items) {
    const src = path.join(source, item.name);
    const dest = path.join(target, item.name);
    const st = await fs.lstat(src);
    if (st.isSymbolicLink()) fail(`拒绝发布符号链接：${src}`);
    if (excluded.has(`${st.dev}:${st.ino}`)) continue;
    checkFileName(item.name, st.isDirectory());
    if (st.isDirectory()) {
      await fs.mkdir(dest, { mode: 0o755 });
      await fs.chmod(dest, 0o755); // 避免严格的文件创建掩码阻止网站服务读取静态资源。
      await copyValidated(src, dest, excluded);
    } else if (st.isFile()) {
      await fs.copyFile(src, dest);
      await fs.chmod(dest, 0o644);
    } else {
      fail(`拒绝发布特殊文件：${src}`);
    }
  }
}

async function main() {
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    fail('用法：node publish.mjs <slug> <静态文件目录>；slug 只能使用小写字母、数字及内部连字符，长度 1–63');
  }
  if (process.argv.length !== 4 || !sourceArg) fail('必须显式指定静态文件目录：node publish.mjs <slug> <静态文件目录>');
  const siteUrl = `${publicBaseUrl()}/${slug}/`;
  await verifyPublishMount();
  const workspace = await fs.realpath(SOURCE_ROOT);
  const publicRoot = await fs.realpath(PUBLIC_ROOT);
  const src = await fs.realpath(path.resolve(sourceArg));
  if (!inside(workspace, src)) fail(`静态文件目录必须位于 ${workspace} 内：${src}`);
  const srcSt = await fs.stat(src);
  if (!srcSt.isDirectory()) fail('构建路径不是目录');

  const indexPath = path.join(src, 'index.html');
  const indexStat = await statMaybe(indexPath);
  if (!indexStat || !indexStat.isFile() || indexStat.size === 0) {
    fail('构建目录必须有非空的普通文件 index.html');
  }

  const rootStat = await fs.lstat(PUBLIC_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('发布根目录必须是真实目录，不能是符号链接');
  const target = path.join(publicRoot, slug);
  // 私有暂存区：Web 服务器不能在文件复制过程中读取未发布内容。
  const privateDir = path.join(publicRoot, '.publish-internal');
  const privateSt = await statMaybe(privateDir);
  if (privateSt && (!privateSt.isDirectory() || privateSt.isSymbolicLink())) {
    fail('发布暂存区必须是真实目录，不能是符号链接');
  }
  if (!privateSt) await fs.mkdir(privateDir, { mode: 0o700 });
  await fs.chmod(privateDir, 0o700);
  const token = crypto.randomUUID();
  const lockPath = path.join(privateDir, `${slug}.publish.lock`);
  const backup = path.join(privateDir, `${slug}.previous-${token}`);
  let lock;
  let stage;
  let previousMoved = false;
  let switched = false;
  try {
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') fail(`项目 ${slug} 正在发布或有残留锁：${lockPath}；确认没有发布进程后再手动清理`);
      throw err;
    }
    stage = await fs.mkdtemp(path.join(privateDir, `${slug}.stage-`));
    await fs.chmod(stage, 0o755);
    const before = await statMaybe(target);
    const excluded = new Set([rootStat, await fs.stat(privateDir), before].filter(Boolean).map(st => `${st.dev}:${st.ino}`));
    await copyValidated(src, stage, excluded);

    if (before) {
      if (before.isSymbolicLink() || !before.isDirectory()) {
        fail(`发布目标不是普通目录，拒绝覆盖：${target}`);
      }
      await fs.rename(target, backup);
      previousMoved = true;
    }

    try {
      await fs.rename(stage, target);
      switched = true;
      stage = undefined;
    } catch (err) {
      if (previousMoved) {
        await fs.rename(backup, target);
        previousMoved = false;
      }
      throw err;
    }
    if (previousMoved) {
      // 清理旧目录失败时，不回滚已经发布成功的新版本。
      try {
        await fs.rm(backup, { recursive: true, force: true });
        previousMoved = false;
      } catch (err) {
        console.warn(`新版本已发布；旧临时目录未能删除：${backup} (${err.message})`);
      }
    }
    console.log(`已发布：${target}`);
    console.log(`访问：${siteUrl}`);
    console.log('无历史版本保留。');
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
    if (!switched && previousMoved) {
      console.error(`发布异常：旧站点临时目录可能仍在 ${backup}，请人工检查`);
    }
  }
}

main().catch(err => { console.error(`发布失败：${err.message}`); process.exitCode = 1; });
