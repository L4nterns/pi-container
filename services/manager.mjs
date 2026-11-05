import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { checkApp, checkOperation, publicUrl, receiveBundle, validateManifest } from './protocol.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function nginxConfig(apps) {
  const servers = Object.entries(apps).filter(([, app]) => app.enabled).map(([name, app]) => {
    checkApp(name);
    if (!Number.isInteger(app.port) || app.port < 20000 || app.port > 59999) throw new Error('Invalid upstream port');
    return `server {
    listen 8080;
    server_name ~^app-${name}\\.[a-z0-9.-]+$;
    location / {
        proxy_pass http://127.0.0.1:${app.port};
        proxy_hide_header X-App-Route;
        add_header X-App-Route ${app.port} always;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $http_x_real_ip;
        proxy_set_header X-Forwarded-For $http_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $http_x_forwarded_port;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_max_body_size 100m;
    }
}`;
  }).join('\n');
  return `worker_processes auto;
user www-data;
pid /run/app-services/nginx.pid;
error_log stderr warn;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log off;
    server_tokens off;
    map $http_upgrade $connection_upgrade { default upgrade; '' ''; }
    server { listen 8080 default_server; server_name _; return 404; }
${servers}
}
`;
}

async function availablePort(excluded) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = crypto.randomInt(20000, 60000);
    if (excluded.has(port)) continue;
    const free = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('没有可用的内部端口');
}

async function probe(port, healthPath) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: healthPath, timeout: 1000 }, res => {
      res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

export class Manager {
  constructor(root = '/srv/app-services', { system = true } = {}) {
    this.root = root;
    this.system = system;
    this.apps = {};
    this.installation = null;
    this.children = new Map();
    this.pending = Promise.resolve();
    this.stopping = false;
  }
  serial(fn) {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  appDir(name) { return path.join(this.root, 'apps', checkApp(name)); }
  async load() {
    await fs.chmod(this.root, 0o711);
    for (const name of ['apps', 'incoming', 'control']) {
      await fs.mkdir(path.join(this.root, name), { recursive: true, mode: name === 'incoming' ? 0o700 : 0o711 });
    }
    await fs.chmod(path.join(this.root, 'apps'), 0o711);
    this.installation = await this.readJson('installation.json', null);
    if (!this.installation) {
      this.installation = { token: crypto.randomBytes(32).toString('hex'), nextUid: 20000 };
      await this.save('installation.json', this.installation);
    }
    if (!/^[a-f0-9]{64}$/.test(this.installation.token) || !Number.isInteger(this.installation.nextUid) ||
        this.installation.nextUid < 20000 || this.installation.nextUid > 60000) throw new Error('Invalid installation state');
    const control = path.join(this.root, 'control');
    if (this.system) this.ensureAccount('deploy', 19000, control, '/bin/sh');
    await fs.chmod(control, 0o711);
    const tokenFile = path.join(control, 'token');
    await fs.writeFile(tokenFile, this.installation.token + '\n', { mode: 0o440 });
    if (this.system) await fs.chown(tokenFile, 0, 19000);
    await fs.chmod(tokenFile, 0o440);
    // Reclaim interrupted uploads. Incoming is never application-writable.
    for (const name of await fs.readdir(path.join(this.root, 'incoming'))) {
      if (name.startsWith('upload-')) await fs.rm(path.join(this.root, 'incoming', name), { recursive: true, force: true });
    }
    this.apps = await this.readJson('apps.json', {});
    const uids = new Set();
    for (const [name, app] of Object.entries(this.apps)) {
      checkApp(name);
      if (!Number.isInteger(app.uid) || app.uid < 20000 || app.uid >= this.installation.nextUid || uids.has(app.uid) ||
          typeof app.enabled !== 'boolean' || (app.deleting !== undefined && app.deleting !== true)) throw new Error('Invalid persisted application identity');
      uids.add(app.uid);
      if (app.deleting) {
        if (app.enabled) throw new Error('Invalid pending deletion');
        try { await this.finishDelete(name); }
        catch (err) { console.error('应用删除清理未完成，保留名称占用：', name, err.message); }
        continue;
      }
      app.manifest = validateManifest(app.manifest);
      if (!/^release-[a-f0-9-]+$/.test(app.release) || !Number.isInteger(app.port) || app.port < 20000 || app.port > 59999) throw new Error('Invalid persisted application');
      if (this.system) this.ensureAccount(`app${app.uid}`, app.uid, this.appDir(name), '/usr/sbin/nologin');
    }
    for (const name of await fs.readdir(path.join(this.root, 'apps'))) {
      checkApp(name);
      const app = Object.hasOwn(this.apps, name) ? this.apps[name] : undefined;
      if (app?.deleting) continue;
      if (!app) {
        await fs.rm(this.appDir(name), { recursive: true, force: true });
        continue;
      }
      for (const release of await fs.readdir(this.appDir(name))) {
        if (/^release-[a-f0-9-]+$/.test(release) && release !== app.release) {
          await fs.rm(path.join(this.appDir(name), release), { recursive: true, force: true });
        }
      }
    }
    // Reclaim runtime accounts left by an interrupted first deployment. UIDs
    // are never reused; only exact accounts under our application root qualify.
    if (this.system) {
      for (const record of execute('getent', ['passwd']).trim().split('\n')) {
        const [user, , uid, , , home] = record.split(':');
        if (/^app[0-9]+$/.test(user) && user === `app${uid}` && Number(uid) >= 20000 &&
            Number(uid) < this.installation.nextUid && !uids.has(Number(uid)) && home.startsWith(path.join(this.root, 'apps') + '/')) {
          this.removeAccount(Number(uid), home);
        }
      }
    }
    for (const [name, app] of Object.entries(this.apps)) {
      if (app.enabled) await this.start(name, app);
    }
  }
  async readJson(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
  }
  async save(name, value) {
    const temp = path.join(this.root, `${name}.tmp`);
    const file = await fs.open(temp, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally { await file.close(); }
    await fs.rename(temp, path.join(this.root, name));
    const directory = await fs.open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  ensureAccount(user, uid, home, shell) {
    try {
      const record = execute('getent', ['passwd', user]).trim().split(':');
      if (Number(record[2]) !== uid || Number(record[3]) !== uid || record[5] !== home || record[6] !== shell) {
        throw new Error('Conflicting service account');
      }
    } catch (err) {
      if (err.status !== 2) throw err;
      try {
        const group = execute('getent', ['group', user]).trim().split(':');
        if (Number(group[2]) !== uid) throw new Error('Conflicting service group');
      } catch (groupError) {
        if (groupError.status !== 2) throw groupError;
        execute('groupadd', ['--gid', String(uid), user]);
      }
      execute('useradd', ['--uid', String(uid), '--gid', String(uid), '--no-create-home', '--home-dir', home, '--shell', shell, '--password', '*', user]);
    }
  }
  removeAccount(uid, home) {
    const user = `app${uid}`;
    try {
      const record = execute('getent', ['passwd', user]).trim().split(':');
      if (Number(record[2]) !== uid || Number(record[3]) !== uid || record[5] !== home || record[6] !== '/usr/sbin/nologin') {
        throw new Error('Conflicting application account; refusing removal');
      }
      // Never use --remove: application data deletion is a separate durable step.
      execute('userdel', [user]);
    } catch (err) { if (err.status !== 2) throw err; }
    try {
      const record = execute('getent', ['group', user]).trim().split(':');
      if (Number(record[2]) !== uid) throw new Error('Conflicting application group; refusing removal');
      execute('groupdel', [user]);
    } catch (err) { if (err.status !== 2) throw err; }
  }
  async register(key) {
    if (typeof key !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{40,100}={0,2}(?: [^\r\n]*)?$/.test(key)) throw new Error('SSH 公钥不合法');
    const file = path.join(this.root, 'control', 'authorized_keys');
    const publicKey = key.split(' ').slice(0, 2).join(' ');
    await fs.writeFile(file, `restrict,command="/usr/local/bin/deploy-gateway" ${publicKey}\n`, { mode: 0o644 });
    await fs.chmod(file, 0o644);
    return { user: 'deploy' };
  }
  authenticate(user, token) {
    return user === 'deploy' && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.installation.token));
  }
  async route(apps = this.apps) {
    if (!this.system) return;
    const file = '/run/app-services/nginx.conf';
    let previous;
    try { previous = await fs.readFile(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    await fs.writeFile(file, nginxConfig(apps), { mode: 0o600 });
    try {
      // Native stderr uses the inherited descriptor. /dev/stderr would reopen
      // Node's socket-backed child pipe and can fail with ENXIO during nginx -t.
      execute('nginx', ['-e', 'stderr', '-t', '-c', file]);
      if (this.nginx) execute('nginx', ['-e', 'stderr', '-s', 'reload', '-c', file]);
    } catch (err) {
      if (previous) await fs.writeFile(file, previous);
      const diagnostic = err.stderr?.toString().trim();
      if (diagnostic) console.error('Nginx 诊断：\n' + diagnostic);
      throw new Error('网关配置校验或重载失败，保留原路由', { cause: err });
    }
  }
  async start(name, app, key = name) {
    const home = this.appDir(name);
    const directory = home;
    const user = `app${app.uid}`;
    const log = await fs.open(path.join(directory, 'app.log'), 'a', 0o600);
    const options = {
      cwd: path.join(directory, app.release), detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production',
        ...(this.system ? {} : app.manifest.env),
        HOME: home, USER: user, LOGNAME: user, HOST: '127.0.0.1', PORT: String(app.port), APP_DATA_DIR: path.join(directory, 'data') },
      stdio: this.system ? ['ignore', log.fd, log.fd, 'pipe'] : ['ignore', log.fd, log.fd],
    };
    let command = app.manifest.command[0], args = app.manifest.command.slice(1);
    if (this.system) {
      // Unlike spawn(uid), setpriv also clears root supplementary groups and all
      // inheritable/ambient/bounding capabilities before any application code.
      args = ['--reuid', String(app.uid), '--regid', String(app.uid), '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--', 'node', '/opt/app-services/launch.mjs'];
      command = 'setpriv';
    }
    const child = spawn(command, args, options);
    const entry = { child, app, key, expected: false, timer: null };
    this.children.set(key, entry);
    const exited = () => {
      entry.failed = true;
      if (entry.expected || this.stopping || entry.key !== name || this.children.get(name) !== entry) return;
      entry.timer = setTimeout(() => this.serial(async () => {
        if (this.children.get(name) === entry && this.apps[name]?.enabled && !this.stopping) {
          await this.stop(name);
          await this.start(name, this.apps[name]);
        }
      }).catch(err => console.error('应用重启失败：', name, err.message)), 3000);
    };
    if (this.system) {
      child.stdio[3].on('error', () => {});
      child.stdio[3].end(JSON.stringify(app.manifest));
    }
    child.once('error', exited);
    child.once('exit', () => {
      // A foreground app may leave children; reap its process group before a
      // restart or the next deployment can collide with the previous listener.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') console.error('清理应用进程组失败'); } }
      exited();
    });
    await log.close();
    return entry;
  }
  async stop(name) {
    const entry = this.children.get(name);
    if (!entry) return;
    entry.expected = true;
    clearTimeout(entry.timer);
    const signal = sig => { try { process.kill(-entry.child.pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; } };
    if (entry.child.pid) {
      signal('SIGTERM');
      for (let i = 0; i < 30 && entry.child.exitCode === null && entry.child.signalCode === null; i++) await sleep(100);
      signal('SIGKILL');
    }
    this.children.delete(name);
  }
  async deploy(name, input) {
    checkApp(name);
    const old = Object.hasOwn(this.apps, name) ? this.apps[name] : undefined;
    if (old?.deleting) throw new Error('应用正在删除；请重试 appctl delete 完成清理');
    const staging = await fs.mkdtemp(path.join(this.root, 'incoming', 'upload-'));
    let directory, release, allocatedUid, candidateStarted = false;
    try {
      const bundle = await receiveBundle(input, staging);
      const port = await availablePort(new Set(Object.values(this.apps).map(a => a.port)));
      const uid = old?.uid ?? this.installation.nextUid;
      allocatedUid = uid;
      if (!old) {
        if (uid >= 60000) throw new Error('应用运行账号数量达到限制');
        const next = { ...this.installation, nextUid: uid + 1 };
        await this.save('installation.json', next);
        this.installation = next;
      }
      directory = this.appDir(name);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(directory, 'data'), { recursive: true, mode: 0o700 });
      release = `release-${crypto.randomUUID()}`;
      await fs.rename(staging, path.join(directory, release));
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      if (this.system) {
        // Keep service-owned control files out of the user-writable application
        // tree. Each application has its own runtime UID.
        this.ensureAccount(`app${uid}`, uid, directory, '/usr/sbin/nologin');
        execute('chown', ['-Rh', `${uid}:${uid}`, path.join(directory, release), path.join(directory, 'data')]);
        await fs.chmod(directory, 0o711);
      }
      const app = { uid, release, port, manifest: bundle.manifest, enabled: true };
      // Keep the old process serving until the candidate has passed readiness.
      const candidateName = `${name}:candidate`;
      const candidate = await this.start(name, app, candidateName);
      candidateStarted = true;
      return await this.activate(name, app, old, candidate, candidateName, bundle);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (!candidateStarted && release) await fs.rm(path.join(directory, release), { recursive: true, force: true }).catch(() => {});
      // A rejected first release has no durable application definition. Reclaim
      // its account as well as its tree, otherwise a retry allocates a new UID
      // but collides with the old account's home and unreadable data directory.
      if (!old && !Object.hasOwn(this.apps, name) && directory) {
        if (this.system) this.removeAccount(allocatedUid, directory);
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
  async activate(name, app, old, candidate, candidateName, bundle, removeFailedRelease = true) {
    let activated = false;
    try {
      const until = Date.now() + app.manifest.readyTimeout * 1000;
      while (Date.now() < until) {
        if (candidate.failed) throw new Error('应用启动失败；请检查 appctl logs');
        if (await probe(app.port, app.manifest.healthPath)) break;
        await sleep(200);
      }
      if (candidate.failed || !await probe(app.port, app.manifest.healthPath)) throw new Error('应用就绪检查超时；原服务未替换');
      // Validate optional public URL before changing runtime or routing state.
      const url = publicUrl(process.env.DEPLOY_PUBLIC_URL, name);
      const next = { ...this.apps, [name]: app };
      await this.route(next);
      try {
        // Reload is asynchronous. Keep the old process alive until a fresh
        // gateway request demonstrably reaches the new upstream port.
        if (this.system) await this.gatewayReady(name, app.manifest.healthPath, app.port);
        if (candidate.failed) throw new Error('候选应用在切换前退出，保留原服务');
        await this.save('apps.json', next);
      } catch (err) { await this.route(this.apps); throw err; }
      this.apps = next;
      await this.stop(name);
      this.children.delete(candidateName);
      candidate.key = name;
      this.children.set(name, candidate);
      activated = true;
      if (candidate.failed) { await this.stop(name); await this.start(name, app); }
      if (old && old.release !== app.release) await fs.rm(path.join(this.appDir(name), old.release), { recursive: true, force: true }).catch(() => {});
      return { app: name, state: 'ready', ...(bundle ? { files: bundle.files, bytes: bundle.bytes } : {}), url, publicVerified: false };
    } finally {
      if (!activated) {
        await this.stop(candidateName);
        if (removeFailedRelease) await fs.rm(path.join(this.appDir(name), app.release), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  async gatewayReady(name, healthPath, port, requireHealthy = true) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const ok = await new Promise(resolve => {
        const req = http.get({ hostname: '127.0.0.1', port: 8080, path: healthPath,
          headers: { Host: `app-${name}.internal` }, timeout: 1000 }, res => {
          res.resume(); resolve((!requireHealthy || (res.statusCode >= 200 && res.statusCode < 400)) && res.headers['x-app-route'] === String(port));
        });
        req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy());
      });
      if (ok) return;
      await sleep(100);
    }
    throw new Error('应用已启动但网关尚未就绪，请检查服务日志；未验证公网');
  }
  async gatewayStopped(name) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const removed = await new Promise(resolve => {
        const req = http.get({ hostname: '127.0.0.1', port: 8080, path: '/',
          headers: { Host: `app-${name}.internal` }, timeout: 1000 }, res => {
          res.resume(); resolve(res.statusCode === 404 && !res.headers['x-app-route']);
        });
        req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy());
      });
      if (removed) return;
      await sleep(100);
    }
    throw new Error('网关未确认撤下路由，保留原服务');
  }
  own(name) {
    checkApp(name);
    const app = Object.hasOwn(this.apps, name) ? this.apps[name] : undefined;
    if (!app) throw new Error('没有此应用');
    return app;
  }
  describe(name, app) {
    const running = Boolean(this.children.get(name) && !this.children.get(name).failed);
    return { app: name, state: app.deleting ? 'deleting' : !app.enabled ? 'stopped' : running ? 'running' : 'restarting',
      enabled: app.enabled, running, url: publicUrl(process.env.DEPLOY_PUBLIC_URL, name) };
  }
  async finishDelete(name) {
    await this.stop(name);
    const app = this.apps[name];
    const base = path.join(this.root, 'apps');
    await fs.rm(path.join(base, name), { recursive: true, force: true });
    // Persist the directory removal before committing name release. Otherwise a
    // power loss could restore an old data tree under a newly registered name.
    const directory = await fs.open(base, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    if (this.system) this.removeAccount(app.uid, this.appDir(name));
    const next = { ...this.apps };
    delete next[name];
    await this.save('apps.json', next);
    this.apps = next;
    return { app: name, state: 'deleted', dataPreserved: false };
  }
  async command(action, name, input) {
    checkOperation(action, name);
    if (action === 'deploy') return this.deploy(name, input);
    if (action === 'list') return Object.entries(this.apps).map(([name, app]) => this.describe(name, app));
    const app = this.own(name);
    if (action === 'status') return { ...this.describe(name, app),
      internalHealthy: app.enabled && !app.deleting ? await probe(app.port, app.manifest.healthPath) : false,
      publicVerified: false };
    if (app.deleting) {
      if (action === 'delete') return this.finishDelete(name);
      throw new Error('应用正在删除；请重试 appctl delete 完成清理');
    }
    if (action === 'logs') {
      const file = await fs.open(path.join(this.appDir(name), 'app.log'), 'r');
      try {
        const st = await file.stat(), size = Math.min(st.size, 65536), buffer = Buffer.alloc(size);
        await file.read(buffer, 0, size, st.size - size);
        return { app: name, logs: buffer.toString('utf8') };
      } finally { await file.close(); }
    }
    if (action === 'start' || action === 'restart') {
      if (action === 'start' && app.enabled) return this.command('status', name);
      const port = await availablePort(new Set(Object.values(this.apps).map(a => a.port)));
      const next = { ...app, port, enabled: true };
      const key = `${name}:candidate`, candidate = await this.start(name, next, key);
      // Reuse the persisted release without deleting it on candidate failure.
      return this.activate(name, next, app, candidate, key, null, false);
    }
    const next = { ...this.apps, [name]: { ...app, enabled: false, ...(action === 'delete' ? { deleting: true } : {}) } };
    await this.route(next);
    try {
      if (this.system) await this.gatewayStopped(name);
      // Commit disabled/deleting intent before stopping or erasing any data.
      await this.save('apps.json', next);
    } catch (err) { await this.route(this.apps); throw err; }
    this.apps = next;
    await this.stop(name);
    if (action === 'delete') return this.finishDelete(name);
    return { app: name, state: 'stopped', dataPreserved: true };
  }
  async shutdown() {
    this.stopping = true;
    await this.pending;
    await Promise.all([...this.children.keys()].map(name => this.stop(name)));
  }
}
