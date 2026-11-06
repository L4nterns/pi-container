import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pty } from "./helpers/pty.mjs";
const up = "\x1b[A", down = "\x1b[B", esc = "\x1b", home = "\x1b[H";
const select = index => home + down.repeat(index) + "\r";
const exitMenu = select(0);
const menuHint = "「↑/↓」选择 · 「Enter」确认 · 「Esc」返回";
const menus = (...inputs) => inputs.map(keys => [menuHint, keys]);
const pause = ['「PgUp/PgDn」翻页 · 「Esc」返回', esc];
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
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({args,workspace:process.env.PIC_WORKSPACE,uid:process.env.PIC_UID,gid:process.env.PIC_GID,groups:process.env.PIC_GROUPS,history:process.env.PIC_HISTORY_DIR,image:process.env.PIC_IMAGE,deployData:process.env.DEPLOY_DATA_DIR})+'\\n');
if(args[0]==='image'){if(args.includes('inspect'))console.log(process.env.FAKE_BUILT_IMAGE||'sha256:built');}
else if(args[0]==='inspect'&&args.some(a=>a.includes('.Mounts')))console.log(process.env.PIC_WORKSPACE);
else if(args[0]==='inspect'&&args.some(a=>a.includes('.Config.Labels')))console.log('pic-r'+process.env.PIC_IMAGE.split(':r')[1]+'-u'+(process.env.FAKE_UID||'1000')+'-0123456789abcdef');
else if(args[0]==='inspect'&&args.includes('{{.Image}}'))console.log(process.env.FAKE_CURRENT_IMAGE||'sha256:built');
else if(args[0]==='inspect'&&args.some(a=>a.includes('.HostConfig.RestartPolicy.Name')))console.log('当前实际重启策略：unless-stopped');
else if(args.includes('pi')&&args.at(-1)==='--version')console.log('1.5.0');
else if(args.includes('rev-parse'))console.log('synthetic-gateway-commit');
else if(args[0]==='inspect'&&args.includes('{{.State.Running}}'))process.exitCode=1;
else if(args.includes('config')&&args.includes('--environment')){if(process.env.FAKE_CONFIG_ERROR)process.exitCode=72;else for(const k of['DEPLOY_DATA_DIR','DEPLOY_PUBLIC_URL','DEPLOY_PORT'])console.log(k+'='+(process.env[k]||''));}
else if(args.includes('/usr/local/bin/deploy-apps')){if(process.env.FAKE_APP_ERROR)process.exitCode=75;else if(args.at(-1)==='list')process.stdout.write(process.env.FAKE_APPS||'');}
else if(args.includes('/usr/local/bin/deploy-register'))console.log(process.env.FAKE_HOST_KEY||${JSON.stringify(hostKey)});
else if(args.includes('build'))process.exitCode=Number(process.env.FAKE_BUILD_EXIT||0);
else if(args.includes('up'))process.exitCode=Number(process.env.FAKE_UP_EXIT||0);
else if(args.includes('/usr/local/bin/pic-workspace-init'))process.exitCode=Number(process.env.FAKE_WORKSPACE_EXIT||0);
else if(args.includes('/usr/local/bin/pic-session')&&args.at(-1)==='count'){if(process.env.FAKE_COUNT_ERROR)process.exitCode=1;else console.log(process.env.FAKE_LIVE_PI||'0');}
else if(args.includes('/usr/local/bin/pic-session')&&args.at(-1)==='list'){if(process.env.FAKE_LIST_ERROR)process.exitCode=1;else process.stdout.write(process.env.FAKE_RUNNING||'');}
else if(args.includes('logs'))console.log(process.env.FAKE_LOG_OUTPUT||'startup ready\\napplication error: synthetic diagnostic');
else if(args[0]==='ps'&&args.includes('-aq')){if(process.env.FAKE_MANAGED)console.log('managed-container');}
else if(args.includes('ps')&&!args.includes('-q')&&!args.includes('-aq'))console.log('SERVICE  STATE    STATUS\\n'+(args.includes('services')?'services':'pi')+'       running  Up');
else if(args.includes('ps')&&(args.includes('-q')||args.includes('-aq'))){if(process.env.FAKE_PS_ERROR)process.exitCode=73;else if(process.env.FAKE_NO_CONTAINER!=='1')console.log('fake-container');}
else if(args[0]==='inspect')console.log(process.env.FAKE_EXECS||'0');
else if(process.env.FAKE_INTERACTIVE==='1'&&(args[0]==='run'||args.includes('--dev-shell'))){console.log('SHELL-READY');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line==='exit')process.exit(0);});}
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
      env: environment(env),
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
        proc.write(keys);
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
  assert.deepEqual(await f.calls(), []);
});
test("pi-container menu owns hosted processes, not native Pi conversation commands", async (t) => {
  const f = await fixture(t);
  const r = await f.menu(menus("8" + exitMenu));
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.output, /Web|浏览器|18090|恢复历史对话|开始新对话/);
  assert.match(r.output, /「↑\/↓」选择.*「Enter」确认.*「Esc」返回/);
  assert.doesNotMatch(r.output, /\d\) |请选择菜单中的编号/);
  assert.match(r.output, /接回 Pi.*继续原进程/);
  assert.match(r.output, /启动 Pi.*断开终端后继续运行/);
  assert.match(r.output, /结束 Pi.*停止进程/);
  assert.deepEqual(r.calls, []);
});
test("menu connects selected live process, never creates a replacement or resumes history", async (t) => {
  const f = await fixture(t);
  const r = await f.menu(menus(select(1), select(1), exitMenu), {
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
  const r = await f.menu(menus(select(2), exitMenu));
  assert.equal(r.exitCode, 0);
  assert(
    r.calls.some((c) => c.args.slice(-2).join("|") === "--pic-session|start"),
  );
  assert(!r.calls.some(c => c.args.some(arg => ["--resume", "--continue", "--model", "--thinking"].includes(arg))));
  const bad = await f.menu([...menus(select(1)), pause, ...menus(exitMenu)], { FAKE_LIST_ERROR: "1" });
  assert.equal(bad.exitCode, 0);
  assert.match(bad.output, /查询失败/);
  const errorAt = bad.output.indexOf('查询失败'), ackAt = bad.output.indexOf('「Esc」返回', errorAt);
  assert(ackAt > errorAt && !bad.output.slice(errorAt, ackAt).includes('\x1b[?1049l'), 'error remains in the same exclusive screen until Esc');
  assert(!bad.calls.some((c) => c.args.includes("--pic-session")));
});
test("no running process is reported as absent, never auto-created", async (t) => {
  const f = await fixture(t);
  const r = await f.menu([...menus(select(1)), pause, ...menus(exitMenu)], { FAKE_NO_CONTAINER: "1" });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /暂无运行中的 Pi/);
  assert(!r.calls.some(c => c.args.includes("up") || c.args.includes("--pic-session")));
});
test("process selection and termination can be cancelled; termination requires confirmation", async (t) => {
  const f = await fixture(t);
  const env = { FAKE_RUNNING: "main\t0\t1700000000\n" };
  for (const steps of [menus(select(1), exitMenu, exitMenu), menus(select(3), select(1), '\r', exitMenu)]) {
    const cancelled = await f.menu(steps, env);
    assert.equal(cancelled.exitCode, 0);
    assert(!cancelled.calls.some(c => c.args.includes("--pic-session") || c.args.includes("close")));
  }
  const ended = await f.menu(menus(select(3), select(1), select(1), exitMenu), env);
  assert.equal(ended.exitCode, 0);
  assert(ended.calls.some(c => c.args.slice(-3).join("|") === "/usr/local/bin/pic-session|close|main"));
  assert(!ended.calls.some(c => c.args.includes("--pic-session")));
});
test("arrow menus cover service management, default-cancel confirmation and Escape without number shortcuts", async t => {
  const f = await fixture(t);
  const cancelled = await f.menu(menus(select(6), select(8), '\r', esc, esc), { DEPLOY_DATA_DIR: './services-data' });
  assert.equal(cancelled.exitCode, 0, cancelled.output);
  assert.deepEqual(cancelled.calls, [], 'confirmation defaults to cancel; Escape returns without a side effect');
  const state = await f.menu([...menus(select(6), select(1)), pause, ...menus(esc, esc)], { DEPLOY_DATA_DIR: './services-data' });
  assert.equal(state.exitCode, 0, state.output);
  assert(state.calls.some(c => c.args.includes('ps')));
  const restored = await f.menu(menus(select(6), select(8), select(1), esc, esc), { DEPLOY_DATA_DIR: './services-data' });
  assert(restored.calls.some(c => c.args.includes('stop') && c.args.includes('services')));
  const second = await f.menu(menus(select(1), select(2), up + '\r'), { FAKE_RUNNING: 'first\t0\t1700000000\nsecond\t0\t1700000001\n' });
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
  assert.deepEqual(await fs.readdir(path.join(f.tool, ".runtime", projects[0])), ["lifecycle.lock"], "ordinary terminal lease is released after attach exits");
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
    assert.match(r.stdout, /镜像构建完成.*重建容器.*现有容器仍使用原镜像/);
  }
  const menu = await f.menu([...menus(select(5), select(5)), ['「Enter」下一项／空行开始', '\r'], pause, ...menus(exitMenu, exitMenu)]);
  assert.equal(menu.exitCode, 0, menu.output);
  assert.match(menu.output, /重建容器.*使用已构建镜像/);
  assert.match(menu.output, /镜像构建完成/);
  assert.equal(menu.calls.length, 1);
  assert(menu.calls[0].args.includes("--no-cache"));
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
test('menu positions survive operations and submenu returns only in the current invocation', async t => {
  const f = await fixture(t);
  const r = await f.menu([
    ...menus(select(5), select(5)), ['「Enter」下一项／空行开始', '\r'], pause,
    ...menus(esc, '\r', '\r'), ['「Enter」下一项／空行开始', '\r'], pause, ...menus(esc, exitMenu),
  ]);
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(r.calls.filter(c => c.args.includes('build') && c.args.includes('--no-cache')).length, 2, 'main and dev positions are retained');
  const fresh = await f.menu(menus(select(1), esc, exitMenu), { FAKE_RUNNING: 'main\t0\t1700000000\n' });
  assert(fresh.calls.some(c => c.args.at(-1) === 'list'), 'a fresh invocation starts at the first item, Exit');
});

test('app autostart menu is persistent-policy-only and defaults to cancel', async t => {
  const f = await fixture(t), revision = 'a'.repeat(64);
  const env = { DEPLOY_DATA_DIR: './services-data', FAKE_APPS: `demo\ttrue\t${revision}\n` };
  const r = await f.menu([
    ...menus(select(6), select(10), select(1), select(2), select(1), esc, esc, esc),
  ], env);
  assert.equal(r.exitCode, 0, r.output);
  const set = r.calls.find(c => c.args.includes('/usr/local/bin/deploy-apps') && c.args.includes('set'));
  assert(set); assert.deepEqual(set.args.slice(-4), ['set', 'demo', 'false', revision]);
  assert.match(r.output, /不.*当前进程|当前进程不变/);
  assert(!r.calls.some(c => c.args.some(arg => ['up', 'run', 'start', 'stop', 'restart', 'update', 'reread'].includes(arg))));
  await assert.rejects(fs.access(path.join(f.tool, 'services-data')), { code: 'ENOENT' });
  const cancel = await f.menu(menus(select(6), select(10), select(1), select(2), '\r', esc, esc, esc), env);
  assert(!cancel.calls.some(c => c.args.includes('set')));
});

test('app policy query errors and missing service stay visible and never start a container', async t => {
  const f = await fixture(t);
  for (const extra of [{ FAKE_NO_CONTAINER: '1' }, { FAKE_APP_ERROR: '1' }, { FAKE_APPS: 'invalid\n' }]) {
    const r = await f.menu([...menus(select(6), select(10)), pause, ...menus(esc, esc)], { DEPLOY_DATA_DIR: './services-data', ...extra });
    assert.equal(r.exitCode, 0, r.output);
    assert(!r.calls.some(c => c.args.includes('up') || c.args.includes('set')));
    assert.match(r.output, /读取失败|格式错误/);
  }
  const malformed = await f.menu([...menus(select(1)), pause, ...menus(exitMenu)], { FAKE_RUNNING: 'not-valid\n' });
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
  assert.match(r.stdout, /镜像：有新镜像/); assert.match(r.stdout, /Pi 版本：1.5.0/);
  assert.match(r.stdout, /synthetic-gateway-commit/);
  assert(!r.calls.some(c => c.args.some(a => ['up', 'config', 'build', 'install', 'update'].includes(a))));
  const absent = await f.run(['dev-state'], { FAKE_NO_CONTAINER: '1' });
  assert.match(absent.stdout, /容器：未运行/);
  assert(!absent.calls.some(c => c.args.includes('exec')));
});

test('the entire menu tree shares aligned labels, common container order and Back as its first item', async t => {
  const f = await fixture(t);
  const r = await f.menu(menus(select(5), esc, select(6), esc, exitMenu));
  assert.equal(r.exitCode, 0, r.output);
  const plain = r.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
  const common = ['查看状态', '管理终端', '查看日志', '构建镜像', '无缓存构建', '重建容器', '停止容器', '删除容器'];
  for (const kind of ['开发容器', '服务容器']) {
    const frame = r.output.replaceAll('\r', '').split('\x1b[H\x1b[2J').find(s => s.startsWith(kind + '\n'));
    assert(frame?.includes('> \x1b[7m返回'), `${kind}: Back is first and initially selected`);
    let position = 0;
    for (const label of common) { const next = frame.indexOf(label, position); assert(next > position); position = next; }
  }
  for (const line of plain.split('\n').filter(s => /^(?:  |> )(?:接回 Pi|启动 Pi|开发容器|服务容器|无缓存构建|查看状态|管理终端|查看日志|应用自启动)\s/.test(s))) {
    const prefix = /^(?:  |> )\S+(?: Pi)?\s+/.exec(line)?.[0];
    assert(prefix, line);
    const width = [...prefix].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    assert.equal(width, 20, line);
  }
  assert.equal((r.output.match(/\x1b\[\?1049h/g) || []).length, 1);
  assert.equal((r.output.match(/\x1b\[\?1049l/g) || []).length, 1);
  assert.deepEqual(r.calls, []);
});

test('status, logs, builds and errors remain in one exclusive screen until Esc returns', async t => {
  const f = await fixture(t);
  const r = await f.menu([
    ...menus(select(5), select(1)), pause,
    ...menus(select(3)), pause,
    ...menus(select(4)), ['「Enter」下一项／空行开始', '\r'], pause,
    ...menus(esc, select(1)), pause, ...menus(exitMenu),
  ], { FAKE_LIST_ERROR: '1' });
  assert.equal(r.exitCode, 0, r.output);
  assert.equal((r.output.match(/\x1b\[\?1049h/g) || []).length, 1);
  assert.equal((r.output.match(/\x1b\[\?1049l/g) || []).length, 1);
  assert.doesNotMatch(r.output, /按回车返回|sha256:|\{"/);
  assert.match(r.output, /application error: synthetic diagnostic/);
  assert.match(r.output, /查询失败/);
});

test('normal Shell exit returns directly to the same menu, without a results page or extra key', async t => {
  const f = await fixture(t);
  for (const entry of [4, 5, 6]) {
    const r = await f.menu([
      ...menus(select(entry)), ...(entry === 4 ? [] : menus(select(2))),
      ['SHELL-READY', 'exit\r'],
      ...menus(...(entry === 4 ? [] : [esc]), exitMenu),
    ], { FAKE_INTERACTIVE: '1', DEPLOY_DATA_DIR: './services-data' });
    assert.equal(r.exitCode, 0, r.output);
    assert.doesNotMatch(r.output, /PgUp\/PgDn|按回车返回|连接已结束/);
    const after = r.output.slice(r.output.indexOf('SHELL-READY'));
    if (entry !== 4) assert(after.includes(`\x1b[H\x1b[2J${entry === 5 ? '开发' : '服务'}容器`));
    assert.equal((r.output.match(/\x1b\[\?1049h/g) || []).length, 2);
    assert.equal((r.output.match(/\x1b\[\?1049l/g) || []).length, 2);
  }
});

test('both containers use readable state and prefix-free bounded logs without startup side effects', async t => {
  const f = await fixture(t);
  for (const kind of ['dev', 'service']) {
    const env = { DEPLOY_DATA_DIR: './services-data' };
    const state = await f.run([`${kind}-state`], env);
    assert.equal(state.status, 0, state.stderr);
    assert.doesNotMatch(state.stdout, /sha256:|\{"|fake-container/);
    assert(state.calls.some(c => c.args.includes('--format') && c.args.some(a => a.startsWith('table '))));
    const logs = await f.run([`${kind}-logs`], env);
    assert.equal(logs.status, 0, logs.stderr);
    assert.match(logs.stdout, /application error/);
    const call = logs.calls.find(c => c.args.includes('logs'));
    assert.deepEqual(call.args.slice(-6), ['logs', '--no-color', '--no-log-prefix', '--tail', '200', kind === 'dev' ? 'pi' : 'services']);
    assert(![...state.calls, ...logs.calls].some(c => c.args.some(a => ['up', 'build', 'install', 'update'].includes(a))));
  }
  const all = await f.run(['dev-list'], { FAKE_MANAGED: '1' });
  assert.equal(all.status, 0, all.stderr);
  assert(all.stdout.includes(`项目目录：${f.project}`));
  assert.doesNotMatch(all.stdout, /pic-r|0123456789abcdef|managed-container|sha256:/);
});

test('build forms cancel without Docker and use identical optional arguments for both images', async t => {
  const f = await fixture(t);
  for (const [entry, kind] of [[5, 'dev'], [6, 'service']]) {
    const cancelled = await f.menu([...menus(select(entry), select(4)), ['「Enter」下一项／空行开始', esc], ...menus(esc, esc)]);
    assert.deepEqual(cancelled.calls, []);
    const built = await f.menu([
      ...menus(select(entry), select(5)), ['「Enter」下一项／空行开始', 'OPTION=value\r'],
      ['「Enter」下一项／空行开始', '\r'], pause, ...menus(esc, esc),
    ], { DEPLOY_DATA_DIR: './services-data' });
    assert.equal(built.exitCode, 0, built.output);
    const call = built.calls.find(c => c.args.includes('build'));
    assert.deepEqual(call.args.slice(-5), ['build', '--no-cache', '--build-arg', 'OPTION=value', kind === 'dev' ? 'pi' : 'services']);
    assert(!built.calls.some(c => c.args.some(a => ['up', '--force-recreate', 'install', 'update'].includes(a))));
  }
  const temporary = path.join(f.root, 'output-tmp'); await fs.mkdir(temporary);
  const failed = await f.menu([
    ...menus(select(5), select(4)), ['「Enter」下一项／空行开始', '\r'], pause, ...menus(esc, esc),
  ], { TMPDIR: temporary, FAKE_BUILD_EXIT: '74' });
  assert.match(failed.output, /操作失败.*退出码：74/);
  assert.doesNotMatch(failed.output, /镜像构建完成|「已完成」/);
  assert.deepEqual(await fs.readdir(temporary), [], 'private output files are removed after a failed operation');
});

test("host root directory is never a project bind", async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { FAKE_UID: "0" }]) {
    const r = await f.run(["pi-start"], env, "/");
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
  }
});
