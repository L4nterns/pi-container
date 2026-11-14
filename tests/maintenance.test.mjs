import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pty } from './helpers/pty.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hash = (s, n) => createHash('sha256').update(s).digest('hex').slice(0, n);
const esc = '\x1b', select = n => '\x1b[H' + '\x1b[B'.repeat(n) + '\r';
const hint = '「↑/↓」选择 · 「Enter」确认', page = '「PgUp/PgDn」翻页';
const step = (...keys) => keys.map(key => [hint, key]);

test('maintenance lock restores the caller umask after opening private lock files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-lock-umask-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = String.raw`
set -euo pipefail
REPO=$1
source "$2"
umask 022
before=$(umask)
pc_maintenance_lock
after=$(umask)
[[ "$before" = 0022 ]]
[[ "$after" = 0022 ]]
[[ "$(stat -c %a "$REPO/.update.lock")" = 600 ]]
[[ "$(stat -c %a "$REPO/.services.lock")" = 600 ]]
printf 'UMASK:%s:%s\n' "$before" "$after"
`;
  const result = spawnSync('bash', ['-c', script, '_', root, path.join(repo, 'lib/update.sh')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UMASK:0022:0022/);
});
const docker = String.raw`
const fs=require('node:fs');
const a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(process.env.RESOURCE_STATE,'utf8'));
fs.appendFileSync(process.env.RESOURCE_LOG,JSON.stringify({a,workspace:process.env.PIC_WORKSPACE,history:process.env.PIC_HISTORY_DIR})+'\n');
const save=()=>{const p=process.env.RESOURCE_STATE+'.'+process.pid;fs.writeFileSync(p,JSON.stringify(s));fs.renameSync(p,process.env.RESOURCE_STATE);};
const opt=k=>a[a.indexOf(k)+1];
const c=s.containers.find(c=>a.includes(c.id));
const label=(c,key)=>({'com.docker.compose.project':c.project,'com.docker.compose.service':c.service,'com.docker.compose.project.working_dir':c.repo,'io.pi-container.installation':c.installation,'io.pi-container.user':c.user,'io.pi-container.role':c.role}[key]);
const filters=a.flatMap((v,i)=>v==='--filter'?[a[i+1]]:[]);
function filter(c){return filters.every(f=>{if(!f.startsWith('label='))return true;const [k,...v]=f.slice(6).split('=');return label(c,k)===v.join('=');});}
function image(){return s.images.find(i=>i.id===a.at(-1)||i.tags.includes(a.at(-1)));}
if(a[0]==='ps')for(const c of s.containers.filter(filter))console.log(c.id);
else if(a[0]==='inspect'){
 if(!c){console.error('container absent');process.exit(1);}
 const t=opt('--format');
 if(t.includes('.Mounts')){const dest=/eq .Destination "([^"]+)"/.exec(t)[1];console.log(({'/workspace':c.workspace,'/home/node/.pi/agent':c.data,'/run/deploy-credentials':c.credentials,'/srv/app-services':c.data}[dest])||'');}
 else if(t.includes('.Config.Labels'))console.log(t.includes('working_dir')?c.repo+'\t'+c.project+'\t'+c.service:c.project);
 else if(t.includes('.State.Running'))console.log(c.state==='running'?'true':'false');
 else if(t.includes('.State.Status')){if(c.stateError)process.exit(70);console.log(t.includes('printf')?c.state+'\t0\t-':c.state);}
 else if(t.includes('.HostConfig.PortBindings'))console.log(c.binding??'127.0.0.1:18080');
 else if(t.includes('.ExecIDs')){if(t.includes('len'))console.log(c.execs.length);else console.log(c.execs.join('\n'));}
 else if(t==='{{.Image}}')console.log(c.image);
}else if(a[0]==='build'){
 if(process.env.FAIL_BUILD===(a.includes('--file')?'service':'development')){console.error('synthetic build failure');process.exit(74);}
 const tag=opt('--tag');for(const i of s.images)i.tags=i.tags.filter(t=>t!==tag);
 s.images.push({id:'sha256:build'+(++s.seq),tags:[tag],installation:process.env.INSTALL_HASH});
 if(process.env.CHANGE_STATE_DURING_BUILD)s.containers.find(c=>c.id==='service').state='exited';
 if(process.env.CREATE_PROJECT_DURING_BUILD)s.containers.push({id:'late-project',project:'pic-r'+process.env.INSTALL_HASH+'-u1000-'+require('node:crypto').createHash('sha256').update(process.env.PIC_WORKSPACE).digest('hex').slice(0,16),repo:process.env.INSTALL_REPO,service:'pi',workspace:process.env.PIC_WORKSPACE,data:process.env.INSTALL_REPO+'/data',state:'created',sessions:[],execs:[],image:s.images.at(-1).id});
 if(process.env.REMOVE_WORKSPACE_DURING_BUILD)fs.rmdirSync(process.env.PIC_WORKSPACE);
 save();
}else if(a[0]==='image'){
 if(a[1]==='ls')for(const i of s.images.filter(i=>filters.every(f=>f==='dangling=true'?i.tags.length===0:f==='label=io.pi-container.installation='+i.installation)))console.log(i.id);
 else if(a[1]==='inspect'){
  const i=image();if(!i)process.exit(1);
  const t=opt('--format');console.log(t==='{{.Id}}'?i.id:t?.includes('.RepoTags')?i.tags.join('\n'):'[]');
 }else if(a[1]==='rm'){
  const i=image();if(!i)process.exit(1);
  const isTag=i.tags.includes(a.at(-1));
  if((!isTag||i.tags.length===1)&&s.containers.some(c=>c.image===i.id)){console.error('image still in use');process.exit(41);}
  if(isTag)i.tags=i.tags.filter(t=>t!==a.at(-1));
  else if(!i.tags.length)s.images=s.images.filter(j=>j!==i);
  if(isTag&&!i.tags.length)s.images=s.images.filter(j=>j!==i);
  save();
 }
}else if(a[0]==='network'){
 if(a[1]==='ls')for(const n of s.networks.filter(n=>filters.includes('label=com.docker.compose.project='+n.project)))console.log(n.id);
 else if(a[1]==='rm'){s.networks=s.networks.filter(n=>!a.includes(n.id));save();}
}else if(a[0]==='start'){c.state='running';save();}
else if(a[0]==='logs')console.log('LOG-FOR:'+c.id);
else if(a[0]==='stop'){for(const c of s.containers.filter(c=>a.includes(c.id)))c.state='exited';save();}
else if(a[0]==='rm'){s.containers=s.containers.filter(c=>!a.includes(c.id));save();}
else if(a[0]==='unpause'){c.state='running';save();}
else if(a[0]==='top'){if(c.topError){console.error('synthetic unknown SSH processes');process.exit(79);}console.log('PID USER COMMAND\n421 deploy sshd');}
else if(a[0]==='exec'){
 if(a.includes('/usr/local/bin/pic-session')){
  if(a.at(-1)==='list'){if(c.listError){console.error('synthetic unknown sessions');process.exit(1);}for(const n of c.sessions)console.log(n+'\t0\t1700000000');}
  else if(a.at(-1)==='count'){if(c.countError)process.exit(1);console.log(c.sessions.length);}
  else if(a.includes('close')){c.sessions=c.sessions.filter(n=>n!==a.at(-1));save();}
 }else if(a.includes('/usr/local/bin/deploy-register'))console.log('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICZbxB6rD5TGtb2T/JKn4uf6eoWr5j2WT6eOo+CFc4JI');
 else if(a.includes('stat')&&a.includes('-Lc')){const st=fs.statSync(c.workspace);console.log(process.env.STALE_WORKSPACE_INODE||st.dev+':'+st.ino);}
 else if(a.includes('supervisorctl')){if(c.appError){console.error('synthetic unknown app state');process.exit(78);}console.log('demo RUNNING pid 123, uptime 1:00:00');}
}else if(a[0]==='compose'){
 const project=opt('--project-name'),service=a.at(-1),list=s.containers.filter(c=>c.project===project&&c.service===service);
 if(a.includes('config'))for(const k of ['DEPLOY_DATA_DIR','DEPLOY_PORT','DEPLOY_PUBLIC_URL'])console.log(k+'='+(process.env[k]||''));
 else if(a.includes('ps')){for(const c of list)if(a.includes('-aq')||c.state==='running')console.log(c.id);}
 else if(a.includes('up')){
  if(process.env.FAIL_RECREATE){console.error('synthetic recreate failure');process.exit(71);}
  const tag=service==='pi'?process.env.PIC_IMAGE:'app-services:r'+process.env.INSTALL_HASH;
  if(a.includes('--force-recreate'))s.containers=s.containers.filter(c=>!list.includes(c));
  if(!list.length||a.includes('--force-recreate'))s.containers.push({id:'new-'+(++s.seq),repo:process.env.INSTALL_REPO,project,service,workspace:process.env.PIC_WORKSPACE,data:service==='pi'?process.env.INSTALL_REPO+'/data':process.env.DEPLOY_DATA_DIR,binding:'127.0.0.1:'+process.env.DEPLOY_PORT,state:a.includes('--no-start')?'created':'running',sessions:[],execs:[],image:s.images.find(i=>i.tags.includes(tag)).id});
  save();
 }else if(a.includes('stop')){for(const c of list)c.state='exited';save();}
 else if(a.includes('down')){s.containers=s.containers.filter(c=>!list.includes(c));save();}
}
`;

async function fixture(t, { git = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-maintenance-'));
  const tool = path.join(root, 'tool'), project = path.join(root, 'project with spaces'), bin = path.join(root, 'bin');
  await fs.mkdir(tool); await fs.mkdir(project); await fs.mkdir(bin);
  for (const file of ['bin', 'lib', 'scripts', 'config', 'compose.yaml', 'compose.deploy.yaml', 'compose.services.yaml', '.env.example', '.gitignore', '.dockerignore', 'Dockerfile', 'services/Dockerfile', 'README.md', 'package.json', '.npmrc', 'LICENSE']) {
    await fs.mkdir(path.dirname(path.join(tool, file)), { recursive: true });
    await fs.cp(path.join(repo, file), path.join(tool, file), { recursive: true, verbatimSymlinks: true });
  }
  await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}\n${docker}`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u|-g|-G) echo 1000;; esac\n', { mode: 0o755 });
  const stateFile = path.join(root, 'state.json'), log = path.join(root, 'calls.jsonl');
  const installation = hash(tool, 8), prefix = `pic-r${installation}-u1000-`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TERM: 'xterm-256color', RESOURCE_STATE: stateFile, RESOURCE_LOG: log, INSTALL_HASH: installation, INSTALL_REPO: tool,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DEPLOY_DATA_DIR: '', DEPLOY_PORT: '18080', DEPLOY_PUBLIC_URL: '' };
  const gitRun = (dir, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', dir, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  let old, target, upstream;
  if (git) {
    gitRun(tool, 'init', '-b', 'main'); gitRun(tool, 'add', '.'); gitRun(tool, 'commit', '-m', 'installed'); old = gitRun(tool, 'rev-parse', 'HEAD');
    upstream = path.join(root, 'upstream.git'); gitRun(root, 'clone', '--bare', tool, upstream);
    const author = path.join(root, 'author'); gitRun(root, 'clone', upstream, author);
    await fs.writeFile(path.join(author, 'release.txt'), 'new upstream source\n'); gitRun(author, 'add', '.'); gitRun(author, 'commit', '-m', 'upstream update'); gitRun(author, 'push', 'origin', 'main'); target = gitRun(author, 'rev-parse', 'HEAD');
    gitRun(tool, 'remote', 'add', 'origin', 'https://github.com/L4nterns/pic.git');
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${upstream}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/L4nterns/pi-container.git' });
  }
  const state = () => fs.readFile(stateFile, 'utf8').then(JSON.parse);
  const write = async value => { const temp=stateFile+'.next'; await fs.writeFile(temp, JSON.stringify(value)); await fs.rename(temp, stateFile); };
  await write({ seq: 0, containers: [], images: [], networks: [] });
  const calls = () => fs.readFile(log, 'utf8').catch(() => '').then(s => s.trim().split('\n').filter(Boolean).map(JSON.parse));
  const run = (args, extra = {}) => spawnSync('bash', [path.join(tool, 'scripts/control.sh'), ...args], { cwd: project, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  const menu = async (steps, extra = {}) => {
    const proc = pty.spawn('bash', ['-c', 'saved=$(stty -g); bash "$1"; status=$?; if [[ $(stty -g) == "$saved" ]]; then printf "TTY-RESTORED:yes\\n"; else printf "TTY-RESTORED:no\\n"; fi; exit "$status"', '_', path.join(tool, 'bin/pi-container')], { cwd: project, env: { ...env, ...extra }, cols: 160, rows: 38 });
    let output = '', pending = '', index = 0;
    const timer = setTimeout(() => proc.kill('SIGTERM'), 16000);
    const exited = new Promise(resolve => proc.onExit(resolve));
    proc.onData(data => {
      output += data; pending += data;
      while (index < steps.length) {
        const [text, keys] = steps[index], at = pending.indexOf(text);
        if (at < 0) break;
        pending = pending.slice(at + text.length); index++; proc.write(typeof keys === 'function' ? keys() : keys);
      }
    });
    const result = await exited; clearTimeout(timer);
    assert.equal(index, steps.length, output); assert.equal(result.exitCode, 0, output); assert.match(output, /TTY-RESTORED:yes/); return output;
  };
  t.after(async () => {
    const runtime = path.join(tool, '.runtime');
    for (const dir of await fs.readdir(runtime).catch(() => [])) {
      for (const file of await fs.readdir(path.join(runtime, dir)).catch(() => [])) {
        if (!file.endsWith('.pid')) continue;
        const pid = Number(await fs.readFile(path.join(runtime, dir, file), 'utf8'));
        if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      }
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const seed = async ({ serviceState = 'running' } = {}) => {
    const second = path.join(root, 'another project'); await fs.mkdir(second, { recursive: true });
    for (const dir of ['data', 'services-data/setup.d', '.deploy-keys/installation']) await fs.mkdir(path.join(tool, dir), { recursive: true });
    const protectedFiles = { '.env': 'local configuration\n', 'data/history.json': 'saved conversation', 'data/auth.json': 'synthetic credential', 'services-data/setup.d/app.sh': 'persistent deployment script', '.deploy-keys/installation/id_ed25519': 'synthetic key' };
    for (const [file, content] of Object.entries(protectedFiles)) await fs.writeFile(path.join(tool, file), content);
    const make = (id, directory, state) => ({ id, project: prefix + hash(directory, 16), service: 'pi', repo: tool, workspace: directory, data: path.join(tool, 'data'), state, sessions: ['work-in-progress'], execs: ['external-exec-id'], image: 'sha256:dev' });
    const containers = [make('current', project, 'running'), make('stopped', second, 'exited'), { id: 'service', project: 'app-services-r'+installation, service: 'services', repo: tool, data: path.join(tool, 'services-data'), state: serviceState, sessions: [], execs: [], image: 'sha256:service' },
      { ...make('other-user', second, 'running'), project: prefix.replace('u1000-', 'u2000-')+'1'.repeat(16), image: 'sha256:foreign' },
      { ...make('other-install', second, 'running'), repo: '/different-installation', project: 'pic-r12345678-u1000-'+'2'.repeat(16), image: 'sha256:foreign' }];
    await write({ seq: 0, containers, images: [{ id: 'sha256:dev', tags: [`pic:r${installation}`], installation }, { id: 'sha256:service', tags: [`app-services:r${installation}`], installation }, { id: 'sha256:old', tags: [], installation }, { id: 'sha256:foreign', tags: ['foreign:latest'], installation: 'foreign' }], networks: containers.slice(0, 3).map(c => ({ id: c.id+'-network', project: c.project })) });
    env.DEPLOY_DATA_DIR = path.join(tool, 'services-data'); return protectedFiles;
  };
  const protectedEqual = async files => { for (const [f, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(tool, f), 'utf8'), content, f); };
  return { root, tool, project, env, run, menu, calls, state, write, gitRun, old, target, upstream, seed, protectedEqual, prefix, installation };
}
const projectTarget = c => [c.project, c.id, c.workspace];

test('project selection lists only this installation/user, includes an explicit uncreated current directory and is read-only', async t => {
  const f = await fixture(t, { git: false });
  let r = f.run(['project-list']); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\t-\t未创建\t/); assert(r.stdout.includes(f.project));
  await assert.rejects(fs.access(path.join(f.tool, '.runtime')));
  await f.seed(); await fs.writeFile(path.join(f.tool, '.env'), 'invalid dotenv');
  r = f.run(['project-list']); assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map(s => s.split('\t'));
  assert.equal(rows.length, 2); assert.equal(rows[0][1], 'current'); assert.equal(rows[1][1], 'stopped');
  assert(!r.stdout.includes('other-user') && !r.stdout.includes('other-install'));
  assert(!(await f.calls()).some(c => c.a.some(v => ['build', 'up', 'stop', 'start', 'config', 'exec'].includes(v))));
  await assert.rejects(fs.access(path.join(f.tool, '.runtime')));
});

test('a selected other project owns state, logs and its terminal, without starting services or reusing cwd', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  const before = await f.state(), b = before.containers.find(c => c.id === 'stopped');
  const status = f.run(['project-state', ...projectTarget(b)]);
  assert.equal(status.status, 0, status.stderr); assert(status.stdout.includes(b.workspace)); assert.match(status.stdout, /已停止/);
  const logs = f.run(['project-logs', ...projectTarget(b)]); assert.equal(logs.status, 0, logs.stderr); assert.match(logs.stdout, /LOG-FOR:stopped/);
  await fs.writeFile(path.join(f.tool, '.env'), 'invalid dotenv');
  const out = await f.menu(step(select(2), select(0), select(1), select(1)));
  assert(out.includes(b.workspace));
  const calls = await f.calls(), shell = calls.find(c => c.a.includes('--dev-shell'));
  assert(shell?.a.includes('stopped')); assert.equal(shell.workspace, b.workspace);
  assert.equal(shell.history, `/home/node/.pi/agent/project-history/1000-${b.project.split('-').at(-1)}`);
  assert(!calls.some(c => c.a[0] === 'build' || c.a.includes('up') || c.a.includes('config') || c.a.includes('deploy-register')));
  assert.equal((await f.state()).containers.find(c => c.id === 'current').state, 'running');
});

test('selected project stop/delete use the exact CID, preserve all binds and do not touch other projects/services', async t => {
  const f = await fixture(t, { git: false }), files = await f.seed();
  const b = (await f.state()).containers.find(c => c.id === 'stopped');
  let r = f.run(['project-stop', ...projectTarget(b)]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /无需操作/);
  const state = await f.state(); state.containers.find(c => c.id === b.id).state = 'running'; await f.write(state);
  r = f.run(['project-stop', ...projectTarget(b)]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /已停止/);
  r = f.run(['project-remove', ...projectTarget(b)]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /已删除/);
  const after = await f.state(); assert(!after.containers.some(c => c.id === b.id));
  assert.equal(after.containers.find(c => c.id === 'current').state, 'running'); assert.equal(after.containers.find(c => c.id === 'service').state, 'running');
  await f.protectedEqual(files);
  const calls = await f.calls(); assert(!calls.some(c => c.a.includes('down') || c.a.includes('--volumes') || c.a.includes('prune')));
  assert(calls.filter(c => c.a[0] === 'stop' || c.a[0] === 'rm').every(c => c.a.includes(b.id)));
});

test('project identity, data bind, workspace hash and CID are rechecked; a stale selection never acts on its replacement', async t => {
  for (const change of ['cid', 'workspace', 'data', 'owner']) {
    const f = await fixture(t, { git: false }); await f.seed(); const state = await f.state(), b = { ...state.containers.find(c => c.id === 'stopped') };
    const target = state.containers.find(c => c.id === b.id);
    if (change === 'cid') target.id = 'replacement';
    if (change === 'workspace') target.workspace = f.project;
    if (change === 'data') target.data = '/wrong-pi-data';
    if (change === 'owner') target.repo = '/other-installation';
    await f.write(state);
    for (const op of ['state', 'logs', 'activity', 'stop', 'remove', 'shell']) {
      const r = f.run(['project-' + op, ...projectTarget(b)]);
      assert.notEqual(r.status, 0, `${change}/${op}`);
    }
    assert(!(await f.calls()).some(c => c.a.some(v => ['start', 'stop', 'rm', 'up', 'build', '--dev-shell'].includes(v))));
  }
});

test('a container replacement after the project confirmation is shown returns to the picker without touching the replacement', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  const output = await f.menu([...step(select(2), select(0), select(0), select(3)), [hint, () => {
    const filename = path.join(f.root, 'state.json'), state = JSON.parse(readFileSync(filename, 'utf8'));
    state.containers.find(c => c.id === 'current').id = 'replacement'; writeFileSync(filename, JSON.stringify(state)); return '\r';
  }], [page, esc], ...step(esc, esc, esc)]);
  assert.match(output, /项目容器或挂载已变化/);
  assert.equal((await f.state()).containers.find(c => c.id === 'replacement').state, 'running');
  assert(!(await f.calls()).some(c => c.a[0] === 'stop' || c.a[0] === 'rm'));
});

test('waiting for a maintenance lock cannot turn a reviewed project into its replacement target', async t => {
  const f = await fixture(t, { git: false }); await f.seed(); const state = await f.state(), b = { ...state.containers.find(c => c.id === 'stopped') };
  const holder = spawn('flock', ['-x', path.join(f.tool, '.update.lock'), 'bash', '-c', 'printf READY; read -r _'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { holder.stdin.end(); });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  const worker = spawn('bash', [path.join(f.tool, 'scripts/control.sh'), 'project-remove', ...projectTarget(b)], { cwd: f.project, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; worker.stderr.on('data', d => stderr += d);
  const ended = new Promise(resolve => worker.once('exit', resolve));
  await wait(async () => stderr.includes('等待维护完成'));
  state.containers.find(c => c.id === b.id).id = 'replacement-while-waiting'; await f.write(state); holder.stdin.end();
  assert.equal(await ended, 75, stderr);
  assert((await f.state()).containers.some(c => c.id === 'replacement-while-waiting'));
  assert(!(await f.calls()).some(c => c.a[0] === 'stop' || c.a[0] === 'rm'));
});

test('failed shell entry does not add idle management to a running container or initialize a protected/aliased workspace', async t => {
  const f = await fixture(t, { git: false }); await f.seed(); const state = await f.state(), b = state.containers.find(c => c.id === 'stopped');
  b.state = 'running'; await f.write(state);
  let r = f.run(['project-shell', ...projectTarget(b)], { STALE_WORKSPACE_INODE: '0:1' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /项目目录已被替换/);
  const runtime = path.join(f.tool, '.runtime', b.project);
  assert(!(await fs.readdir(runtime)).some(n => n.startsWith('idle-')));
  assert.equal((await f.state()).containers.find(c => c.id === b.id).state, 'running');
  await fs.rmdir(b.workspace); await fs.symlink(f.project, b.workspace);
  r = f.run(['project-shell', ...projectTarget(b)]); assert.notEqual(r.status, 0); assert.match(r.stderr, /别名/);
  b.workspace = path.join(f.tool, 'data'); b.project = f.prefix + hash(b.workspace, 16); await f.write(state);
  r = f.run(['project-shell', ...projectTarget(b)]); assert.notEqual(r.status, 0); assert.match(r.stderr, /工作区不能包含/);
  assert(!(await f.calls()).some(c => c.a.includes('--dev-shell') || c.a.includes('/usr/local/bin/pic-workspace-init') || c.a[0] === 'start' || c.a[0] === 'stop'));
});

test('a disappeared project directory remains manageable by CID but shell refuses it; stale bind inodes cannot enter a terminal', async t => {
  const f = await fixture(t, { git: false }); await f.seed(); const b = (await f.state()).containers.find(c => c.id === 'stopped');
  await fs.rmdir(b.workspace);
  assert.equal(f.run(['project-list']).status, 0);
  assert.equal(f.run(['project-logs', ...projectTarget(b)]).status, 0);
  let r = f.run(['project-shell', ...projectTarget(b)]); assert.notEqual(r.status, 0); assert.match(r.stderr, /项目目录不存在/);
  await fs.mkdir(b.workspace);
  r = f.run(['project-shell', ...projectTarget(b)], { STALE_WORKSPACE_INODE: '0:1' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /项目目录已被替换/);
  assert(!(await f.calls()).some(c => c.a.includes('--dev-shell')));
  r = f.run(['project-remove', ...projectTarget(b)]); assert.equal(r.status, 0, r.stderr);
});

test('a newly created container cannot replace an uncreated project selection', async t => {
  const f = await fixture(t, { git: false });
  const row = f.run(['project-list']).stdout.trim().split('\t'), target = [row[0], '-', row[3]];
  await f.seed();
  const r = f.run(['project-shell', ...target]); assert.equal(r.status, 75, r.stderr);
  assert(!(await f.calls()).some(c => c.a.includes('--dev-shell') || c.a.includes('up') || c.a[0] === 'build'));
});

test('uncreated project shells prepare only their missing image, recheck after building and never replace a container that appeared', async t => {
  for (const change of ['', 'CREATE_PROJECT_DURING_BUILD', 'REMOVE_WORKSPACE_DURING_BUILD']) {
    const f = await fixture(t, { git: false });
    const row = f.run(['project-list']).stdout.trim().split('\t'), target = [row[0], '-', row[3]];
    const r = f.run(['project-shell', ...target], change ? { [change]: '1' } : {});
    const calls = await f.calls(); assert.equal(calls.filter(c => c.a[0] === 'build').length, 1);
    if (!change) {
      assert.equal(r.status, 0, r.stderr);
      assert(calls.some(c => c.a.includes('--dev-shell'))); assert(calls.some(c => c.a.includes('up')));
    } else {
      assert.notEqual(r.status, 0, r.stderr); assert(!calls.some(c => c.a.includes('--dev-shell') || c.a.includes('up')));
      if (change === 'CREATE_PROJECT_DURING_BUILD') assert.equal((await f.state()).containers[0].id, 'late-project');
    }
    assert(!calls.some(c => c.a.includes('services') || c.a.includes('--file') && c.a.includes('build')));
  }
});

test('project management stays available after the caller directory is deleted, without falling back to a new workspace', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  const r = spawnSync('bash', ['-c', 'cd -- "$1"; rmdir -- "$1"; bash "$2" project-list', '_', f.project, path.join(f.tool, 'scripts/control.sh')], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\tcurrent\t/); assert.match(r.stdout, /\tstopped\t/);
  assert(!r.stdout.includes('\t-\t未创建\t'));
  assert(!(await f.calls()).some(c => c.a.includes('up') || c.a.includes('--dev-shell')));
});

const checked = f => { const r = f.run(['tool-check']); assert.equal(r.status, 0, r.stderr); return r.stdout.trim().split('\t'); };
const wait = async fn => { for (let n=0; n<120; n++) { if (await fn()) return; await new Promise(r=>setTimeout(r, 50)); } assert.fail('timed out waiting for idle stop'); };

test('explicit public Git check fetches only source, retains legacy origin, and does not use Docker or change checkout', async t => {
  const f = await fixture(t), [old, target, mode] = checked(f);
  assert.equal(old, f.old); assert.equal(target, f.target); assert.equal(mode, 'standard');
  assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), old);
  assert.equal(f.gitRun(f.tool, 'remote', 'get-url', 'origin'), 'https://github.com/L4nterns/pic.git');
  assert.deepEqual(await f.calls(), []); await assert.rejects(fs.access(path.join(f.tool, '.runtime')));
});

test('update lists running Pi, rebuilds both images without cache before scoped replacements and preserves all bind data', async t => {
  const f = await fixture(t), files = await f.seed(); checked(f);
  const plan = f.run(['tool-plan']); assert.equal(plan.status, 0, plan.stderr); assert.match(plan.stdout, /work-in-progress/); assert.match(plan.stdout, /external-exec-id/);
  const r = f.run(['tool-update', f.old, f.target, 'standard']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), f.target); await f.protectedEqual(files);
  const calls = await f.calls(), builds = calls.filter(c=>c.a[0]==='build'), ups = calls.filter(c=>c.a.includes('up'));
  assert.equal(builds.length, 2); assert(builds.every(c=>c.a.includes('--no-cache')&&c.a.includes('--pull')));
  assert(calls.indexOf(builds[1]) < calls.indexOf(ups[0])); assert.equal(ups.length, 3);
  assert(ups.every(c=>c.a.includes('--no-build')&&c.a.includes('--force-recreate')));
  assert(ups.filter(c=>c.a.at(-1)==='pi').every(c=>c.a.includes('--no-start')));
  assert(ups.find(c=>c.a.at(-1)==='services').a.includes('--wait'));
  const resources=await f.state();
  assert.equal(resources.containers.filter(c=>c.id.startsWith('other-')).length, 2);
  assert.equal(resources.containers.filter(c=>c.id.startsWith('new-')).length, 3);
  assert(resources.containers.filter(c=>c.id.startsWith('new-')&&c.service==='pi').every(c=>c.state==='created'));
  assert(!calls.some(c=>c.a.includes('prune')||c.a.includes('--volumes')||c.a.includes('update')||c.a.includes('--pic-session')));
});

test('a manually stopped service remains stopped; missing containers are never created by update', async t => {
  const f = await fixture(t); await f.seed({ serviceState: 'exited' });
  const s=await f.state(); s.containers=s.containers.filter(c=>c.service!=='pi'); await f.write(s);
  checked(f); const r=f.run(['tool-update', f.old, f.target, 'standard']); assert.equal(r.status,0,r.stderr);
  const ups=(await f.calls()).filter(c=>c.a.includes('up')); assert.equal(ups.length,1); assert(ups[0].a.includes('--no-start')); assert(!ups[0].a.includes('--wait'));
});

test('explicit backup retains divergent commits, modified and untracked source, without stashing configuration or mounted data', async t => {
  const f=await fixture(t),files=await f.seed();
  await fs.writeFile(path.join(f.tool,'local-commit.txt'),'local commit'); f.gitRun(f.tool,'add','local-commit.txt'); f.gitRun(f.tool,'commit','-m','local commit');
  await fs.appendFile(path.join(f.tool,'README.md'),'\nlocal modification\n'); await fs.writeFile(path.join(f.tool,'untracked.txt'),'untracked source');
  const [old,target,mode]=checked(f); assert.equal(mode,'backup');
  const r=f.run(['tool-update',old,target,mode]); assert.equal(r.status,0,r.stderr); await f.protectedEqual(files);
  assert.match(f.gitRun(f.tool,'show','stash@{0}:README.md'),/local modification/);
  assert.equal(f.gitRun(f.tool,'show','stash@{0}^3:untracked.txt'),'untracked source');
  assert(!f.gitRun(f.tool,'ls-tree','-r','--name-only','stash@{0}^3').includes('data/'));
  const branches=f.gitRun(f.tool,'for-each-ref','--format=%(objectname)','refs/heads/pc-backup-*'); assert(branches.includes(old));
});

test('failed second build preserves existing containers and permits a no-new-source retry with original exit code', async t => {
  const f=await fixture(t),files=await f.seed();checked(f);
  const r=f.run(['tool-update',f.old,f.target,'standard'],{FAIL_BUILD:'service'}); assert.equal(r.status,74); assert.match(r.stderr,/synthetic build failure/);
  assert(!(await f.calls()).some(c=>c.a.includes('up'))); assert.equal(f.gitRun(f.tool,'rev-parse','HEAD'),f.target); await f.protectedEqual(files);
  const [old,target,mode]=checked(f);assert.equal(old,target);
  const retry=f.run(['tool-update',old,target,mode]);assert.equal(retry.status,0,retry.stderr);
});

test('update consent selects Start immediately; Esc cancels even with running sessions without build or interruption', async t => {
  const f=await fixture(t);await f.seed();
  const output=await f.menu(step(select(4),esc,esc));
  assert.match(output,/work-in-progress/);assert.match(output,/更新源码与运行环境/);
  assert.match(output,/\x1b\[7m开始更新/);
  assert(!f.run(['tool-plan']).stdout.includes(f.project)); assert(!output.includes('开发项目：'));
  assert(!output.includes('状态：exited')); assert(!output.includes('  取消'));
  assert.equal(f.gitRun(f.tool,'rev-parse','HEAD'),f.old);
  assert(!(await f.calls()).some(c=>c.a[0]==='build'||c.a.includes('up')||c.a[0]==='rm'));
});

test('update success and failure return to the latest menu in the same screen after the result is acknowledged', async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t), files = await f.seed(), author = path.join(f.root, 'author');
    const script = path.join(author, 'bin/pi-container');
    const source = await fs.readFile(script, 'utf8');
    assert(source.includes("choose 'Pi in Container'"));
    await fs.writeFile(script, source.replace("choose 'Pi in Container'", "choose 'Pi in Container · 最新菜单'"));
    f.gitRun(author, 'add', 'bin/pi-container'); f.gitRun(author, 'commit', '-m', 'updated menu'); f.gitRun(author, 'push', 'origin', 'main');
    const target = f.gitRun(author, 'rev-parse', 'HEAD');
    const output = await f.menu([...step(select(4), '\r'), [page, esc], ...step(esc)], fail ? { FAIL_BUILD: 'service' } : {});
    assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), target);
    assert.match(output, fail ? /操作失败.*退出码：74/ : /「更新完成」/);
    assert.match(output, /\x1b\[1mPi in Container · 最新菜单\x1b\[0m/);
    const latest = output.slice(output.lastIndexOf('\x1b[1mPi in Container · 最新菜单'));
    assert.match(latest, fail ? /\x1b\[7m接回 Pi/ : /\x1b\[7m启动 Pi/);
    assert.equal((output.match(/\x1b\[\?1049h/g) ?? []).length, 1, 'no second alternate-screen entry during menu reload');
    assert.equal((output.match(/\x1b\[\?1049l/g) ?? []).length, 1, 'the primary screen is restored only on explicit main-menu exit');
    await f.protectedEqual(files);
    assert.equal((await f.calls()).filter(c => c.a[0] === 'build').length, 2);
    if (fail) assert(!(await f.calls()).some(c => c.a.includes('up')));
  }
});

test('a same-source runtime update separates its state, question and risk and Enter starts it without arrow selection', async t => {
  const f = await fixture(t); await f.seed(); checked(f); f.gitRun(f.tool, 'merge', '--ff-only', f.target);
  const output = await f.menu([...step(select(4), '\r'), [page, esc], ...step(esc)]);
  assert.match(output, /\x1b\[5;1H\x1b\[0m状态：源码已是最新。\x1b\[K/);
  assert.match(output, /\x1b\[7;1H\x1b\[0m影响：会中断会话和应用，容器可写层丢失。\x1b\[K/);
  assert.match(output, /\x1b\[36;1H\x1b\[0m\x1b\[2m仍要更新运行环境？\x1b\[0m\x1b\[K/);
  assert.equal((await f.calls()).filter(c => c.a[0] === 'build').length, 2);
  assert.match(output, /「更新完成」/);
});

test('check failure and retry cancellation return to the main menu rather than exiting the invocation', async t => {
  const f = await fixture(t, { git: false });
  const output = await f.menu([...step(select(3)), [page, esc], ...step(esc, esc)]);
  assert.match(output, /查询失败/); assert.match(output, /检查失败，是否重新检查/);
  assert.equal((output.match(/\x1b\[1mPi in Container\x1b\[0m/g) ?? []).length, 2);
  assert(!(await f.calls()).some(c => c.a[0] === 'build' || c.a.includes('up')));
});

test('first use builds only the required missing image; opening pc is read-only and uninstall remains conditional', async t => {
  const f=await fixture(t,{git:false});assert.equal(f.run(['tool-resource-state']).stdout,'empty');
  const empty=await f.menu(step(esc));assert.doesNotMatch(empty, /(?:> |  )(?:安装|卸载)\s/);assert(!(await f.calls()).some(c=>c.a[0]==='build'||c.a.includes('up')));
  const started=f.run(['pi-start']);assert.equal(started.status,0,started.stderr);
  assert.equal(f.run(['tool-resource-state']).stdout,'present');
  let builds=(await f.calls()).filter(c=>c.a[0]==='build');assert.equal(builds.length,1);assert(!builds[0].a.includes('--file'));
  assert(builds[0].a.includes('--no-cache')&&builds[0].a.includes('--pull'));
  assert.equal(f.run(['dev-shell']).status,0);assert.equal((await f.calls()).filter(c=>c.a[0]==='build').length,1);
  for(const dir of ['services-data','.deploy-keys/installation'])await assert.rejects(fs.access(path.join(f.tool,dir)));
  const service=f.run(['service-start'],{DEPLOY_DATA_DIR:'./services-data'});assert.equal(service.status,0,service.stderr);
  builds=(await f.calls()).filter(c=>c.a[0]==='build');assert.equal(builds.length,2);assert(builds[1].a.includes('--file'));
  assert.equal(f.run(['tool-uninstall']).status,0);assert.equal(f.run(['tool-resource-state']).stdout,'empty');
  assert.equal(f.run(['dev-shell']).status,0);assert.equal((await f.calls()).filter(c=>c.a[0]==='build').length,3);
  const source=await fs.readFile(path.join(f.tool,'bin/pi-container'),'utf8');assert(!source.includes('build_menu()'));
});

test('failed first-use image builds keep existing resources and do not start the requested workload', async t => {
  for (const [action, kind] of [['pi-start', 'development'], ['service-start', 'service']]) {
    const f = await fixture(t, { git: false });
    const r = f.run([action], { DEPLOY_DATA_DIR: './services-data', FAIL_BUILD: kind });
    assert.equal(r.status, 74, r.stderr); assert.match(r.stderr, /synthetic build failure/);
    assert(!(await f.calls()).some(c => c.a.includes('up') || c.a.includes('--pic-session')));
    assert.equal((await f.state()).containers.length, 0);
    await assert.rejects(fs.access(path.join(f.tool, 'services-data')));
  }
});

test('service management prepares only its missing client image without rebuilding or restarting the existing service', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  const state = await f.state(); state.images = state.images.filter(i => i.id !== 'sha256:dev'); await f.write(state);
  const r = f.run(['service-shell']); assert.equal(r.status, 0, r.stderr);
  const calls = await f.calls(), builds = calls.filter(c => c.a[0] === 'build');
  assert.equal(builds.length, 1); assert(!builds[0].a.includes('--file'));
  assert(!calls.some(c => c.a.includes('up')));
  assert.equal((await f.state()).containers.find(c => c.id === 'service').state, 'running');
});

test('disabled or invalid dotenv never prevents stopping and removing the already-owned service', async t => {
  const f = await fixture(t, { git: false }), files = await f.seed();
  await fs.writeFile(path.join(f.tool, '.env'), 'broken configuration'); files['.env'] = 'broken configuration'; f.env.DEPLOY_DATA_DIR = '';
  const stopped = f.run(['service-stop']); assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal((await f.state()).containers.find(c => c.id === 'service').state, 'exited');
  const removed = f.run(['service-remove']); assert.equal(removed.status, 0, removed.stderr);
  assert(!(await f.state()).containers.some(c => c.id === 'service'));
  assert((await f.state()).containers.some(c => c.id === 'current'));
  await f.protectedEqual(files);
  assert(!(await f.calls()).some(c => c.a.includes('config') || c.a.includes('up') || c.a[0] === 'build'));
});

test('configuration rebuild plans are read-only and include differences, applications, SSH processes and exec connections', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  const s = await f.state(); s.containers.find(c => c.id === 'service').execs = ['deploy-exec']; await f.write(s);
  const before = await f.state(), directory = path.join(f.root, 'new service data');
  const plan = f.run(['service-config-plan'], { DEPLOY_DATA_DIR: directory, DEPLOY_PORT: '18082' });
  assert.equal(plan.status, 0, plan.stderr); assert.match(plan.stdout.split('\n')[0], /^[0-9a-f]{64}$/);
  assert.match(plan.stdout, /18080 → 127.0.0.1:18082/); assert(plan.stdout.includes(directory));
  for (const text of ['demo RUNNING', '421 deploy sshd', 'deploy-exec', '不自动迁移', '可写层', '部署脚本']) assert(plan.stdout.includes(text), text);
  assert.deepEqual(await f.state(), before); await assert.rejects(fs.access(directory));
  assert(!(await f.calls()).some(c => c.a.some(a => ['up', 'build', 'rm', 'stop', 'unpause'].includes(a))));
  const top = (await f.calls()).find(c => c.a[0] === 'top'); assert.deepEqual(top.a.slice(-2), ['-eo', 'pid,user,comm']);
});

test('config-only or disabled deployment and absent services never cause a rebuild plan or create containers', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  assert.equal(f.run(['service-config-plan']).stdout, 'none\n');
  assert.equal(f.run(['service-config-plan'], { DEPLOY_PUBLIC_URL: 'https://changed.example.com' }).stdout, 'none\n');
  assert.equal(f.run(['service-config-plan'], { DEPLOY_DATA_DIR: '' }).stdout, 'none\n');
  const s = await f.state(); s.containers = s.containers.filter(c => c.id !== 'service'); await f.write(s);
  assert.equal(f.run(['service-config-plan'], { DEPLOY_PORT: '18082' }).stdout, 'none\n');
  assert(!(await f.calls()).some(c => c.a.some(a => ['up', 'build', 'rm', 'stop', 'unpause'].includes(a))));
});

test('confirmed configuration rebuild replaces only the service, reuses its image and keeps all persistent scripts and data', async t => {
  const f = await fixture(t, { git: false }), files = await f.seed(), before = await f.state();
  const extra = { DEPLOY_PORT: '18082' }, plan = f.run(['service-config-plan'], extra); assert.equal(plan.status, 0, plan.stderr);
  const r = f.run(['service-config-apply', plan.stdout.split('\n')[0]], extra); assert.equal(r.status, 0, r.stderr);
  const after = await f.state(), service = after.containers.find(c => c.service === 'services'); assert.equal(service.state, 'running');
  assert.equal(service.data, path.join(f.tool, 'services-data')); assert.equal(service.binding, '127.0.0.1:18082');
  assert.deepEqual(after.containers.filter(c => c.service !== 'services'), before.containers.filter(c => c.service !== 'services'));
  assert.deepEqual(after.images, before.images); await f.protectedEqual(files);
  const calls = await f.calls(), ups = calls.filter(c => c.a.includes('up')); assert.equal(ups.length, 1);
  assert(ups[0].a.includes('--force-recreate') && ups[0].a.includes('--no-build') && ups[0].a.includes('--wait') && ups[0].a.includes('--no-deps'));
  assert.equal(ups[0].a[ups[0].a.indexOf('--pull') + 1], 'never');
  assert(!calls.some(c => c.a[0] === 'build' || c.a.includes('--volumes') || c.a.includes('--pic-session')));
});

test('a service configuration rebuild preserves stopped or unknown state and never starts its applications', async t => {
  for (const state of ['exited', 'created', 'paused', 'restarting', 'dead', 'unreadable']) {
    const f = await fixture(t, { git: false }); await f.seed({ serviceState: state });
    if (state === 'unreadable') { const s = await f.state(); s.containers.find(c => c.id === 'service').stateError = true; await f.write(s); }
    const extra = { DEPLOY_PORT: '18082' }, plan = f.run(['service-config-plan'], extra); assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /重建后保持停止/);
    const r = f.run(['service-config-apply', plan.stdout.split('\n')[0]], extra); assert.equal(r.status, 0, r.stderr);
    assert.equal((await f.state()).containers.find(c => c.service === 'services').state, 'created');
    const calls = await f.calls(), up = calls.find(c => c.a.includes('up')); assert(up.a.includes('--no-start')); assert(!up.a.includes('--wait') && !up.a.includes('-d'));
    assert.equal(calls.some(c => c.a[0] === 'unpause'), state === 'paused');
  }
});

test('confirmed directory changes leave old scripts and data untouched and only mount the selected new directory', async t => {
  const f = await fixture(t, { git: false }), files = await f.seed(), directory = path.join(f.root, 'empty-new-data');
  const extra = { DEPLOY_DATA_DIR: directory }, plan = f.run(['service-config-plan'], extra); assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /缺少部署脚本.*不会恢复旧应用/); await assert.rejects(fs.access(directory));
  const r = f.run(['service-config-apply', plan.stdout.split('\n')[0]], extra); assert.equal(r.status, 0, r.stderr);
  await f.protectedEqual(files); assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await f.state()).containers.find(c => c.service === 'services').data, directory);
});

test('changes after rebuild review require another confirmation before any destructive operation', async t => {
  for (const change of ['config', 'container', 'state', 'mount', 'port', 'disabled']) {
    const f = await fixture(t, { git: false }); await f.seed();
    const extra = { DEPLOY_PORT: '18082' }, plan = f.run(['service-config-plan'], extra); assert.equal(plan.status, 0, plan.stderr);
    const s = await f.state(), service = s.containers.find(c => c.id === 'service');
    if (change === 'config') await fs.appendFile(path.join(f.tool, '.env'), 'changed after review\n');
    else if (change === 'container') service.id = 'replacement';
    else if (change === 'state') service.state = 'exited';
    else if (change === 'mount') service.data = path.join(f.root, 'other-data');
    else if (change === 'port') service.binding = '127.0.0.1:18084';
    else extra.DEPLOY_DATA_DIR = '';
    await f.write(s);
    const r = f.run(['service-config-apply', plan.stdout.split('\n')[0]], extra); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /确认期间变化/);
    assert.deepEqual(await f.state(), s);
    assert(!(await f.calls()).some(c => c.a.some(a => ['up', 'build', 'rm', 'stop', 'unpause'].includes(a))));
  }
});

test('service rebuild failures keep the real exit code and saved configuration, support retry and recheck after slow preparation', async t => {
  for (const fail of ['build', 'recreate', 'changed-during-build']) {
    const f = await fixture(t, { git: false }), files = await f.seed(), extra = { DEPLOY_PORT: '18082' };
    const s = await f.state(); if (fail !== 'recreate') s.images = s.images.filter(i => i.id !== 'sha256:service'); await f.write(s);
    const plan = f.run(['service-config-plan'], extra); assert.equal(plan.status, 0, plan.stderr);
    const token = plan.stdout.split('\n')[0];
    const failure = fail === 'build' ? { FAIL_BUILD: 'service' } : fail === 'recreate' ? { FAIL_RECREATE: '1' } : { CHANGE_STATE_DURING_BUILD: '1' };
    const r = f.run(['service-config-apply', token], { ...extra, ...failure }); assert.equal(r.status, fail === 'build' ? 74 : fail === 'recreate' ? 71 : 1, r.stderr);
    assert.match(r.stderr, /重建未完成/); await f.protectedEqual(files);
    assert((await f.state()).containers.some(c => c.id === 'service'));
    if (fail !== 'recreate') assert(!(await f.calls()).some(c => c.a.includes('up')));
    else assert(!(await f.calls()).some(c => c.a[0] === 'build'));
    const retryPlan = f.run(['service-config-plan'], extra); assert.equal(retryPlan.status, 0, retryPlan.stderr);
    const retry = f.run(['service-config-apply', retryPlan.stdout.split('\n')[0]], extra); assert.equal(retry.status, 0, retry.stderr);
    const builds = (await f.calls()).filter(c => c.a[0] === 'build'); assert(builds.every(c => c.a.includes('--file') && c.a.includes('--pull') && c.a.includes('--no-cache')));
  }
});

test('unknown application or SSH activity is disclosed for consent without silently blocking an authorized rebuild', async t => {
  const f = await fixture(t, { git: false }); await f.seed();
  const s = await f.state(); Object.assign(s.containers.find(c => c.id === 'service'), { appError: true, topError: true }); await f.write(s);
  const extra = { DEPLOY_PORT: '18082' }, plan = f.run(['service-config-plan'], extra); assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /应用状态无法完整读取，状态未知/); assert.match(plan.stdout, /SSH.*状态未知/);
  const r = f.run(['service-config-apply', plan.stdout.split('\n')[0]], extra); assert.equal(r.status, 0, r.stderr);
  assert((await f.calls()).some(c => c.a.includes('--force-recreate')));
});

test('uninstall lists occupied sessions, Esc cancels, then explicit removal affects only owned resources and preserves mounts/source', async t => {
  const f=await fixture(t),files=await f.seed();
  const output=await f.menu(step(select(5),esc,esc));assert.match(output,/work-in-progress/);assert.match(output,/external-exec-id/);
  assert(!output.includes('开发项目：')); assert(!output.includes('状态：exited')); assert(!output.includes('  取消'));
  assert(!(await f.calls()).some(c=>c.a[0]==='rm'));
  // Broken dotenv must not prevent explicit removal by Docker ownership labels.
  await fs.writeFile(path.join(f.tool,'.env'),'not valid dotenv');files['.env']='not valid dotenv';
  const r=f.run(['tool-uninstall']);assert.equal(r.status,0,r.stderr);await f.protectedEqual(files);
  const s=await f.state();assert.deepEqual(s.containers.map(c=>c.id).sort(),['other-install','other-user']);assert.deepEqual(s.images.map(i=>i.id),['sha256:foreign']);assert.equal(s.networks.length,0);
  assert.equal(f.run(['tool-resource-state']).stdout,'empty');assert.equal(f.gitRun(f.tool,'rev-parse','HEAD'),f.old);
  assert(!(await f.calls()).some(c=>c.a.includes('prune')||c.a.includes('--volumes')||c.a[0]==='image'&&c.a.includes('--force')));
});

test('occupied development maintenance lists sessions and proceeds only after confirmation instead of hard refusal', async t => {
  const f=await fixture(t);await f.seed();
  const output=await f.menu([...step(select(2),select(0),select(0),select(3),'\r'), [page,esc], ...step(esc,esc,esc,esc)]);
  assert.match(output,/work-in-progress/);assert.equal((await f.state()).containers.find(c=>c.id==='current').state,'exited');
});

test('missing Git metadata and unavailable public source leave the installation untouched and expose retryable errors', async t => {
  const tar = await fixture(t, { git: false });
  const missing = tar.run(['tool-check']); assert.equal(missing.status, 1); assert.match(missing.stderr, /不是独立 Git 工作区/); assert.deepEqual(await tar.calls(), []);
  const f = await fixture(t); checked(f); await fs.rename(f.upstream, f.upstream + '.offline');
  const failed = f.run(['tool-check']); assert.notEqual(failed.status, 0); assert.equal(failed.stdout, '');
  assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), f.old); assert.deepEqual(await f.calls(), []);
});

test('Esc cancels the local source backup question without changing local commits or files', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.tool, 'README.md'), '\nlocal edit\n');
  // This installation has no live Pi; Home skips the disabled Attach row.
  const output = await f.menu(step(select(3), esc, esc));
  assert.match(output, /备份后更新/); assert.match(await fs.readFile(path.join(f.tool, 'README.md'), 'utf8'), /local edit/);
  assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), f.old); assert.deepEqual(await f.calls().then(c => c.filter(x => x.a[0] === 'build')), []);
  assert.equal(f.gitRun(f.tool, 'stash', 'list'), '');
});

test('protected upstream paths and ignored local file collisions cannot overwrite configuration or local files', async t => {
  for (const protectedPath of [true, false]) {
    const f = await fixture(t); const author = path.join(f.root, 'author');
    const filename = protectedPath ? '.env' : 'scratch.txt';
    await fs.writeFile(path.join(author, filename), 'upstream file'); f.gitRun(author, 'add', '-f', filename); f.gitRun(author, 'commit', '-m', 'new upstream file'); f.gitRun(author, 'push', 'origin', 'main');
    await fs.appendFile(path.join(f.tool, '.git/info/exclude'), '\nscratch.txt\n'); await fs.writeFile(path.join(f.tool, filename), 'protected local content');
    const [old, target, mode] = checked(f); assert.equal(mode, 'standard');
    const r = f.run(['tool-update', old, target, mode]); assert.notEqual(r.status, 0);
    assert.equal(await fs.readFile(path.join(f.tool, filename), 'utf8'), 'protected local content'); assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), old);
    assert(!(await f.calls()).some(c => c.a[0] === 'build' || c.a.includes('up')));
  }
});

test('a checkout changed after confirmation requires another check before any source or container replacement', async t => {
  const f = await fixture(t); checked(f);
  await fs.writeFile(path.join(f.tool, 'changed.txt'), 'changed by another user'); f.gitRun(f.tool, 'add', '.'); f.gitRun(f.tool, 'commit', '-m', 'concurrent source change');
  const now = f.gitRun(f.tool, 'rev-parse', 'HEAD');
  const r = f.run(['tool-update', f.old, f.target, 'standard']); assert.equal(r.status, 1); assert.match(r.stderr, /确认期间变化/);
  assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), now); assert.deepEqual(await f.calls(), []);
});

test('unknown live-session state is shown for consent, not treated as a mandatory refusal', async t => {
  const f = await fixture(t); await f.seed(); const s = await f.state(); s.containers.find(c => c.id === 'current').listError = true; await f.write(s);
  const output = await f.menu([...step(select(4), '\r'), [page, esc], ...step(esc)]);
  assert.match(output, /状态未知/); assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), f.target);
  assert((await f.calls()).some(c => c.a.includes('--force-recreate')));
});

test('uninstall confirmation includes owned service management terminals and never deletes another user’s terminal or mounted scripts', async t => {
  const f = await fixture(t), files = await f.seed(); const s = await f.state();
  for (const user of ['1000', '2000']) s.containers.push({ id: 'ssh-terminal-' + user, project: '', service: 'terminal', installation: f.installation, user, role: 'service-terminal', state: 'running', sessions: [], execs: [], image: user === '1000' ? 'sha256:dev' : 'sha256:foreign' });
  await f.write(s);
  const output = await f.menu([...step(select(5), select(0)), [page, esc], ...step(esc)]);
  assert.match(output, /服务管理终端：ssh-terminal-1000/); await f.protectedEqual(files);
  const containers = (await f.state()).containers.map(c => c.id); assert(containers.includes('ssh-terminal-2000')); assert(!containers.includes('ssh-terminal-1000'));
  const calls = await f.calls(), stop = calls.findIndex(c => c.a[0] === 'stop'), remove = calls.findIndex(c => c.a[0] === 'rm'); assert(stop >= 0 && stop < remove, 'allow graceful shutdown before container removal');
  assert.equal(f.run(['tool-resource-state']).stdout, 'empty');
});

test('shared image references are retained with their real error, without touching another user’s container', async t => {
  const f = await fixture(t); await f.seed(); const s = await f.state(); s.containers.find(c => c.id === 'other-user').image = 'sha256:dev'; await f.write(s);
  const r = f.run(['tool-uninstall']); assert.equal(r.status, 41); assert.match(r.stderr, /image still in use/);
  assert.equal((await f.state()).containers.find(c => c.id === 'other-user').state, 'running');
  assert((await f.state()).images.some(i => i.id === 'sha256:dev'));
  assert(!(await f.calls()).some(c => c.a[0] === 'image' && c.a.includes('--force')));
});

test('maintenance waits on a real host operation lock instead of racing another operation', async t => {
  const f = await fixture(t); await f.seed();
  const holder = spawn('bash', ['-c', 'exec 9>>"$1"; flock -x 9; printf ready; read -r _', '_', path.join(f.tool, '.update.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGTERM')); await new Promise(resolve => holder.stdout.once('data', resolve));
  const operation = spawn('bash', [path.join(f.tool, 'scripts/control.sh'), 'tool-uninstall'], { cwd: f.project, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => operation.kill('SIGTERM')); let output = ''; operation.stdout.on('data', d => output += d); operation.stderr.on('data', d => output += d);
  const done = new Promise(resolve => operation.once('close', code => resolve(code)));
  await new Promise(r => setTimeout(r, 150)); assert(!(await f.calls()).some(c => c.a[0] === 'rm'));
  holder.stdin.end('done\n'); assert.equal(await done, 0, output);
});

test('the idle observer never mistakes unreadable state for idle or stops a replacement container', async t => {
  const f = await fixture(t); await f.seed(); const s = await f.state(), current = s.containers.find(c => c.id === 'current'); current.execs = []; current.countError = true; await f.write(s);
  const r = f.run(['pi-connect', 'work-in-progress']); assert.equal(r.status, 0, r.stderr);
  await new Promise(r => setTimeout(r, 2300)); assert.equal((await f.state()).containers.find(c => c.id === 'current').state, 'running');
  const replaced = await f.state(), next = replaced.containers.find(c => c.id === 'current'); next.id = 'replacement'; next.countError = false; next.sessions = []; await f.write(replaced);
  const pid = path.join(f.tool, '.runtime', f.prefix + hash(f.project, 16), 'idle-current.pid'); await wait(async () => !(await fs.access(pid).then(() => true, () => false)));
  assert.equal((await f.state()).containers.find(c => c.id === 'replacement').state, 'running');
});

test('native Pi exit stops its project even when the original terminal has detached', async t => {
  const f = await fixture(t); await f.seed(); const s = await f.state(); s.containers.find(c => c.id === 'current').execs = []; await f.write(s);
  const r = f.run(['pi-connect', 'work-in-progress']); assert.equal(r.status, 0, r.stderr);
  const exited = await f.state(); exited.containers.find(c => c.id === 'current').sessions = []; await f.write(exited);
  await wait(async () => (await f.state()).containers.find(c => c.id === 'current').state === 'exited');
  assert.equal((await f.state()).containers.find(c => c.id === 'service').state, 'running');
});

test('real host flock observer waits for detached Pi, shell leases and external exec, then stops only its original project container', async t => {
  const f=await fixture(t);await f.seed();
  const s=await f.state();s.containers.find(c=>c.id==='current').execs=[];await f.write(s);
  const r=f.run(['pi-connect','work-in-progress']);assert.equal(r.status,0,r.stderr);
  const runtime=path.join(f.tool,'.runtime',f.prefix+hash(f.project,16));
  const lease=path.join(runtime,'session.external');
  const holder=spawn('bash',['-c','exec 9>>"$1"; flock -x 9; printf ready; read -r _','_',lease],{stdio:['pipe','pipe','pipe']});
  t.after(()=>holder.kill('SIGTERM'));await new Promise(resolve=>holder.stdout.once('data',resolve));
  const next=await f.state();next.containers.find(c=>c.id==='current').sessions=[];await f.write(next);
  await new Promise(r=>setTimeout(r,2300));assert.equal((await f.state()).containers.find(c=>c.id==='current').state,'running','live host Shell lease keeps container running');
  const blocked=await f.state();blocked.containers.find(c=>c.id==='current').execs=['external-exec'];await f.write(blocked);holder.stdin.end('done\n');
  await new Promise(r=>setTimeout(r,2300));assert.equal((await f.state()).containers.find(c=>c.id==='current').state,'running','external exec is not idle');
  const idle=await f.state();idle.containers.find(c=>c.id==='current').execs=[];await f.write(idle);
  await wait(async()=> (await f.state()).containers.find(c=>c.id==='current').state==='exited');
  assert.equal((await f.state()).containers.find(c=>c.id==='service').state,'running');
  assert.equal((await f.state()).containers.find(c=>c.id==='other-user').state,'running');
});
