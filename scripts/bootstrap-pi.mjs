#!/usr/bin/env node
// Online package lifecycle only. Provider configuration, credentials and protocols belong to Pi/extensions.
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const checkOnly = process.argv[2] === '--check';
if (process.argv.length > (checkOnly ? 3 : 2)) throw new Error('Invalid private bootstrap operation');
const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/node/.pi/agent';
const manifestPath = process.env.PIC_PI_BOOTSTRAP_MANIFEST || '/opt/pic/config/pi-bootstrap.json';
const markerPath = join(agentDir, '.pic-packages.json');
const offline = process.env.PI_OFFLINE === '1';
async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const manifest = await json(manifestPath, { packages: [] });
if (!Array.isArray(manifest.packages) || !manifest.packages.every(item =>
  item && typeof item.source === 'string' && /^(npm:|git:)\S+$/.test(item.source) &&
  (item.name === undefined || typeof item.name === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(item.name))
)) throw new Error('Bootstrap packages must use online npm:/git: sources');
const state = await json(markerPath, { version: 1, installed: [] });
if (state.version !== 1 || !Array.isArray(state.installed) || !state.installed.every(source => typeof source === 'string') ||
    (state.pending !== undefined && typeof state.pending !== 'string')) throw new Error('Invalid Pi bootstrap state');
async function save() {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(temporary, markerPath);
}
for (const item of manifest.packages) {
  if (checkOnly) {
    if (!state.installed.includes(item.source) || state.pending === item.source) throw new Error('Pi package initialization/update is incomplete; retry when all hosted Pi processes have exited');
    continue;
  }
  const settings = await json(join(agentDir, 'settings.json'), {});
  let configured = false, alternative = false;
  for (const entry of settings.packages ?? []) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (source === item.source) { configured = true; break; }
    if (typeof source !== 'string') continue;
    // An operator's explicit ref/local package is not permission to migrate their declaration.
    if (item.source.startsWith('git:') && source.startsWith(`${item.source}@`)) alternative = true;
    if (!item.name || !(source.startsWith('/') || source.startsWith('.'))) continue;
    let existing;
    try { existing = await json(join(resolve(agentDir, source), 'package.json')); }
    catch (error) { if (error.code === 'ENOTDIR') continue; throw error; }
    if (existing?.name === item.name) alternative = true;
  }
  const known = state.installed.includes(item.source);
  if (!configured && (known || alternative)) {
    if (!known) state.installed.push(item.source);
    if (state.pending === item.source) delete state.pending;
    await save();
    continue; // Preserve a deliberate uninstall or an operator-managed installation.
  }
  if (offline) {
    if (!configured || state.pending === item.source) throw new Error('Pi package is not ready for offline startup');
    if (!known) { state.installed.push(item.source); await save(); }
    continue;
  }
  const action = configured ? 'update' : 'install';
  state.pending = item.source;
  await save();
  console.error(`[pic] ${action === 'update' ? 'Updating' : 'Installing'} Pi package: ${item.source}`);
  const result = spawnSync(process.env.PIC_PI_BINARY || 'pi', [action, item.source, '--no-approve'], {
    stdio: 'inherit', env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: 'true' },
  });
  if (result.error || result.status !== 0) throw new Error('Pi package installation/update failed; refusing startup until a successful retry');
  if (!known) state.installed.push(item.source);
  delete state.pending;
  await save();
}
// Callers serialize updates against hosted process lifetimes. Pi owns settings persistence.
