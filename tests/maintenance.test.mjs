import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
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
 else if(t.includes('.Config.Labels'))console.log(c.project);
 else if(t.includes('.State.Running'))console.log(c.state==='running'?'true':'false');
 else if(t.includes('.State.Status'))console.log(t.includes('printf')?c.state+'\t0\t-':c.state);
 else if(t.includes('.ExecIDs')){if(t.includes('len'))console.log(c.execs.length);else console.log(c.execs.join('\n'));}
 else if(t==='{{.Image}}')console.log(c.image);
}else if(a[0]==='build'){
 if(process.env.FAIL_BUILD===(a.includes('--file')?'service':'development')){console.error('synthetic build failure');process.exit(74);}
 const tag=opt('--tag');for(const i of s.images)i.tags=i.tags.filter(t=>t!==tag);
 s.images.push({id:'sha256:build'+(++s.seq),tags:[tag],installation:process.env.INSTALL_HASH});save();
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
}else if(a[0]==='stop'){for(const c of s.containers.filter(c=>a.includes(c.id)))c.state='exited';save();}
else if(a[0]==='rm'){s.containers=s.containers.filter(c=>!a.includes(c.id));save();}
else if(a[0]==='unpause'){c.state='running';save();}
else if(a[0]==='exec'){
 if(a.includes('/usr/local/bin/pic-session')){
  if(a.at(-1)==='list'){if(c.listError){console.error('synthetic unknown sessions');process.exit(1);}for(const n of c.sessions)console.log(n+'\t0\t1700000000');}
  else if(a.at(-1)==='count'){if(c.countError)process.exit(1);console.log(c.sessions.length);}
  else if(a.includes('close')){c.sessions=c.sessions.filter(n=>n!==a.at(-1));save();}
 }else if(a.includes('supervisorctl'))console.log('demo RUNNING pid 123, uptime 1:00:00');
}else if(a[0]==='compose'){
 const project=opt('--project-name'),service=a.at(-1),list=s.containers.filter(c=>c.project===project&&c.service===service);
 if(a.includes('config'))for(const k of ['DEPLOY_DATA_DIR','DEPLOY_PORT','DEPLOY_PUBLIC_URL'])console.log(k+'='+(process.env[k]||''));
 else if(a.includes('ps')){for(const c of list)if(a.includes('-aq')||c.state==='running')console.log(c.id);}
 else if(a.includes('up')){
  if(process.env.FAIL_RECREATE){console.error('synthetic recreate failure');process.exit(71);}
  const tag=service==='pi'?process.env.PIC_IMAGE:'app-services:r'+process.env.INSTALL_HASH;
  if(a.includes('--force-recreate'))s.containers=s.containers.filter(c=>!list.includes(c));
  if(!list.length||a.includes('--force-recreate'))s.containers.push({id:'new-'+(++s.seq),repo:process.env.INSTALL_REPO,project,service,workspace:process.env.PIC_WORKSPACE,data:service==='pi'?process.env.INSTALL_REPO+'/data':process.env.DEPLOY_DATA_DIR,state:a.includes('--no-start')?'created':'running',sessions:[],execs:[],image:s.images.find(i=>i.tags.includes(tag)).id});
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
    const proc = pty.spawn('bash', [path.join(tool, 'bin/pi-container')], { cwd: project, env: { ...env, ...extra }, cols: 160, rows: 38 });
    let output = '', pending = '', index = 0;
    const timer = setTimeout(() => proc.kill('SIGTERM'), 16000);
    const exited = new Promise(resolve => proc.onExit(resolve));
    proc.onData(data => {
      output += data; pending += data;
      while (index < steps.length) {
        const [text, keys] = steps[index], at = pending.indexOf(text);
        if (at < 0) break;
        pending = pending.slice(at + text.length); index++; proc.write(keys);
      }
    });
    const result = await exited; clearTimeout(timer);
    assert.equal(index, steps.length, output); assert.equal(result.exitCode, 0, output); return output;
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

test('update consent defaults to cancel even with running sessions; no build or interruption on cancellation', async t => {
  const f=await fixture(t);await f.seed();
  const output=await f.menu(step(select(5),'\r',esc));
  assert.match(output,/work-in-progress/);assert.match(output,/更新版本并重建全部镜像和容器/);
  assert.equal(f.gitRun(f.tool,'rev-parse','HEAD'),f.old);
  assert(!(await f.calls()).some(c=>c.a[0]==='build'||c.a.includes('up')||c.a[0]==='rm'));
});

test('one install/uninstall button follows actual resource state and installation never requires manual image forms', async t => {
  const f=await fixture(t,{git:false});assert.equal(f.run(['tool-install-state']).stdout,'install');
  const cancelled=await f.menu(step(select(6),'\r',esc));assert.match(cancelled,/安装/);assert(!(await f.calls()).some(c=>c.a[0]==='build'));
  await f.menu([...step(select(6),select(1)),[page,esc],...step(esc)]);
  assert.equal(f.run(['tool-install-state']).stdout,'uninstall');assert.equal((await f.state()).containers.length,0);
  const builds=(await f.calls()).filter(c=>c.a[0]==='build');assert.equal(builds.length,2);assert(builds.every(c=>c.a.includes('--no-cache')&&c.a.includes('--pull')));
  const source=await fs.readFile(path.join(f.tool,'bin/pi-container'),'utf8');assert(!source.includes('build_menu()'));
});

test('uninstall lists occupied sessions, defaults to cancel, then removes only owned containers/images/networks while preserving mounts and source', async t => {
  const f=await fixture(t),files=await f.seed();
  const output=await f.menu(step(select(6),'\r',esc));assert.match(output,/work-in-progress/);assert.match(output,/external-exec-id/);
  assert(!(await f.calls()).some(c=>c.a[0]==='rm'));
  // Broken dotenv must not prevent explicit removal by Docker ownership labels.
  await fs.writeFile(path.join(f.tool,'.env'),'not valid dotenv');files['.env']='not valid dotenv';
  const r=f.run(['tool-uninstall']);assert.equal(r.status,0,r.stderr);await f.protectedEqual(files);
  const s=await f.state();assert.deepEqual(s.containers.map(c=>c.id).sort(),['other-install','other-user']);assert.deepEqual(s.images.map(i=>i.id),['sha256:foreign']);assert.equal(s.networks.length,0);
  assert.equal(f.run(['tool-install-state']).stdout,'install');assert.equal(f.gitRun(f.tool,'rev-parse','HEAD'),f.old);
  assert(!(await f.calls()).some(c=>c.a.includes('prune')||c.a.includes('--volumes')||c.a[0]==='image'&&c.a.includes('--force')));
});

test('occupied development maintenance lists sessions and proceeds only after confirmation instead of hard refusal', async t => {
  const f=await fixture(t);await f.seed();
  const output=await f.menu(step(select(3),select(3),select(1),esc,esc));
  assert.match(output,/work-in-progress/);assert.equal((await f.state()).containers.find(c=>c.id==='current').state,'exited');
});

test('missing Git metadata and unavailable public source leave the installation untouched and expose retryable errors', async t => {
  const tar = await fixture(t, { git: false });
  const missing = tar.run(['tool-check']); assert.equal(missing.status, 1); assert.match(missing.stderr, /不是独立 Git 工作区/); assert.deepEqual(await tar.calls(), []);
  const f = await fixture(t); checked(f); await fs.rename(f.upstream, f.upstream + '.offline');
  const failed = f.run(['tool-check']); assert.notEqual(failed.status, 0); assert.equal(failed.stdout, '');
  assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), f.old); assert.deepEqual(await f.calls(), []);
});

test('local source backup question defaults to cancel without changing local commits or files', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.tool, 'README.md'), '\nlocal edit\n');
  const output = await f.menu(step(select(5), '\r', esc));
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
  const output = await f.menu([...step(select(5), select(1)), [page, esc]]);
  assert.match(output, /状态未知/); assert.equal(f.gitRun(f.tool, 'rev-parse', 'HEAD'), f.target);
  assert((await f.calls()).some(c => c.a.includes('--force-recreate')));
});

test('uninstall confirmation includes owned service management terminals and never deletes another user’s terminal or mounted scripts', async t => {
  const f = await fixture(t), files = await f.seed(); const s = await f.state();
  for (const user of ['1000', '2000']) s.containers.push({ id: 'ssh-terminal-' + user, project: '', service: 'terminal', installation: f.installation, user, role: 'service-terminal', state: 'running', sessions: [], execs: [], image: user === '1000' ? 'sha256:dev' : 'sha256:foreign' });
  await f.write(s);
  const output = await f.menu([...step(select(6), select(1)), [page, esc], ...step(esc)]);
  assert.match(output, /服务管理终端：ssh-terminal-1000/); await f.protectedEqual(files);
  const containers = (await f.state()).containers.map(c => c.id); assert(containers.includes('ssh-terminal-2000')); assert(!containers.includes('ssh-terminal-1000'));
  const calls = await f.calls(), stop = calls.findIndex(c => c.a[0] === 'stop'), remove = calls.findIndex(c => c.a[0] === 'rm'); assert(stop >= 0 && stop < remove, 'allow graceful shutdown before container removal');
  assert.equal(f.run(['tool-install-state']).stdout, 'install');
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

test('explicitly ending the last Pi stops its project even when no original terminal remains', async t => {
  const f = await fixture(t); await f.seed(); const s = await f.state(); s.containers.find(c => c.id === 'current').execs = []; await f.write(s);
  const r = f.run(['pi-end', 'work-in-progress']); assert.equal(r.status, 0, r.stderr);
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
