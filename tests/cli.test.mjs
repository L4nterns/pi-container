import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pty } from "./helpers/pty.mjs";
const down = "\x1b[B", esc = "\x1b", home = "\x1b[H";
const select = index => home + down.repeat(index) + "\r";
const exitMenu = esc;
const menuHint = "「↑/↓」选择 · 「Enter」确认";
const menus = (...inputs) => inputs.map(keys => [menuHint, keys]);
const mutations = calls => calls.filter(c => c.args.some(a => ['up', 'build', 'stop', 'down', 'rm', 'prune', '--pic-session', 'close'].includes(a)));
const pause = ['「PgUp/PgDn」翻页', esc];
const repo = fileURLToPath(new URL("..", import.meta.url));
const hostKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICZbxB6rD5TGtb2T/JKn4uf6eoWr5j2WT6eOo+CFc4JI";
const keygen = process.env.TEST_SSH_KEYGEN_BINARY || "/usr/bin/ssh-keygen";
const hasKeygen = await fs.access(keygen).then(
  () => true,
  () => false,
);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pic-command-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, "tool"),
    project = path.join(root, "project with spaces"),
    fakeBin = path.join(root, "fake-bin"),
    log = path.join(root, "docker.jsonl");
  for (const d of ["bin", "lib", "scripts"])
    await fs.mkdir(path.join(tool, d), { recursive: true });
  for (const d of [project, fakeBin, path.join(tool, ".deploy-keys")]) await fs.mkdir(d);
  for (const f of [
    "bin/pi-container",
    "scripts/control.sh",
    "lib/menu.sh",
    "lib/session-lifecycle.sh",
    "lib/deployment.sh",
    "lib/deployment-settings.sh",
    "lib/update.sh",
    "lib/idle.sh",
    "lib/projects.sh",
    "compose.yaml",
    "compose.deploy.yaml",
    "compose.services.yaml",
    ".env.example",
  ])
    await fs.copyFile(path.join(repo, f), path.join(tool, f));
  await fs.symlink('pi-container', path.join(tool, 'bin/pc'));
  await fs.writeFile(
    path.join(fakeBin, "id"),
    '#!/bin/sh\ncase "$1" in -u) echo "${FAKE_UID:-1000}";; -g) echo "${FAKE_GID:-1000}";; -G) echo "${FAKE_GROUPS:-1000}";; esac\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(fakeBin, "ssh-keygen"),
    `#!/bin/sh\nif [ "$1" = '-l' ]; then ${hasKeygen ? `exec '${keygen}' "$@"` : `grep -Fq '${hostKey}' "$3"`}; fi\nwhile [ "$1" != '-f' ]; do shift; done\nprintf test-key > "$2"; printf '%s\\n' '${hostKey}' > "$2.pub"\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(fakeBin, "docker"),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const opt=k=>args[args.indexOf(k)+1], dotenv={};
if(args.includes('--env-file'))for(const line of fs.readFileSync(opt('--env-file'),'utf8').split(/\\r?\\n/)){
 const m=/^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)$/.exec(line);if(!m)continue;
 let value=m[2];if(value.startsWith("'"))value=value.slice(1,-1).replaceAll("\\\\'", "'");else if(value.startsWith('"'))value=value.slice(1,-1);else value=value.replace(/\\s+#.*$/,'').trimEnd();dotenv[m[1]]=value;
}
const setting=k=>process.env[k]??dotenv[k]??'', serviceState=process.env.FAKE_SERVICE_FLAG?(fs.existsSync(process.env.FAKE_SERVICE_FLAG)?'running':'exited'):process.env.FAKE_SERVICE_STATE||process.env.FAKE_CONTAINER_STATE||'running';
const managed=JSON.parse(process.env.FAKE_MANAGED_FILE?fs.readFileSync(process.env.FAKE_MANAGED_FILE,'utf8'):process.env.FAKE_MANAGED_CONTAINERS||'[]'), selected=managed.find(c=>args.includes(c.id)),isService=args.includes('fake-service');
const currentName='pic-r'+process.env.PIC_IMAGE.split(':r')[1]+'-u'+(process.env.FAKE_UID||'1000')+'-'+require('node:crypto').createHash('sha256').update(process.env.PIC_WORKSPACE).digest('hex').slice(0,16);
const projectName=args.includes('--project-name')?args[args.indexOf('--project-name')+1]:undefined, projectContainer=managed.find(c=>c.project===projectName);
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({args,workspace:process.env.PIC_WORKSPACE,uid:process.env.PIC_UID,gid:process.env.PIC_GID,groups:process.env.PIC_GROUPS,history:process.env.PIC_HISTORY_DIR,image:process.env.PIC_IMAGE,deployData:process.env.DEPLOY_DATA_DIR})+'\\n');
if(args[0]==='image'){if(args.includes('inspect'))console.log(process.env.FAKE_BUILT_IMAGE||'sha256:built');}
else if(args[0]==='inspect'&&args.some(a=>a.includes('.State.Status'))){const state=selected?.state||(isService?serviceState:process.env.FAKE_CONTAINER_STATE)||'running';console.log(args.includes('{{.State.Status}}')?state:state+'\\t'+(process.env.FAKE_CONTAINER_EXIT||'0')+'\\t-');}
else if(args[0]==='inspect'&&args.some(a=>a.includes('.Mounts'))){const dest=/eq .Destination "([^"]+)"/.exec(opt('--format'))?.[1];console.log(isService?(process.env.FAKE_SERVICE_DATA||path.resolve(process.env.FAKE_TOOL,process.env.DEPLOY_DATA_DIR||'services-data')):dest==='/home/node/.pi/agent'?selected?.data||path.join(process.env.FAKE_TOOL,'data'):dest==='/run/deploy-credentials'?selected?.credentials||'':selected?.directory||process.env.PIC_WORKSPACE);}
else if(args[0]==='inspect'&&args.some(a=>a.includes('.HostConfig.PortBindings')))console.log(process.env.FAKE_SERVICE_BINDING_FILE?fs.readFileSync(process.env.FAKE_SERVICE_BINDING_FILE,'utf8'):process.env.FAKE_SERVICE_BINDING||'127.0.0.1:'+(process.env.DEPLOY_PORT||'18080'));
else if(args[0]==='inspect'&&args.some(a=>a.includes('.Config.Labels'))){if(opt('--format').includes('working_dir'))console.log((selected?.workingDir||process.env.FAKE_TOOL)+'\\t'+(selected?.project||currentName)+'\\t'+(selected?.service||'pi'));else console.log(selected?.project||currentName);}
else if(args[0]==='inspect'&&args.includes('{{.Image}}'))console.log(process.env.FAKE_CURRENT_IMAGE||'sha256:built');
else if(args[0]==='inspect'&&args.some(a=>a.includes('.HostConfig.RestartPolicy.Name')))console.log('当前实际重启策略：unless-stopped');
else if(args.includes('pi')&&args.at(-1)==='--version')console.log('1.5.0');
else if(args.includes('rev-parse'))console.log('synthetic-gateway-commit');
else if(args[0]==='inspect'&&args.includes('{{.State.Running}}'))process.exitCode=1;
else if(args.includes('config')&&args.includes('--environment')){if(process.env.FAKE_EDIT_CONFIG&&opt('--env-file').includes('.env.pc-'))fs.appendFileSync(process.env.FAKE_EDIT_CONFIG,'CONCURRENT_EDIT=keep\\n');if(process.env.FAKE_CONFIG_ERROR)process.exitCode=72;else if(process.env.TEST_COMPOSE_BINARY){const r=require('node:child_process').spawnSync(process.env.TEST_COMPOSE_BINARY,args.slice(1),{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;}else for(const k of['DEPLOY_DATA_DIR','DEPLOY_PUBLIC_URL','DEPLOY_PORT'])console.log(k+'='+setting(k));}
else if(args.includes('/usr/local/bin/deploy-apps')){if(process.env.FAKE_APP_ERROR)process.exitCode=75;else if(args.at(-1)==='list')process.stdout.write(process.env.FAKE_APPS||'');}
else if(args.includes('/usr/local/bin/deploy-register')){if(process.env.FAKE_REGISTER_EXIT){console.log(${JSON.stringify(hostKey)});console.error('synthetic registration failure');process.exitCode=Number(process.env.FAKE_REGISTER_EXIT);}else console.log(process.env.FAKE_HOST_KEY||${JSON.stringify(hostKey)});}
else if(args.includes('build'))process.exitCode=Number(process.env.FAKE_BUILD_EXIT||0);
else if(args.includes('up')){if(process.env.FAKE_SLOW_UP){console.log('OPERATION-PID:'+process.pid);require('node:child_process').spawn('sleep',['30'],{stdio:'ignore'});setInterval(()=>{},1000);}else{if(!process.env.FAKE_UP_EXIT){if(process.env.FAKE_SERVICE_FLAG&&args.at(-1)==='services')fs.writeFileSync(process.env.FAKE_SERVICE_FLAG,'running');if(process.env.FAKE_SERVICE_BINDING_FILE&&args.includes('--force-recreate'))fs.writeFileSync(process.env.FAKE_SERVICE_BINDING_FILE,'127.0.0.1:'+setting('DEPLOY_PORT'));}process.exitCode=Number(process.env.FAKE_UP_EXIT||0);}}
else if(args.includes('stat')&&args.includes('-Lc')){const s=fs.statSync(selected?.directory||process.env.PIC_WORKSPACE);console.log(process.env.FAKE_STAT_MISMATCH||s.dev+':'+s.ino);}
else if(args.includes('/usr/local/bin/pic-workspace-init'))process.exitCode=Number(process.env.FAKE_WORKSPACE_EXIT||0);
else if(args.includes('/usr/local/bin/pic-session')&&args.at(-1)==='count'){if(selected?.countError||process.env.FAKE_COUNT_ERROR)process.exitCode=1;else console.log(selected?.live??(process.env.FAKE_LIVE_PI_FILE?fs.readFileSync(process.env.FAKE_LIVE_PI_FILE,'utf8').trim():process.env.FAKE_LIVE_PI??(process.env.FAKE_RUNNING||'').split('\\n').filter(Boolean).length));}
else if(args.includes('/usr/local/bin/pic-session')&&args.at(-1)==='list'){if(process.env.FAKE_LIST_ERROR)process.exitCode=1;else process.stdout.write(process.env.FAKE_RUNNING||'');}
else if(args.includes('logs'))console.log(process.env.FAKE_LOG_OUTPUT||'startup ready\\napplication error: synthetic diagnostic');
else if(args[0]==='ps'&&args.some(a=>a.startsWith('label=io.pi-container.'))){}
else if(args[0]==='ps'&&args.includes('label=com.docker.compose.service=services')){if(process.env.FAKE_PS_ERROR)process.exitCode=73;else if(process.env.FAKE_SERVICE_PRESENT==='1'||process.env.DEPLOY_DATA_DIR&&process.env.FAKE_SERVICE_MISSING!=='1'&&process.env.FAKE_NO_CONTAINER!=='1')console.log('fake-service');}
else if(args[0]==='ps'&&args.includes('-aq')){if(process.env.FAKE_MANAGED_ERROR)process.exitCode=73;else{for(const c of managed){if((!c.workingDir||args.includes('label=com.docker.compose.project.working_dir='+c.workingDir))&&(!c.service||args.includes('label=com.docker.compose.service='+c.service)))console.log(c.id);}if(!managed.length&&process.env.FAKE_NO_CONTAINER!=='1'&&(process.env.FAKE_MANAGED||process.env.FAKE_CURRENT_MANAGED))console.log('fake-container');}}
else if(args.includes('ps')&&!args.includes('-q')&&!args.includes('-aq'))console.log('SERVICE  STATE    STATUS\\n'+(args.includes('services')?'services':'pi')+'       running  Up');
else if(args.includes('ps')&&(args.includes('-q')||args.includes('-aq'))){if(process.env.FAKE_PS_ERROR)process.exitCode=73;else if(args.at(-1)==='services'&&process.env.FAKE_SERVICE_MISSING==='1'){}else if(projectContainer){if(!args.includes('-q')||projectContainer.state!=='exited')console.log(projectContainer.id);}else if(process.env.FAKE_NO_CONTAINER!=='1'&&(!args.includes('-q')||process.env.FAKE_CONTAINER_STATE!=='exited'))console.log('fake-container');}
else if(args[0]==='top'){if(process.env.FAKE_TOP_ERROR)process.exitCode=76;else console.log('PID USER COMMAND\\n421 deploy sshd');}
else if(args.includes('supervisorctl')){if(process.env.FAKE_SUPERVISOR_ERROR)process.exitCode=77;else console.log('demo RUNNING pid 123, uptime 1:00:00');}
else if(args[0]==='inspect'&&args.some(a=>a.includes('range .ExecIDs')))console.log(process.env.FAKE_SERVICE_EXECS||'');
else if(args[0]==='inspect')console.log(selected?.execs??process.env.FAKE_EXECS??'0');
else if(process.env.FAKE_INTERACTIVE==='1'&&(args[0]==='run'||args.includes('--dev-shell')||args.includes('--pic-session')||args.includes('attach'))){console.log('SHELL-READY');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line==='exit')process.exit(0);});}
else if(args[0]==='run')process.exitCode=Number(process.env.FAKE_RUN_EXIT||0);
else if(args.includes('exec'))process.exitCode=Number(process.env.FAKE_EXIT||0);
`,
    { mode: 0o755 },
  );
  const environment = (env = {}) => ({
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TERM: "xterm-256color",
    FAKE_LOG: log,
    FAKE_TOOL: tool,
    DEPLOY_DATA_DIR: "",
    DEPLOY_PUBLIC_URL: "",
    DEPLOY_PORT: "18080",
    ...env,
  });
  async function calls() {
    const out = (await fs.readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    await fs.writeFile(log, "");
    return out;
  }
  async function run(args, env = {}, cwd = project) {
    const r = spawnSync(
      "bash",
      [path.join(tool, "scripts/control.sh"), ...args],
      { cwd, encoding: "utf8", env: environment(env), timeout: 10000 },
    );
    return { ...r, calls: await calls() };
  }
  async function publicRun(args = [], env = {}) {
    const r = spawnSync("bash", [path.join(tool, "bin/pi-container"), ...args], {
      cwd: project,
      encoding: "utf8",
      env: environment(env),
      timeout: 10000,
    });
    return { ...r, calls: await calls() };
  }
  async function menu(steps, env = {}) {
    const proc = pty.spawn("/bin/bash", [path.join(tool, "bin/pi-container")], {
      cwd: project,
      // General navigation scenarios have a live Pi; empty/unknown-state tests
      // explicitly override it and exercise the resulting disabled first row.
      env: environment({ FAKE_RUNNING: 'main\t0\t1700000000\n', FAKE_CURRENT_MANAGED: '1', ...env }),
      cols: 110,
      rows: 35,
    });
    let output = "", position = 0, timedOut = false, ended = false;
    proc.onData(d => output += d);
    const exit = new Promise(resolve => proc.onExit(result => { ended = true; resolve(result); }));
    const timeout = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, 10000);
    try {
      for (const [text, keys] of steps) {
        const ready = () => {
          const outputSinceInput = output.slice(position);
          const screenPrompt = text === menuHint || text === pause[0] || text.startsWith('「Enter」');
          const start = screenPrompt ? outputSinceInput.lastIndexOf('\x1b[?25l\x1b[?2004h') : 0;
          return start >= 0 && outputSinceInput.slice(start).includes(text);
        };
        for (let i = 0; i < 400 && !ready() && !ended; i++)
          await new Promise(r => setTimeout(r, 15));
        assert(ready(), `missing prompt: ${text}\n${output}`);
        position = output.length;
        proc.write(typeof keys === 'function' ? await keys() : keys);
      }
      const result = await exit;
      assert(!timedOut, `menu must exit itself, not pass after the watchdog kills it:\n${output}`);
      return { ...result, output, calls: await calls() };
    } finally {
      clearTimeout(timeout);
      if (!ended) proc.kill("SIGTERM");
    }
  }
  return { root, tool, project, fakeBin, environment, calls, run, publicRun, menu };
}
function managedContainers(f) {
  const hash = createHash('sha256').update(f.tool).digest('hex').slice(0, 8);
  const prefix = `pic-r${hash}-u1000-`;
  return [
    { id: 'idle-container', project: prefix + '1'.repeat(16), directory: path.join(f.root, 'idle project'), state: 'exited' },
    { id: 'busy-container', project: prefix + '0'.repeat(16), directory: path.join(f.root, 'busy project'), state: 'running' },
  ];
}
test('all development containers are listed by host path within this installation and user, without initialization', async t => {
  const f = await fixture(t), own = managedContainers(f);
  const foreign = [
    { id: 'other-user', project: own[0].project.replace('-u1000-', '-u2000-') },
    { id: 'other-install', project: 'pic-rffffffff-u1000-' + '2'.repeat(16), workingDir: path.join(f.root, 'other installation') },
    { id: 'service-container', project: own[0].project, service: 'services' },
    { id: 'unrecognized', project: 'unrelated-project' },
  ];
  await fs.writeFile(path.join(f.tool, '.env'), 'invalid deployment configuration');
  const r = await f.run(['dev-list'], { FAKE_MANAGED_CONTAINERS: JSON.stringify([...own, ...foreign]), FAKE_CONFIG_ERROR: '1' });
  assert.equal(r.status, 0, r.stderr);
  for (const c of own) assert(r.stdout.includes(c.directory));
  assert.match(r.stdout, /已停止（退出码 0）/); assert.match(r.stdout, /运行中/);
  assert.doesNotMatch(r.stdout, /pic-r|container|other-user|unrecognized|sha256:|\{"/);
  const enumeration = r.calls.find(c => c.args[0] === 'ps');
  assert(enumeration.args.includes(`label=com.docker.compose.project.working_dir=${f.tool}`));
  assert(enumeration.args.includes('label=com.docker.compose.service=pi'));
  const queried = r.calls.filter(c => c.args[0] === 'compose').map(c => c.args[c.args.indexOf('--project-name') + 1]);
  assert.deepEqual([...new Set(queried)].sort(), own.map(c => c.project).sort());
  assert(!r.calls.some(c => c.args.some(a => ['up', 'build', 'exec', 'config', 'down', 'prune', 'install', 'update'].includes(a))));
  for (const dir of ['.runtime', 'data', 'services-data']) await assert.rejects(fs.access(path.join(f.tool, dir)), { code: 'ENOENT' });
});

test('batch development cleanup continues past busy or unknown state and removes only idle managed projects', async t => {
  const f = await fixture(t);
  for (const condition of [{ live: '1' }, { execs: '2' }, { countError: true }, { live: 'unknown' }]) {
    const [idle, busy] = managedContainers(f); Object.assign(busy, condition);
    const foreign = { id: 'other-user', project: idle.project.replace('-u1000-', '-u2000-') };
    const r = await f.run(['dev-remove-all'], { FAKE_MANAGED_CONTAINERS: JSON.stringify([idle, busy, foreign]) });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /清理未完成.*已删除 1 个.*未完成 1 个/);
    const removed = r.calls.filter(c => c.args.includes('down'));
    assert.equal(removed.length, 1);
    assert.equal(removed[0].args[removed[0].args.indexOf('--project-name') + 1], idle.project);
    assert(removed[0].args.includes('--remove-orphans'));
    assert(r.stdout.includes(idle.directory) && r.stdout.includes(busy.directory));
    assert(!r.calls.some(c => c.args.some(a => ['up', 'build', 'stop', 'prune', '--volumes', 'install', 'update'].includes(a))));
    await assert.rejects(fs.access(path.join(f.tool, 'services-data')), { code: 'ENOENT' });
  }
  const allIdle = managedContainers(f).map(c => ({ ...c, state: 'exited' }));
  const all = await f.run(['dev-remove-all'], { FAKE_MANAGED_CONTAINERS: JSON.stringify(allIdle) });
  assert.equal(all.status, 0, all.stderr); assert.match(all.stdout, /清理完成.*已删除 2 个开发容器/);
  assert.deepEqual(all.calls.filter(c => c.args.includes('down')).map(c => c.args[c.args.indexOf('--project-name') + 1]).sort(), allIdle.map(c => c.project).sort());
  for (const action of ['dev-list', 'dev-remove-all']) {
    const empty = await f.run([action]);
    assert.equal(empty.status, 0, empty.stderr); assert.match(empty.stdout, /暂无开发容器/);
    assert.equal(empty.calls.length, 1);
    const failed = await f.run([action], { FAKE_MANAGED_ERROR: '1' });
    assert.equal(failed.status, 73);
    assert(!failed.calls.some(c => c.args.includes('down')));
  }
});

test('batch development cleanup respects a real host terminal lease', async t => {
  const f = await fixture(t), [idle] = managedContainers(f);
  const runtime = path.join(f.tool, '.runtime', idle.project); await fs.mkdir(runtime, { recursive: true });
  const lease = path.join(runtime, 'session.test');
  const holder = spawn('flock', ['-x', lease, 'bash', '-c', 'printf ready; read -r _'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => new Promise(resolve => { if (holder.exitCode !== null) resolve(); else { holder.once('exit', resolve); holder.stdin.end(); } }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lease holder was not ready')), 2000);
    holder.once('error', error => { clearTimeout(timer); reject(error); });
    holder.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  const r = await f.run(['dev-remove-all'], { FAKE_MANAGED_CONTAINERS: JSON.stringify([idle]) });
  assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /活动终端连接/);
  assert(!r.calls.some(c => c.args.includes('down')));
});

test('development bulk maintenance selects idle cleanup first and Esc cancels without mutations', async t => {
  const f = await fixture(t), env = { FAKE_MANAGED: '1', FAKE_RUNNING: '' };
  // No Pi is running: Attach is disabled, so Home starts at Start Pi.
  const listed = await f.menu(menus(select(1), select(0), esc, esc, esc), env);
  assert.equal(listed.exitCode, 0, listed.output);
  assert(listed.output.includes(f.project)); assert.match(listed.output, /选择项目/);
  assert(!listed.calls.some(c => c.args.includes('down')));
  const cancelled = await f.menu(menus(select(1), select(1), esc, esc, esc), env);
  assert.equal(cancelled.exitCode, 0, cancelled.output); assert.deepEqual(mutations(cancelled.calls), []);
  assert.match(cancelled.output, /中断后清理全部/);
  const confirmed = await f.menu([...menus(select(1), select(1), '\r'), pause, ...menus(esc, esc)], env);
  assert.equal(confirmed.exitCode, 0, confirmed.output);
  assert.equal(confirmed.calls.filter(c => c.args.includes('down')).length, 1);
});

test('an uncreated current project is explicit, disables logs/stop/delete and cancelling does not initialize resources', async t => {
  const f = await fixture(t);
  const r = await f.menu(menus(select(1), select(0), select(0), esc, esc, esc, esc), { FAKE_NO_CONTAINER: '1', FAKE_RUNNING: '' });
  assert.equal(r.exitCode, 0, r.output); assert.match(r.output, /未创建/);
  for (const label of ['查看日志', '停止容器', '删除容器']) assert(r.output.includes(`\x1b[2m${label}`));
  assert.deepEqual(mutations(r.calls), []);
  for (const dir of ['.runtime', 'data', 'services-data']) await assert.rejects(fs.access(path.join(f.tool, dir)));
});

test('missing and stopped services report no action, not a successful stop/delete, and preserve resources', async t => {
  const f = await fixture(t);
  for (const [index, env] of [[4, { FAKE_SERVICE_MISSING: '1' }], [5, { FAKE_SERVICE_MISSING: '1' }], [4, { FAKE_SERVICE_STATE: 'exited' }]]) {
    const r = await f.menu([...menus(select(3), select(index), '\r'), pause, ...menus(esc, esc)], { DEPLOY_DATA_DIR: './services-data', ...env });
    assert.equal(r.exitCode, 0, r.output); assert.match(r.output, /无需操作/); assert.match(r.output, /操作结果/);
    assert.doesNotMatch(r.output, /已完成.*(?:停止|删除)容器/);
    assert(!r.calls.some(c => ['stop', 'rm'].includes(c.args[0])));
  }
});

test('app confirmation displays the application, current state and explicit enable target as well as disable', async t => {
  const f = await fixture(t), revision = 'a'.repeat(64);
  const r = await f.menu(menus(select(3), select(6), select(0), select(0), esc, esc, esc, esc), { DEPLOY_DATA_DIR: './services-data', FAKE_APPS: `demo\tfalse\t${revision}\n` });
  assert.equal(r.exitCode, 0, r.output); assert.match(r.output, /应用自启动 · demo/);
  assert.match(r.output, /当前：已禁用/); assert.match(r.output, /修改为：启用自启动/); assert.match(r.output, /确认启用/);
  assert(!r.calls.some(c => c.args.includes('set')));
});

test("pc and pi-container share menu-only help and reject subcommands without Docker side effects", async (t) => {
  const f = await fixture(t);
  const help = await f.publicRun(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法：pc 或 pi-container/);
  assert.match(help.stdout, /启动 Pi.*断开终端后继续运行/);
  assert.doesNotMatch(help.stdout, /恢复历史对话|开始新对话|用法：pic|pi-container attach/);
  assert.deepEqual(help.calls, []);
  const shortHelp = await f.publicRun(["-h"]);
  assert.equal(shortHelp.status, 0);
  assert.equal(shortHelp.stdout, help.stdout);
  assert.deepEqual(shortHelp.calls, []);
  for (const args of [
    [],
    ["new"],
    ["sessions"],
    ["attach", "main"],
    ["web", "start"],
    ["services", "up"],
    ["shell"],
  ]) {
    const r = await f.publicRun(args);
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
  }
  assert.deepEqual(await fs.readdir(path.join(repo, "bin")), ["pc", "pi-container"]);
  assert.equal(await fs.readlink(path.join(repo, 'bin/pc')), 'pi-container');
  await assert.rejects(fs.access(path.join(repo, "bin/pic")));
  await assert.rejects(fs.access(path.join(repo, "bin/devctl")));
  await assert.rejects(fs.access(path.join(repo, "dev-entrypoint.sh")));
  for (const file of [
    "Dockerfile",
    "compose.yaml",
    "scripts/control.sh",
    "pic-entrypoint.sh",
    "scripts/bootstrap-pi.mjs",
  ])
    assert.doesNotMatch(
      await fs.readFile(path.join(repo, file), "utf8"),
      /DEVCTL_|DEV_(UID|GID|GROUPS|IMAGE|WORKSPACE|SESSION_DIR)|\/opt\/devctl|\.devctl-/,
    );
});
test("installed pc and pi-container links coexist with system groff pic", async (t) => {
  const f = await fixture(t);
  const groff = path.join(f.fakeBin, "pic"), installed = path.join(f.fakeBin, "pi-container");
  const original = '#!/bin/sh\nprintf "groff-pic-sentinel\\n"\n';
  await fs.writeFile(groff, original, { mode: 0o755 });
  const originalMode = (await fs.stat(groff)).mode & 0o777;
  await fs.symlink(path.join(f.tool, "bin/pi-container"), installed);
  await fs.symlink(path.join(f.tool, 'bin/pc'), path.join(f.fakeBin, 'pc'));
  const env = f.environment();
  const system = spawnSync("pic", ["--version"], { cwd: f.project, env, encoding: "utf8", timeout: 5000 });
  assert.equal(system.status, 0, system.stderr);
  assert.equal(system.stdout, "groff-pic-sentinel\n");
  const help = spawnSync("pi-container", ["--help"], { cwd: f.project, env, encoding: "utf8", timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法：pc 或 pi-container/);
  const short = spawnSync('pc', ['--help'], { cwd: f.project, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(short.status, 0, short.stderr); assert.equal(short.stdout, help.stdout);
  const piped = spawnSync("pi-container", [], { cwd: f.project, env, input: "0\n", encoding: "utf8", timeout: 5000 });
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /pc \/ pi-container 需要交互终端/);
  const proc = pty.spawn("pc", [], { cwd: f.project, env, cols: 110, rows: 35 });
  const exit = new Promise(resolve => proc.onExit(resolve));
  const timeout = setTimeout(() => proc.kill("SIGTERM"), 8000);
  t.after(() => clearTimeout(timeout));
  let output = "", sent = false;
  proc.onData(data => {
    output += data;
    if (!sent && output.includes(menuHint)) { sent = true; proc.write(exitMenu); }
  });
  const result = await exit;
  clearTimeout(timeout);
  assert.equal(result.exitCode, 0, output);
  assert.match(output, /接回 Pi/);
  assert(!output.includes("groff-pic-sentinel"));
  assert.equal(await fs.readFile(groff, "utf8"), original);
  assert.equal((await fs.stat(groff)).mode & 0o777, originalMode);
  assert.deepEqual(mutations(await f.calls()), []);
});
test("pi-container menu owns hosted processes, not native Pi conversation commands", async (t) => {
  const f = await fixture(t);
  const r = await f.menu(menus("8" + exitMenu));
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.output, /Web|浏览器|18090|恢复历史对话|开始新对话/);
  assert.match(r.output, /「Esc」退出.*「↑\/↓」选择.*「Enter」确认/);
  assert.doesNotMatch(r.output, /退出菜单|开发终端|项目容器|返回\s{2,}/);
  assert.doesNotMatch(r.output, /\d\) |请选择菜单中的编号/);
  assert.match(r.output, /接回 Pi.*继续原进程/);
  assert.match(r.output, /启动 Pi.*当前目录，断开后继续运行/);
  assert.doesNotMatch(r.output, /结束 Pi/);
  assert.match(r.output, /项目管理/); assert.match(r.output, /服务管理/);
  assert.deepEqual(mutations(r.calls), []);
});
test("menu connects selected live process, never creates a replacement or resumes history", async (t) => {
  const f = await fixture(t);
  const r = await f.menu(menus(select(0), select(0)), {
    FAKE_RUNNING: "main\t0\t1700000000\n",
  });
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /后台运行/);
  assert(
    r.calls.some(
      (c) => c.args.slice(-3).join("|") === "/usr/local/bin/pic-session|attach|main",
    ),
  );
  assert(
    !r.calls.some((c) => c.args.includes("history") || c.args.includes("start") || c.args.includes("new")),
  );
});
test("menu launches only a hosted process; unknown running status never triggers a launch", async (t) => {
  const f = await fixture(t);
  const r = await f.menu(menus(select(1)));
  assert.equal(r.exitCode, 0);
  assert(
    r.calls.some((c) => c.args.slice(-2).join("|") === "--pic-session|start"),
  );
  assert(!r.calls.some(c => c.args.some(arg => ["--resume", "--continue", "--model", "--thinking"].includes(arg))));
  const bad = await f.menu([...menus(select(0)), pause, ...menus(exitMenu)], { FAKE_LIST_ERROR: "1" });
  assert.equal(bad.exitCode, 0);
  assert.match(bad.output, /查询失败/);
  const errorAt = bad.output.indexOf('查询失败'), ackAt = bad.output.indexOf('「Esc」返回', errorAt);
  assert(ackAt > errorAt && !bad.output.slice(errorAt, ackAt).includes('\x1b[?1049l'), 'error remains in the same exclusive screen until Esc');
  assert(!bad.calls.some((c) => c.args.includes("--pic-session")));
});
test('attachment availability is a scoped, read-only snapshot; unknown state never means empty', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.tool, '.env'), 'invalid deployment configuration');
  for (const [env, status, value] of [
    [{ FAKE_NO_CONTAINER: '1' }, 0, 'empty'],
    [{ FAKE_CONTAINER_STATE: 'exited' }, 0, 'empty'],
    [{ FAKE_LIVE_PI: '0' }, 0, 'empty'],
    [{ FAKE_RUNNING: 'main\t0\t1700000000\n' }, 0, 'available'],
    [{ FAKE_PS_ERROR: '1' }, 73, ''],
    [{ FAKE_COUNT_ERROR: '1' }, 1, ''],
    [{ FAKE_LIVE_PI: 'unknown' }, 1, ''],
    [{ FAKE_CONTAINER_STATE: 'paused' }, 1, ''],
  ]) {
    const r = await f.run(['pi-attach-state'], { FAKE_CONFIG_ERROR: '1', ...env });
    assert.equal(r.status, status, r.stderr); assert.equal(r.stdout, value);
    assert.deepEqual(mutations(r.calls), []);
    assert(!r.calls.some(c => c.args.includes('config') || c.args.includes('services') || c.args.includes('list')));
    const query = r.calls.find(c => c.args.includes('count'));
    if (query) { assert(query.args.includes('1000:1000')); assert(query.args.includes('fake-container')); }
    if (env.FAKE_NO_CONTAINER || env.FAKE_CONTAINER_STATE) assert(!r.calls.some(c => c.args[0] === 'exec'));
  }
  for (const file of ['.runtime', '.update.lock', 'data', 'services-data', '.deploy-keys/installation']) await assert.rejects(fs.access(path.join(f.tool, file)), { code: 'ENOENT' });
});

test('no running Pi dims Attach and skips it without entering an empty process page or starting resources', async t => {
  const f = await fixture(t);
  for (const env of [{ FAKE_NO_CONTAINER: '1' }, { FAKE_CONTAINER_STATE: 'exited' }, { FAKE_RUNNING: '' }]) {
    // Home selects Start when Attach is disabled; Down then selects Projects.
    const r = await f.menu(menus(home + '\x1b[A' + home + down + '\r', esc, exitMenu), env);
    assert.equal(r.exitCode, 0, r.output);
    assert.match(r.output, /  \x1b\[2m接回 Pi.*暂无运行中的 Pi/);
    assert.match(r.output, /> \x1b\[7m启动 Pi/);
    assert.doesNotMatch(r.output, /\x1b\[7m接回 Pi|\x1b\[1m运行中的 Pi|历史对话使用/);
    assert.deepEqual(mutations(r.calls), []);
    assert(!r.calls.some(c => c.args.at(-1) === 'list'));
  }
  for (const file of ['.runtime', '.update.lock', 'data', 'services-data']) await assert.rejects(fs.access(path.join(f.tool, file)), { code: 'ENOENT' });
});

test('an unknown Attach snapshot stays enabled for retry; a stale live snapshot never creates a replacement', async t => {
  const f = await fixture(t);
  const unknown = await f.menu([...menus(select(0)), pause, ...menus(exitMenu)], { FAKE_COUNT_ERROR: '1', FAKE_LIST_ERROR: '1' });
  assert.equal(unknown.exitCode, 0, unknown.output);
  assert.match(unknown.output, /\x1b\[7m接回 Pi.*状态未确认/);
  assert.match(unknown.output, /查询失败/); assert.deepEqual(mutations(unknown.calls), []);
  const stale = await f.menu([...menus(select(0)), pause, ...menus(exitMenu)], { FAKE_RUNNING: '', FAKE_LIVE_PI: '1' });
  assert.match(stale.output, /暂无运行中的 Pi/);
  assert.deepEqual(mutations(stale.calls), []);
});

test('returning to the main menu refreshes Attach availability and never restores disabled focus', async t => {
  const f = await fixture(t), file = path.join(f.root, 'live-count');
  await fs.writeFile(file, '1');
  const r = await f.menu([
    ...menus(select(0)),
    [menuHint, async () => { await fs.writeFile(file, '0'); return esc; }],
    ...menus(esc),
  ], { FAKE_LIVE_PI_FILE: file });
  assert.equal(r.exitCode, 0, r.output);
  const last = r.output.slice(r.output.lastIndexOf('\x1b[1mPi in Container'));
  assert.match(last, /\x1b\[2m接回 Pi.*暂无运行中的 Pi/);
  assert.match(last, /\x1b\[7m启动 Pi/);
  assert.deepEqual(mutations(r.calls), []);
});
test('process selection can be cancelled; ending Pi belongs to native Pi, not a host action', async t => {
  const f = await fixture(t);
  const cancelled = await f.menu(menus(select(0), esc, exitMenu), { FAKE_RUNNING: 'main\t0\t1700000000\n' });
  assert.equal(cancelled.exitCode, 0);
  assert(!cancelled.calls.some(c => c.args.includes('--pic-session') || c.args.includes('close')));
  const removed = await f.run(['pi-end', 'main']);
  assert.equal(removed.status, 2); assert.deepEqual(removed.calls, []);
});
test("arrow menus cover service management, first-action confirmation and Escape without number shortcuts", async t => {
  const f = await fixture(t);
  const cancelled = await f.menu(menus(select(3), select(4), esc, esc, esc), { DEPLOY_DATA_DIR: './services-data' });
  assert.equal(cancelled.exitCode, 0, cancelled.output);
  assert.deepEqual(mutations(cancelled.calls), [], 'Esc cancels; read-only status probes are allowed');
  const state = await f.menu([...menus(select(3), select(0)), pause, ...menus(esc, esc)], { DEPLOY_DATA_DIR: './services-data' });
  assert.equal(state.exitCode, 0, state.output);
  assert(state.calls.some(c => c.args.includes('ps')));
  const restored = await f.menu([...menus(select(3), select(4), '\r'), pause, ...menus(esc, esc)], { DEPLOY_DATA_DIR: './services-data' });
  assert(restored.calls.some(c => c.args.includes('stop') && c.args.includes('fake-service')));
  const second = await f.menu(menus(select(0), select(1)), { FAKE_RUNNING: 'first\t0\t1700000000\nsecond\t0\t1700000001\n' });
  assert(second.calls.some(c => c.args.slice(-3).join('|') === '/usr/local/bin/pic-session|attach|second'));
});
test("private dispatcher rejects unrecognized operations before Docker", async (t) => {
  const f = await fixture(t);
  for (const args of [
    [],
    ["new"],
    ["attach", "main"],
    ["services", "up"],
    ["unknown"],
    ["dev-list", "unexpected"],
    ["dev-remove-all", "unexpected"],
    ["pi-history"],
    ["pi-start", "--resume"],
    ["pi-connect", "a;id"],
  ]) {
    const r = await f.run(args);
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
  }
});
test("Bash argument boundaries, no-TTY exec and application exit code are preserved", async (t) => {
  const f = await fixture(t);
  const cmd = 'printf "%s" "hello world"';
  const r = await f.run(["dev-shell", "-c", cmd]);
  assert.equal(r.status, 0, r.stderr);
  const c = r.calls.find((c) => c.args.includes("--dev-shell"));
  assert(c.args.includes("-T"));
  assert.deepEqual(c.args.slice(-3), ["--dev-shell", "-c", cmd]);
  assert.equal(c.workspace, f.project);
  assert.match(c.history, /project-history\/1000-/);
  assert(r.calls.some((c) => c.args.includes("stop")));
  const fail = await f.run(["dev-shell"], { FAKE_EXIT: "29" });
  assert.equal(fail.status, 29);
  const ext = await f.run(["dev-shell"], { FAKE_EXECS: "1" });
  assert(!ext.calls.some((c) => c.args.includes("stop")));
});
test("attachment failure never falls back to launching Pi or restoring history", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["pi-connect", "main"], { FAKE_EXIT: "17", FAKE_LIVE_PI: "1" });
  assert.equal(r.status, 17);
  assert(
    r.calls.some(
      (c) => c.args.slice(-3).join("|") === "/usr/local/bin/pic-session|attach|main",
    ),
  );
  assert(!r.calls.some((c) => c.args.includes("history") || c.args.includes("start") || c.args.includes("--resume")));
});
test("reattachment does not provision services, parse publishing config or initialize packages", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.tool, ".env"), "invalid dotenv");
  const r = await f.run(["pi-connect", "main"], {
    DEPLOY_DATA_DIR: "./services-data", FAKE_CONFIG_ERROR: "1", FAKE_UP_EXIT: "71", FAKE_LIVE_PI: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  const attach = r.calls.find(c => c.args.includes("attach"));
  assert(attach);
  assert.equal(attach.args[0], "exec");
  assert(attach.args.includes("1000:1000"));
  assert(!r.calls.some(c => c.args.some(arg => ["up", "config", "stop", "/usr/local/bin/pic-entrypoint", "/usr/local/bin/deploy-register"].includes(arg))));
  await assert.rejects(fs.access(path.join(f.tool, ".deploy-keys/installation")));
  const projects = await fs.readdir(path.join(f.tool, ".runtime"));
  assert.equal(projects.length, 1);
  assert.deepEqual((await fs.readdir(path.join(f.tool, ".runtime", projects[0]))).filter(name => name.startsWith('session.')), [], "ordinary terminal lease is released after attach exits");
});
test("missing or unreadable existing container never causes a reattachment startup", async (t) => {
  const f = await fixture(t);
  for (const [env, status] of [[{ FAKE_NO_CONTAINER: "1" }, 1], [{ FAKE_PS_ERROR: "1" }, 73]]) {
    const r = await f.run(["pi-connect", "main"], env);
    assert.equal(r.status, status, r.stderr);
    assert(!r.calls.some(c => c.args.some(arg => ["up", "config", "attach", "stop"].includes(arg))));
  }
});
test("terminal identity and color hints cross all Docker terminal boundaries without forcing a theme", async (t) => {
  const f = await fixture(t);
  const terminal = { TERM: "xterm-256color", COLORTERM: "truecolor", COLORFGBG: "15;0" };
  for (const action of [["pi-start"], ["pi-connect", "main"], ["dev-shell"], ["service-shell"]]) {
    const r = await f.run(action, { ...terminal, DEPLOY_DATA_DIR: "./services-data", FAKE_LIVE_PI: "1" });
    assert.equal(r.status, 0, r.stderr);
    const client = r.calls.find(c => c.args.includes("attach") || c.args.includes("--pic-session") || c.args.includes("--dev-shell") || c.args.includes("--service-shell"));
    assert(client, action.join(" "));
    for (const [key, value] of Object.entries(terminal)) {
      const index = client.args.indexOf(`${key}=${value}`);
      assert(index > 0, key);
      assert.equal(client.args[index - 1], "--env");
    }
    assert(!client.args.some(arg => /use-theme|PI_TRUE_COLOR|PI_THEME/.test(arg)));
  }
});
test("maintenance works without optional publishing config; build args precede service", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.tool, ".env"), "invalid dotenv");
  const built = await f.run([
    "dev-build",
    "--build-arg",
    "NPM_REGISTRY=https://example.com",
  ]);
  assert.equal(built.status, 0);
  assert.deepEqual(built.calls[0].args.slice(-4), [
    "build",
    "--build-arg",
    "NPM_REGISTRY=https://example.com",
    "pi",
  ]);
  for (const action of ["dev-stop", "dev-remove"]) {
    const r = await f.run([action]);
    assert.equal(r.status, 0);
    assert(!r.calls.some((c) => c.args.includes("config")));
  }
});
test("image builds explain the explicit replacement step without recreating containers or updating plugins", async (t) => {
  const f = await fixture(t);
  for (const action of ["dev-build", "dev-rebuild"]) {
    const r = await f.run([action], { FAKE_LIVE_PI: "1", FAKE_EXECS: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert(r.calls[0].args.includes("build"));
    assert.equal(r.calls[0].args.includes("--no-cache"), action === "dev-rebuild");
    assert.match(r.stdout, /镜像构建完成.*检查更新.*现有容器仍使用原镜像/);
  }
  const menu = await f.menu(menus(select(2), esc, esc));
  assert.equal(menu.exitCode, 0, menu.output);
  assert.doesNotMatch(menu.output, /使用已构建镜像|无缓存构建|构建参数|> .*重建容器/);
  assert.deepEqual(mutations(menu.calls), []);
  const failed = await f.run(["dev-rebuild"], { FAKE_BUILD_EXIT: "74" });
  assert.equal(failed.status, 74);
  assert.doesNotMatch(failed.stdout, /镜像构建完成/);
});
test("background Pi, external terminals and unreadable state all block destructive maintenance", async (t) => {
  const f = await fixture(t);
  for (const action of ["dev-stop", "dev-remove", "dev-recreate"])
    for (const env of [
      { FAKE_LIVE_PI: "1" },
      { FAKE_EXECS: "2" },
      { FAKE_COUNT_ERROR: "1" },
    ]) {
      const r = await f.run([action], env);
      assert.equal(r.status, 1, r.stderr);
      assert(
        !r.calls.some(
          (c) =>
            c.args.includes("--force-recreate") ||
            c.args.includes("down") ||
            c.args.includes("stop"),
        ),
      );
    }
});
test("workspace and deployment paths cannot expose installation secrets or aliases", async (t) => {
  const f = await fixture(t);
  for (const dir of [
    "/",
    f.project,
    f.tool,
    path.join(f.tool, "data"),
    path.join(f.tool, ".deploy-keys"),
  ]) {
    const r = await f.run(["dev-shell"], { DEPLOY_DATA_DIR: dir });
    assert.equal(r.status, 1, r.stderr);
    assert(!r.calls.some((c) => c.args.includes("up")));
  }
  for (const cwd of [f.tool, f.root, path.join(f.tool, ".deploy-keys")]) {
    const r = await f.run(["dev-shell"], {}, cwd);
    assert.equal(r.status, 1, r.stderr);
  }
  const alias = path.join(f.root, "service-alias");
  await fs.symlink(path.join(f.tool, ".deploy-keys"), alias);
  const r = await f.run(
    ["dev-shell"],
    { DEPLOY_DATA_DIR: alias },
    path.join(f.tool, ".deploy-keys"),
  );
  assert.equal(r.status, 1);
  assert.equal((await f.run(["service-start"])).status, 1);
});
test("deployment directory creation is private and installation-relative; invalid ports fail first", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["service-state"], {
    DEPLOY_DATA_DIR: "./services-data",
  });
  assert.equal(r.status, 0);
  await assert.rejects(fs.access(path.join(f.tool, 'services-data')), { code: 'ENOENT' }, 'status must not create deployment data');
  const started = await f.run(['service-start'], { DEPLOY_DATA_DIR: './services-data' });
  assert.equal(started.status, 0, started.stderr);
  const data = path.join(f.tool, "services-data");
  assert.equal((await fs.stat(data)).mode & 0o777, 0o700);
  await fs.chmod(data, 0o711);
  assert.equal(
    (await f.run(["service-state"], { DEPLOY_DATA_DIR: "./services-data" }))
      .status,
    0,
  );
  assert.equal((await fs.stat(data)).mode & 0o777, 0o711);
  for (const port of ["80", "65536", "01", "x"]) {
    const directory = path.join(f.root, "absent-" + port);
    const r = await f.run(["service-start"], {
      DEPLOY_DATA_DIR: directory,
      DEPLOY_PORT: port,
    });
    assert.equal(r.status, 1);
    await assert.rejects(fs.access(directory));
  }
});
test("SSH management uses separate service container with no project or Pi-data mount", async (t) => {
  const f = await fixture(t);
  const env = { DEPLOY_DATA_DIR: "./services-data" };
  const r = await f.run(
    ["service-shell", "-lc", 'echo "hello world"'],
    env,
    "/",
  );
  assert.equal(r.status, 0, r.stderr);
  const c = r.calls.find((c) => c.args[0] === "run");
  assert(c);
  assert.deepEqual(c.args.slice(-3), [
    "--service-shell",
    "-lc",
    'echo "hello world"',
  ]);
  assert(c.args.includes("-i"));
  assert(!c.args.some((x) => x.includes("target=/workspace")));
  assert(c.args.includes("/run/pic-ssh:rw,noexec,nosuid,nodev,mode=0700"));
  const fail = await f.run(["service-shell", "-c", "exit 23"], {
    ...env,
    FAKE_RUN_EXIT: "23",
  });
  assert.equal(fail.status, 23);
});
test("image and project identities use pic only and are not caller-overridable", async (t) => {
  const f = await fixture(t),
    other = await fixture(t);
  let image;
  for (const args of [
    ["dev-build"],
    ["dev-rebuild"],
    ["dev-shell"],
    ["dev-recreate"],
  ]) {
    const r = await f.run(args, { PIC_IMAGE: "unrelated" });
    assert.equal(r.status, 0);
    for (const c of r.calls) {
      image ??= c.image;
      assert.equal(c.image, image);
    }
    const up = r.calls.find((c) => c.args.includes("up"));
    if (up)
      assert.match(
        up.args[up.args.indexOf("--project-name") + 1],
        /^pic-r[0-9a-f]{8}-u1000-[0-9a-f]{16}$/,
      );
  }
  assert.match(image, /^pic:r[0-9a-f]{8}$/);
  assert.notEqual((await other.run(["dev-build"])).calls[0].image, image);
});
test("host root remains host-scoped but runtime maps to non-root; ACL failure never opens Pi", async (t) => {
  const f = await fixture(t);
  const env = { FAKE_UID: "0", FAKE_GID: "0", FAKE_GROUPS: "0,27" };
  const r = await f.run(["pi-start"], env);
  assert.equal(r.status, 0);
  assert(
    r.calls.some((c) => c.args.includes("/usr/local/bin/pic-workspace-init")),
  );
  for (const c of r.calls) {
    assert.equal(c.uid, "1000");
    assert.equal(c.gid, "1000");
    assert.equal(c.groups, "1000");
    assert.match(c.history, /project-history\/0-/);
  }
  const fail = await f.run(["pi-start"], { ...env, FAKE_WORKSPACE_EXIT: "21" });
  assert.equal(fail.status, 21);
  assert(!fail.calls.some((c) => c.args.includes("--pic-session")));
  const up = await f.run(["pi-start"], { ...env, FAKE_UP_EXIT: "19" });
  assert.equal(up.status, 19);
  assert(!up.calls.some((c) => c.args.includes("exec")));
});
test(
  "invalid SSH host-key enrollment leaves the existing trusted file unchanged",
  { skip: !hasKeygen },
  async (t) => {
    const f = await fixture(t),
      env = { DEPLOY_DATA_DIR: "./services-data" };
    assert.equal((await f.run(["service-shell"], env)).status, 0);
    const file = path.join(f.tool, ".deploy-keys/installation/known_hosts"),
      prior = await fs.readFile(file, "utf8");
    for (const key of [
      "garbage",
      "ssh-rsa AAA",
      "ssh-ed25519 " + "A".repeat(68),
    ]) {
      const r = await f.run(["service-shell"], { ...env, FAKE_HOST_KEY: key });
      assert.equal(r.status, 1);
      assert.equal(await fs.readFile(file, "utf8"), prior);
      assert(!r.calls.some((c) => c.args[0] === "run"));
    }
  },
);
test("removed control plane has no menu, dispatcher, dependencies or socket mount", async (t) => {
  const f = await fixture(t);
  for (const action of ["web-start", "web-stop", "web-state", "web-logs", "web-build", "web-password"]) {
    const r = await f.run([action]);
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
  }
  for (const file of ["web", "lib/web.sh", "config/nginx-pic.conf"])
    await assert.rejects(fs.access(path.join(repo, file)));
  for (const file of ["bin/pi-container", "scripts/control.sh", "Dockerfile", "compose.yaml", "compose.deploy.yaml", "compose.services.yaml", "package.json", ".npmrc", "scripts/check.sh", ".github/workflows/ci.yml"]) {
    const text = await fs.readFile(path.join(repo, file), "utf8");
    assert.doesNotMatch(text, /pic-web|web-start|web\/|18090|docker\.sock|@xterm|@lydell\/node-pty|playwright/);
  }
});
test("Pi follows npm latest without an exact version or project lockfile", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "latest");
  assert.match(await fs.readFile(path.join(repo, ".npmrc"), "utf8"), /^package-lock=false$/m);
  for (const file of ["package-lock.json", "npm-shrinkwrap.json"])
    await assert.rejects(fs.access(path.join(repo, file)));
  const image = await fs.readFile(path.join(repo, "Dockerfile"), "utf8");
  assert.match(image, /COPY package\.json \.npmrc LICENSE \/opt\/pic\//);
  assert.match(image, /npm install --prefix \/opt\/pic --omit=dev --ignore-scripts --package-lock=false/);
  assert.doesNotMatch(image, /npm ci|package-lock\.json|pi-coding-agent@\d/);
  const ci = await fs.readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm install --ignore-scripts --package-lock=false/);
  assert.doesNotMatch(ci, /npm ci/);
});
test('returning from results and submenus always selects the first enabled action without remembering positions', async t => {
  const f = await fixture(t);
  const r = await f.menu([
    ...menus(select(2), select(0), select(0), select(2)), pause,
    ...menus('\r'), pause,
    ...menus(esc, '\r', '\r'), pause, ...menus(esc, esc, esc, exitMenu),
  ]);
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(r.calls.filter(c => c.args.includes('logs')).length, 1);
  assert.equal(r.calls.filter(c => c.args.includes('pi') && c.args.at(-1) === '--version').length, 2, 'Enter after returning opens the first action, State, rather than Logs');
  const screens = r.output.split('\x1b[?25l\x1b[?2004h');
  for (const frame of screens) {
    if (frame.includes('\x1b[1m项目管理\x1b[0m')) assert(frame.split('\x1b[?2026l')[0].includes('> \x1b[7m选择项目'));
    if (frame.includes('\x1b[1m项目操作\x1b[0m')) assert(frame.split('\x1b[?2026l')[0].includes('> \x1b[7m查看状态'));
    if (frame.includes('\x1b[1mPi in Container\x1b[0m')) assert(frame.split('\x1b[?2026l')[0].includes('> \x1b[7m接回 Pi'));
  }
  const fresh = await f.menu(menus('\r', esc, exitMenu), { FAKE_RUNNING: 'main\t0\t1700000000\n' });
  assert(fresh.calls.some(c => c.args.at(-1) === 'list'));
});

test('app autostart changes persistent policy only; Enter confirms and Esc cancels', async t => {
  const f = await fixture(t), revision = 'a'.repeat(64);
  const env = { DEPLOY_DATA_DIR: './services-data', FAKE_APPS: `demo\ttrue\t${revision}\n` };
  const r = await f.menu([
    ...menus(select(3), select(6), select(0), select(1), '\r', esc, esc, esc),
  ], env);
  assert.equal(r.exitCode, 0, r.output);
  const set = r.calls.find(c => c.args.includes('/usr/local/bin/deploy-apps') && c.args.includes('set'));
  assert(set); assert.deepEqual(set.args.slice(-4), ['set', 'demo', 'false', revision]);
  assert.match(r.output, /不.*当前进程|当前进程不变/);
  assert.match(r.output, /当前：已启用/); assert.match(r.output, /修改为：禁用自启动/); assert.match(r.output, /确认禁用/);
  assert(!r.calls.some(c => c.args.some(arg => ['up', 'run', 'start', 'stop', 'restart', 'update', 'reread'].includes(arg))));
  await assert.rejects(fs.access(path.join(f.tool, 'services-data')), { code: 'ENOENT' });
  const cancel = await f.menu(menus(select(3), select(6), select(0), select(1), esc, esc, esc, esc), env);
  assert(!cancel.calls.some(c => c.args.includes('set')));
});

test('app policy query errors and missing service stay visible and never start a container', async t => {
  const f = await fixture(t);
  for (const [extra, message] of [[{ FAKE_SERVICE_MISSING: '1' }, /服务容器未运行.*未自动启动或修改应用/], [{ FAKE_APP_ERROR: '1' }, /「读取失败」请检查服务容器/], [{ FAKE_APPS: 'invalid\n' }, /格式错误/]]) {
    const r = await f.menu([...menus(select(3), select(6)), pause, ...menus(esc, esc)], { DEPLOY_DATA_DIR: './services-data', ...extra });
    assert.equal(r.exitCode, 0, r.output);
    assert(!r.calls.some(c => c.args.includes('up') || c.args.includes('set')));
    assert.match(r.output, message);
  }
  const malformed = await f.menu([...menus(select(0)), pause, ...menus(exitMenu)], { FAKE_RUNNING: 'not-valid\n' });
  assert.match(malformed.output, /进程状态格式错误/);
  assert(!malformed.calls.some(c => c.args.includes('up') || c.args.includes('attach')));
  const invalid = await f.run(['service-app-set', '../x', 'false', 'a'.repeat(64)]);
  assert.equal(invalid.status, 2); assert.deepEqual(invalid.calls, []);
});

test('status queries show image/runtime boundaries without initialization, updates or service startup', async t => {
  const f = await fixture(t);
  const r = await f.run(['dev-state'], { FAKE_CURRENT_IMAGE: 'sha256:older' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /sha256:|\{"|fake-container/);
  assert.match(r.stdout, /镜像：有新构建/); assert.match(r.stdout, /Pi 版本：1.5.0/);
  assert.match(r.stdout, /synthetic-gateway-commit/);
  assert(!r.calls.some(c => c.args.some(a => ['up', 'config', 'build', 'install', 'update'].includes(a))));
  const absent = await f.run(['dev-state'], { FAKE_NO_CONTAINER: '1' });
  assert.match(absent.stdout, /未创建/);
  assert(!absent.calls.some(c => c.args.includes('exec')));
  const stopped = await f.run(['dev-state'], { FAKE_CONTAINER_STATE: 'exited', FAKE_CONTAINER_EXIT: '143' });
  assert(stopped.stdout.includes(f.project)); assert.match(stopped.stdout, /已停止（退出码 143）/);
  assert.doesNotMatch(stopped.stdout, /容器：未运行|SERVICE|托管 Pi|Pi 版本/);
  assert(!stopped.calls.some(c => c.args.includes('exec')));
});

test('all menus omit navigation items, align action columns, and place Esc first at the bottom', async t => {
  const f = await fixture(t);
  const r = await f.menu(menus(select(2), select(0), select(0), esc, esc, esc, select(3), esc, exitMenu));
  assert.equal(r.exitCode, 0, r.output);
  const common = ['查看状态', '管理终端', '查看日志', '停止容器', '删除容器'];
  const screens = r.output.split('\x1b[?25l\x1b[?2004h');
  for (const kind of ['项目操作', '服务管理']) {
    const frame = screens.find(s => s.includes(`\x1b[1m${kind}\x1b[0m`));
    assert(frame?.includes('> \x1b[7m查看状态'), `${kind}: first action is selected`);
    let position = 0;
    for (const label of common) { const next = frame.indexOf(label, position); assert(next > position); position = next; }
    assert(frame.includes('\x1b[35;1H\x1b[0m「Esc」返回 · 「↑/↓」选择 · 「Enter」确认'));
    assert(frame.includes('\x1b[34;1H\x1b[0m\x1b[2m' + '─'.repeat(109) + '\x1b[0m'), 'key hints have the same separator as the heading');
  }
  for (const chunk of r.output.split(/\x1b\[\d+;1H/)) {
    const line = chunk.split('\x1b[K')[0].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (!/^(?:  |> )(?:接回 Pi|启动 Pi|开发容器|服务容器|无缓存构建|查看状态|管理终端|查看日志|应用自启动|查看全部|清理空闲)\s/.test(line)) continue;
    const prefix = /^(?:  |> )\S+(?: Pi)?\s+/.exec(line)?.[0];
    assert(prefix, line);
    const width = [...prefix].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    assert.equal(width, 20, line);
  }
  assert.doesNotMatch(r.output, /退出菜单|开发终端|项目容器|\x1b\[2J/);
  assert.match(r.output, /选择项目/); assert.match(r.output, /批量清理/); assert.match(r.output, /项目：/);
  assert.equal((r.output.match(/\x1b\[\?1049h/g) || []).length, 1);
  assert.equal((r.output.match(/\x1b\[\?1049l/g) || []).length, 1);
  assert.deepEqual(mutations(r.calls), []);
});

test('status, logs, builds and errors remain in one exclusive screen until Esc returns', async t => {
  const f = await fixture(t);
  const r = await f.menu([
    ...menus(select(2), select(0), select(0), select(0)), pause,
    ...menus(select(2)), pause,
    ...menus(esc, esc, esc, select(0)), pause, ...menus(exitMenu),
  ], { FAKE_LIST_ERROR: '1' });
  assert.equal(r.exitCode, 0, r.output);
  assert.equal((r.output.match(/\x1b\[\?1049h/g) || []).length, 1);
  assert.equal((r.output.match(/\x1b\[\?1049l/g) || []).length, 1);
  assert.doesNotMatch(r.output, /按回车返回|sha256:|\{"/);
  assert.match(r.output, /application error: synthetic diagnostic/);
  assert.match(r.output, /查询失败/);
});

test('Shell and Pi handoff ends the menu invocation; normal exit requires no further key', async t => {
  const f = await fixture(t);
  for (const steps of [menus(select(2), select(0), select(0), select(1)), menus(select(3), select(1)), menus(select(1)), menus(select(0), select(0))]) {
    const r = await f.menu([...steps, ['SHELL-READY', 'exit\r']], { FAKE_INTERACTIVE: '1', DEPLOY_DATA_DIR: './services-data', FAKE_RUNNING: 'main\t0\t1700000000\n' });
    assert.equal(r.exitCode, 0, r.output);
    assert.doesNotMatch(r.output, /按回车返回|连接已结束/);
    const after = r.output.slice(r.output.indexOf('SHELL-READY'));
    assert(!after.includes(menuHint));
    assert.equal((r.output.match(/\x1b\[\?1049h/g) || []).length, 1);
    assert.equal((r.output.match(/\x1b\[\?1049l/g) || []).length, 1);
  }
  const failed = await f.menu(menus(select(3), select(1)), { DEPLOY_DATA_DIR: './services-data', FAKE_REGISTER_EXIT: '27' });
  assert.equal(failed.exitCode, 27, failed.output);
  const primary = failed.output.slice(failed.output.indexOf('\x1b[?1049l'));
  assert.match(primary, /synthetic registration failure/);
  assert(!primary.includes(menuHint));
  const logs = await f.menu([...menus(select(3), select(2)), pause, ...menus(esc, esc)], { FAKE_PS_ERROR: '1' });
  assert.match(logs.output, /操作失败.*退出码：73/);
});

test('a live container operation is visible before completion and Ctrl+C leaves no CLI worker running', async t => {
  const f = await fixture(t);
  const r = await f.menu([...menus(select(3), select(3)), ['OPERATION-PID:', '\x03'], ['退出码：130', '\x1b']], { DEPLOY_DATA_DIR: './services-data', FAKE_SLOW_UP: '1' });
  assert.equal(r.exitCode, 130, r.output);
  assert.match(r.output, /操作失败.*退出码：130/);
  assert.match(r.output, /正在执行/); assert.match(r.output, /Ctrl\+C/);
  const pid = Number(/OPERATION-PID:(\d+)/.exec(r.output)[1]);
  for (let n=0; n<100; n++) {
    try { const state = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); if (state.split(' ')[2] === 'Z') return; }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('container CLI worker survived the interrupted menu');
});

test('both containers use readable state and prefix-free bounded logs without startup side effects', async t => {
  const f = await fixture(t);
  for (const kind of ['dev', 'service']) {
    const env = { DEPLOY_DATA_DIR: './services-data' };
    const state = await f.run([`${kind}-state`], env);
    assert.equal(state.status, 0, state.stderr);
    assert.doesNotMatch(state.stdout, /sha256:|\{"|fake-container/);
    assert(state.calls.some(c => c.args.includes('ps') && c.args.includes('-aq')));
    const logs = await f.run([`${kind}-logs`], env);
    assert.equal(logs.status, 0, logs.stderr);
    assert.match(logs.stdout, /application error/);
    const call = logs.calls.find(c => c.args.includes('logs'));
    if (kind === 'dev') assert.deepEqual(call.args.slice(-6), ['logs', '--no-color', '--no-log-prefix', '--tail', '200', 'pi']);
    else assert.deepEqual(call.args, ['logs', '--tail', '200', 'fake-service']);
    assert(![...state.calls, ...logs.calls].some(c => c.args.some(a => ['up', 'build', 'install', 'update'].includes(a))));
  }
});

test('manual image build and container recreation forms are absent from both menus', async t => {
  const f = await fixture(t);
  for (const entry of [2, 3]) {
    const r = await f.menu(menus(select(entry), esc, esc));
    assert.equal(r.exitCode, 0, r.output);
    assert.doesNotMatch(r.output, /使用缓存|无缓存构建|构建参数|使用已构建镜像/);
    assert.deepEqual(mutations(r.calls), []);
  }
});

test('Pi and development shells never start a stopped, paused, absent or failed service', async t => {
  const f = await fixture(t);
  for (const action of ['pi-start', 'dev-shell']) for (const state of ['exited', 'paused', 'restarting', 'dead', 'missing']) {
    const r = await f.run([action], { DEPLOY_DATA_DIR: './services-data', FAKE_SERVICE_STATE: state, FAKE_SERVICE_MISSING: state === 'missing' ? '1' : '0', FAKE_LIVE_PI: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert(r.calls.some(c => c.args.includes('up') && c.args.at(-1) === 'pi'));
    assert(!r.calls.some(c => c.args.includes('up') && c.args.at(-1) === 'services'));
    assert(!r.calls.some(c => c.args.includes('/usr/local/bin/deploy-register') || c.args[0] === 'build'));
    await assert.rejects(fs.access(path.join(f.tool, 'services-data')));
    await assert.rejects(fs.access(path.join(f.tool, '.deploy-keys/installation')));
  }
  const failed = await f.run(['pi-start'], { DEPLOY_DATA_DIR: './services-data', FAKE_REGISTER_EXIT: '27', FAKE_LIVE_PI: '1' });
  assert.equal(failed.status, 0, failed.stderr); assert.match(failed.stderr, /部署连接未就绪/);
  assert(failed.calls.some(c => c.args.includes('--pic-session')));
  assert(!failed.calls.some(c => c.args.includes('compose.deploy.yaml') || c.args.includes('up') && c.args.at(-1) === 'services'));
});

test('a stopped service management terminal asks before startup; Esc cancels and Enter authorizes startup', async t => {
  const f = await fixture(t), env = { DEPLOY_DATA_DIR: './services-data', FAKE_SERVICE_FLAG: path.join(f.root, 'service-started') };
  const cancelled = await f.menu(menus(select(3), select(1), esc, esc, esc), env);
  assert.match(cancelled.output, /是否启动服务后进入管理终端/);
  assert.deepEqual(mutations(cancelled.calls), []);
  await assert.rejects(fs.access(path.join(f.tool, '.deploy-keys/installation')));
  const started = await f.menu([...menus(select(3), select(1), '\r'), ['SHELL-READY', 'exit\r']], { ...env, FAKE_INTERACTIVE: '1' });
  assert.equal(started.exitCode, 0, started.output);
  assert.equal(started.calls.filter(c => c.args.includes('up')).length, 1);
  assert.equal(started.calls.find(c => c.args.includes('up')).args.at(-1), 'services');
  assert(started.calls.some(c => c.args[0] === 'run'));
  assert(!started.calls.some(c => c.args.includes('--pic-session')));
});

test('service startup rejects unapplied data or port changes rather than silently retaining or replacing a container', async t => {
  const f = await fixture(t);
  for (const extra of [{ FAKE_SERVICE_DATA: path.join(f.root, 'old-data') }, { FAKE_SERVICE_BINDING: '127.0.0.1:19000' }]) {
    const r = await f.run(['service-start'], { DEPLOY_DATA_DIR: './services-data', ...extra });
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /部署配置待应用/);
    assert.deepEqual(mutations(r.calls), []);
    await assert.rejects(fs.access(path.join(f.tool, 'services-data')));
  }
});

test('deployment settings are read-only and saved separately from the environment and container lifecycle', async t => {
  const f = await fixture(t);
  const empty = await f.run(['service-config-get']); assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(empty.stdout.split('\n').slice(0, 4), ['missing', '', '18080', '']);
  assert.deepEqual(mutations(empty.calls), []);
  for (const dir of ['.env', 'services-data', 'data', '.runtime']) await assert.rejects(fs.access(path.join(f.tool, dir)));
  const original = "# keep this comment\r\nPRIVATE_SETTING='synthetic#value'\r\nDEPLOY_DATA_DIR=old\r\nexport DEPLOY_PORT=19000\r\nDEPLOY_PORT=19001\r\nOTHER=untouched";
  const file = path.join(f.tool, '.env'); await fs.writeFile(file, original);
  const revision = createHash('sha256').update(original).digest('hex');
  const directory = path.join(f.root, "external $literal's data#folder"), url = 'https://app-{app}.example.com/path?value=$literal';
  const saved = await f.run(['service-config-save', revision, directory, '18081', url]);
  assert.equal(saved.status, 0, saved.stderr); assert.match(saved.stdout, /部署配置已保存/); assert.doesNotMatch(saved.stdout, /synthetic#value/);
  const content = await fs.readFile(file, 'utf8');
  assert(content.includes("# keep this comment\r\nPRIVATE_SETTING='synthetic#value'\r\n"));
  assert(content.includes('OTHER=untouched\r\n'));
  for (const key of ['DEPLOY_DATA_DIR', 'DEPLOY_PORT', 'DEPLOY_PUBLIC_URL']) assert.equal(content.split('\n').filter(line => line.startsWith(key + '=')).length, 1);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const read = await f.run(['service-config-get'], { DEPLOY_DATA_DIR: 'ignored-env-value', DEPLOY_PORT: '20000' });
  assert.equal(read.status, 0, read.stderr); assert.deepEqual(read.stdout.split('\n').slice(1, 4), [directory, '18081', url]);
  assert.deepEqual(mutations(saved.calls), []); await assert.rejects(fs.access(directory));
});

test('deployment settings refuse concurrent edits, unsafe files, unsupported multiline dotenv and invalid values without data changes', async t => {
  const f = await fixture(t), file = path.join(f.tool, '.env');
  const revision = s => createHash('sha256').update(s).digest('hex');
  const original = '# untouched\nDEPLOY_DATA_DIR=\n'; await fs.writeFile(file, original);
  const changed = original + 'CONCURRENT=keep\n'; await fs.writeFile(file, changed);
  const stale = await f.run(['service-config-save', revision(original), './services-data', '18080', '']);
  assert.equal(stale.status, 1); assert.match(stale.stderr, /其他操作者修改/); assert.equal(await fs.readFile(file, 'utf8'), changed);
  for (const [directory, port, url] of [ ['/', '18080', ''], [path.join(f.tool, 'data'), '18080', ''], ['./services-data', '80', ''], ['./services-data', '65536', ''], ['./services-data', '18080', 'file:///tmp/app'], ['./services-data', '18080', 'https://user:password@example.com'], ['./services-data', '18080', 'https://bad host'], ['two\nlines', '18080', ''] ]) {
    const r = await f.run(['service-config-save', revision(changed), directory, port, url]); assert.equal(r.status, 1, r.stderr);
    assert.equal(await fs.readFile(file, 'utf8'), changed); assert.deepEqual(mutations(r.calls), []);
  }
  for (const content of ["OTHER='first\nDEPLOY_PORT=19999\nlast'\n", 'INVALID LINE\n', 'NUL=\0x', 'x'.repeat(1048577)]) {
    await fs.writeFile(file, content);
    const r = await f.run(['service-config-save', revision(content), './services-data', '18080', '']); assert.equal(r.status, 1, r.stderr);
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
  await fs.rm(file); const target = path.join(f.root, 'target.env'); await fs.writeFile(target, original); await fs.symlink(target, file);
  assert.equal((await f.run(['service-config-get'])).status, 1);
  assert.equal((await f.run(['service-config-save', 'missing', './services-data', '18080', ''])).status, 1); assert.equal(await fs.readFile(target, 'utf8'), original);
  await fs.rm(file); await fs.link(target, file); assert.equal((await f.run(['service-config-get'])).status, 1);
  await fs.rm(file); spawnSync('mkfifo', [file]); assert.equal((await f.run(['service-config-get'])).status, 1);
  assert(!(await fs.readdir(f.tool)).some(name => name.startsWith('.env.pc-')));
  await assert.rejects(fs.access(path.join(f.tool, 'services-data')));
});

test('deployment settings support editing all fields, Esc cancellation and Enter persistence without starting services', async t => {
  const f = await fixture(t);
  const edited = [ ...menus(select(3), select(7), select(0), select(2)), ['「Ctrl+U」清空', '\x1518082\r'], ...menus(select(3)), ['「Ctrl+U」清空', 'https://app-{app}.example.com\r'], ...menus(select(4)) ];
  const cancelled = await f.menu([...edited, ...menus(esc, esc, esc, esc)]);
  assert.match(cancelled.output, /DEPLOY|部署配置/); assert.match(cancelled.output, /18082/);
  assert.deepEqual(mutations(cancelled.calls), []); await assert.rejects(fs.access(path.join(f.tool, '.env')));
  const saved = await f.menu([...edited, ...menus('\r'), pause, ...menus(esc, esc)]);
  assert.equal(saved.exitCode, 0, saved.output); assert.match(saved.output, /部署配置已保存/);
  const read = await f.run(['service-config-get']); assert.deepEqual(read.stdout.split('\n').slice(1, 4), ['./services-data', '18082', 'https://app-{app}.example.com']);
  assert.deepEqual(mutations(saved.calls), []); await assert.rejects(fs.access(path.join(f.tool, 'services-data')));
});

test('a concurrent dotenv edit during native validation is detected before atomic replacement', async t => {
  const f = await fixture(t), file = path.join(f.tool, '.env'), original = 'DEPLOY_DATA_DIR=\n';
  await fs.writeFile(file, original);
  const revision = createHash('sha256').update(original).digest('hex');
  const r = await f.run(['service-config-save', revision, './services-data', '18080', ''], { FAKE_EDIT_CONFIG: file });
  assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /其他操作者修改/);
  assert.equal(await fs.readFile(file, 'utf8'), original + 'CONCURRENT_EDIT=keep\n');
  assert(!(await fs.readdir(f.tool)).some(name => name.startsWith('.env.pc-')));
  assert.deepEqual(mutations(r.calls), []);
});

test('Pi startup skips a busy service connection lock rather than waiting for service maintenance', async t => {
  const f = await fixture(t), lock = path.join(f.tool, '.services.lock');
  const holder = spawn('bash', ['-c', 'exec 9>>"$1"; flock -x 9; printf ready; read -r _', '_', lock], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGTERM')); await new Promise(resolve => holder.stdout.once('data', resolve));
  const r = await f.run(['pi-start'], { DEPLOY_DATA_DIR: './services-data', FAKE_LIVE_PI: '1' });
  assert.equal(r.status, 0, r.stderr); assert(r.calls.some(c => c.args.includes('--pic-session')));
  assert(!r.calls.some(c => c.args.includes('/usr/local/bin/deploy-register') || c.args.includes('up') && c.args.at(-1) === 'services'));
  await assert.rejects(fs.access(path.join(f.tool, '.deploy-keys/installation')));
});

test('deployment settings offer a separate rebuild confirmation with application and SSH impact, without undoing saved configuration', async t => {
  const f = await fixture(t), file = path.join(f.tool, '.env');
  const original = "DEPLOY_DATA_DIR='./services-data'\nDEPLOY_PORT=18080\n";
  const env = { DEPLOY_DATA_DIR: undefined, DEPLOY_PORT: undefined, DEPLOY_PUBLIC_URL: undefined, FAKE_SERVICE_PRESENT: '1', FAKE_SERVICE_BINDING: '127.0.0.1:18080', FAKE_SERVICE_EXECS: 'active-exec' };
  const edit = [ ...menus(select(3), select(7), select(2)), ['「Ctrl+U」清空', '\x1518082\r'], ...menus(select(4), '\r'), pause ];
  await fs.writeFile(file, original);
  const cancelled = await f.menu([...edit, ...menus(esc, esc, esc)], env);
  assert.equal(cancelled.exitCode, 0, cancelled.output);
  assert.match(cancelled.output, /是否重建服务容器/); assert.match(cancelled.output, /demo RUNNING/); assert.match(cancelled.output, /deploy sshd/); assert.match(cancelled.output, /active-exec/);
  assert.match(cancelled.output, /可写层.*丢失/); assert.deepEqual(mutations(cancelled.calls), []);
  assert.match(await fs.readFile(file, 'utf8'), /DEPLOY_PORT='18082'/);
  await fs.writeFile(file, original);
  const confirmed = await f.menu([...edit, ...menus('\r'), pause, ...menus(esc, esc)], env);
  assert.equal(confirmed.exitCode, 0, confirmed.output);
  const up = confirmed.calls.find(c => c.args.includes('--force-recreate')); assert(up);
  assert(up.args.includes('--no-build') && up.args.includes('--no-deps') && up.args.includes('--wait')); assert.equal(up.args.at(-1), 'services');
  assert(!confirmed.calls.some(c => c.args[0] === 'build' || c.args.includes('--pic-session')));
});

test('explicit service start also offers configuration rebuild instead of directing manual deletion', async t => {
  const f = await fixture(t), env = { DEPLOY_DATA_DIR: './services-data', DEPLOY_PORT: '18082', FAKE_SERVICE_BINDING_FILE: path.join(f.root, 'binding') };
  await fs.writeFile(env.FAKE_SERVICE_BINDING_FILE, '127.0.0.1:18080');
  const cancelled = await f.menu(menus(select(3), select(3), esc, esc, esc), env);
  assert.match(cancelled.output, /是否重建服务容器/); assert.deepEqual(mutations(cancelled.calls), []);
  const confirmed = await f.menu([...menus(select(3), select(3), '\r'), pause, ...menus(esc, esc)], env);
  assert.match(confirmed.output, /服务容器已重建/); assert(confirmed.calls.some(c => c.args.includes('--force-recreate')));
});

test("host root directory is never a project bind", async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { FAKE_UID: "0" }]) {
    const r = await f.run(["pi-start"], env, "/");
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
  }
});
