#!/usr/bin/env node
// This file runs only after setpriv has dropped UID, groups and capabilities.
// Never expose app-controlled LD_PRELOAD/NODE_OPTIONS to the root supervisor.
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { validateManifest } from './protocol.mjs';
// The immutable definition comes through a supervisor-owned pipe, not a
// manifest file that the running application's UID could have modified.
let definition = '';
for await (const chunk of createReadStream('', { fd: 3, autoClose: true })) definition += chunk;
const manifest = validateManifest(JSON.parse(definition));
const child = spawn(manifest.command[0], manifest.command.slice(1), {
  env: { ...process.env, ...manifest.env }, stdio: 'inherit',
});
// The supervisor signals the entire process group. Stay alive while the app
// handles SIGTERM so the supervisor does not immediately reap its descendants.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
child.once('error', err => { console.error('应用入口启动失败：', err.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
