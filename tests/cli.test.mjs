import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pty } from "./helpers/pty.mjs";
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
    "bin/pic",
    "scripts/control.sh",
    "lib/session-lifecycle.sh",
    "lib/deployment.sh",
    "compose.yaml",
    "compose.deploy.yaml",
    "compose.services.yaml",
    ".env.example",
  ])
    await fs.copyFile(path.join(repo, f), path.join(tool, f));
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
if(args[0]==='image')process.exitCode=0;
else if(args[0]==='inspect'&&args.includes('{{.State.Running}}'))process.exitCode=1;
else if(args.includes('config')&&args.includes('--environment'))for(const k of['DEPLOY_DATA_DIR','DEPLOY_PUBLIC_URL','DEPLOY_PORT'])console.log(k+'='+(process.env[k]||''));
else if(args.includes('/usr/local/bin/deploy-register'))console.log(process.env.FAKE_HOST_KEY||${JSON.stringify(hostKey)});
else if(args.includes('up'))process.exitCode=Number(process.env.FAKE_UP_EXIT||0);
else if(args.includes('/usr/local/bin/pic-workspace-init'))process.exitCode=Number(process.env.FAKE_WORKSPACE_EXIT||0);
else if(args.includes('/usr/local/bin/pic-session')&&args.at(-1)==='count'){if(process.env.FAKE_COUNT_ERROR)process.exitCode=1;else console.log(process.env.FAKE_LIVE_PI||'0');}
else if(args.includes('/usr/local/bin/pic-session')&&args.at(-1)==='list'){if(process.env.FAKE_LIST_ERROR)process.exitCode=1;else process.stdout.write(process.env.FAKE_RUNNING||'');}
else if(args.includes('ps')&&args.includes('-q')){if(process.env.FAKE_NO_CONTAINER!=='1')console.log('fake-container');}
else if(args[0]==='inspect')console.log(process.env.FAKE_EXECS||'0');
else if(args[0]==='run')process.exitCode=Number(process.env.FAKE_RUN_EXIT||0);
else if(args.includes('exec'))process.exitCode=Number(process.env.FAKE_EXIT||0);
`,
    { mode: 0o755 },
  );
  const environment = (env = {}) => ({
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
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
    const r = spawnSync("bash", [path.join(tool, "bin/pic"), ...args], {
      cwd: project,
      encoding: "utf8",
      env: environment(env),
      timeout: 10000,
    });
    return { ...r, calls: await calls() };
  }
  async function menu(input, env = {}) {
    const proc = pty.spawn("/bin/bash", [path.join(tool, "bin/pic")], {
      cwd: project,
      env: environment(env),
      cols: 110,
      rows: 35,
    });
    let output = "";
    proc.onData((d) => (output += d));
    const exit = new Promise((resolve) => proc.onExit(resolve));
    const timeout = setTimeout(() => proc.kill("SIGTERM"), 8000);
    for (let i = 0; i < 100 && !output.includes("选择（0 返回）"); i++)
      await new Promise((r) => setTimeout(r, 15));
    proc.write(input);
    const result = await exit;
    clearTimeout(timeout);
    return { ...result, output, calls: await calls() };
  }
  return { root, tool, project, run, publicRun, menu };
}
test("public command is only pic: help and rejected old syntax have no Docker side effects", async (t) => {
  const f = await fixture(t);
  const help = await f.publicRun(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /启动并托管 Pi.*断开终端后继续运行/);
  assert.doesNotMatch(help.stdout, /恢复历史对话|开始新对话/);
  assert(!help.stdout.includes("pic attach"));
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
test("pic menu owns hosted processes, not native Pi conversation commands", async (t) => {
  const f = await fixture(t);
  const r = await f.menu("8\r0\r");
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.output, /Web|浏览器|18090|恢复历史对话|开始新对话/);
  assert.match(r.output, /请选择菜单中的编号/);
  assert.match(r.output, /接回运行中的 Pi.*同一进程/);
  assert.match(r.output, /启动并托管 Pi.*断开终端后继续运行/);
  assert.match(r.output, /结束运行中的 Pi.*停止进程/);
  assert.deepEqual(r.calls, []);
});
test("menu connects selected live process, never creates a replacement or resumes history", async (t) => {
  const f = await fixture(t);
  const r = await f.menu("1\r1\r\r0\r", {
    FAKE_RUNNING: "main\t0\t1700000000\n",
  });
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /后台运行.*没有终端连接/);
  assert(
    r.calls.some(
      (c) => c.args.slice(-3).join("|") === "--pic-session|attach|main",
    ),
  );
  assert(
    !r.calls.some((c) => c.args.includes("history") || c.args.includes("start") || c.args.includes("new")),
  );
});
test("menu launches only a hosted process; unknown running status never triggers a launch", async (t) => {
  const f = await fixture(t);
  const r = await f.menu("2\r\r0\r");
  assert.equal(r.exitCode, 0);
  assert(
    r.calls.some((c) => c.args.slice(-2).join("|") === "--pic-session|start"),
  );
  assert(!r.calls.some(c => c.args.some(arg => ["--resume", "--continue", "--model", "--thinking"].includes(arg))));
  const bad = await f.menu("1\r0\r", { FAKE_LIST_ERROR: "1" });
  assert.equal(bad.exitCode, 0);
  assert.match(bad.output, /运行状态未确认/);
  assert(!bad.calls.some((c) => c.args.includes("--pic-session")));
});
test("no running process is reported as absent, never auto-created", async (t) => {
  const f = await fixture(t);
  const r = await f.menu("1\r0\r", { FAKE_NO_CONTAINER: "1" });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /没有运行中的 Pi/);
  assert(!r.calls.some(c => c.args.includes("up") || c.args.includes("--pic-session")));
});
test("process selection and termination can be cancelled; termination requires confirmation", async (t) => {
  const f = await fixture(t);
  const env = { FAKE_RUNNING: "main\t0\t1700000000\n" };
  for (const input of ["1\r0\r0\r", "3\r1\rn\r0\r"]) {
    const cancelled = await f.menu(input, env);
    assert.equal(cancelled.exitCode, 0);
    assert(!cancelled.calls.some(c => c.args.includes("--pic-session") || c.args.includes("close")));
  }
  const ended = await f.menu("3\r1\ry\r\r0\r", env);
  assert.equal(ended.exitCode, 0);
  assert(ended.calls.some(c => c.args.slice(-3).join("|") === "/usr/local/bin/pic-session|close|main"));
  assert(!ended.calls.some(c => c.args.includes("--pic-session")));
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
      (c) => c.args.slice(-3).join("|") === "--pic-session|attach|main",
    ),
  );
  assert(!r.calls.some((c) => c.args.includes("history") || c.args.includes("start") || c.args.includes("--resume")));
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
  for (const file of ["bin/pic", "scripts/control.sh", "Dockerfile", "compose.yaml", "compose.deploy.yaml", "compose.services.yaml", "package.json", ".npmrc", "scripts/check.sh", ".github/workflows/ci.yml"]) {
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
test("host root directory is never a project bind", async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { FAKE_UID: "0" }]) {
    const r = await f.run(["pi-start"], env, "/");
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
  }
});
