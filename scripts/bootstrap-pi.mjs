#!/usr/bin/env node
// Package bootstrap only. Provider configuration, credentials and protocols belong to Pi/extensions.
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/node/.pi/agent';
const manifestPath = process.env.PIC_PI_BOOTSTRAP_MANIFEST || '/opt/pic/config/pi-bootstrap.json';
const markerPath = join(agentDir, '.pic-packages.json');
async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const manifest = await json(manifestPath, { packages: [] });
if (!Array.isArray(manifest.packages) || !manifest.packages.every(x => x && typeof x.source === 'string' && x.source.length && !x.source.startsWith('-'))) throw new Error('Invalid Pi bootstrap manifest');
const state = await json(markerPath, { version: 1, installed: [] });
if (state.version !== 1 || !Array.isArray(state.installed)) throw new Error('Invalid Pi bootstrap state');
for (const item of manifest.packages) {
  let bundled;
  // The image pins local package contents; external sources must carry an explicit version/ref.
  if (item.source.startsWith('/')) {
    const pkg = await json(join(resolve(item.source), 'package.json'));
    if (!pkg || pkg.version !== item.version) throw new Error('Bundled Pi package version mismatch');
    bundled = pkg;
  } else if (typeof item.version !== 'string' || !item.version || !item.source.endsWith(`@${item.version}`)) throw new Error('Bootstrap packages must include their pinned version/ref in the source');
  if (state.installed.includes(item.source)) continue;
  let alreadyConfigured = false;
  if (bundled?.name) {
    const settings = await json(join(agentDir, 'settings.json'), {});
    for (const entry of settings.packages ?? []) {
      const source = typeof entry === 'string' ? entry : entry?.source;
      if (typeof source !== 'string' || !(source.startsWith('/') || source.startsWith('.'))) continue;
      let existing;
      try { existing = await json(join(resolve(agentDir, source), 'package.json')); }
      catch (error) { if (error.code === 'ENOTDIR') continue; throw error; }
      if (existing?.name === bundled.name) { alreadyConfigured = true; break; }
    }
  }
  if (!alreadyConfigured) {
    console.error(`[pic] Installing Pi package: ${item.source}`);
    const result = spawnSync(process.env.PIC_PI_BINARY || 'pi', ['install', item.source], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Pi package installation failed; bootstrap was not marked complete');
  }
  state.installed.push(item.source);
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(temporary, markerPath);
}
// Deliberate user uninstall stays uninstalled. No credential/models/settings rewrite here.
