import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pty } from "./helpers/pty.mjs";
const tmux =
  process.env.TEST_TMUX_BINARY ||
  spawnSync("sh", ["-c", "command -v tmux"], {
    encoding: "utf8",
  }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await sleep(30);
  }
  throw new Error("wait timed out");
}
test(
  "real tmux: streaming output continues while detached; reconnect and PTY loss preserve the same process",
  {
    skip:
      !tmux || process.getuid?.() === 0
        ? "requires non-root tmux; CI installs it"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pic-live-session-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const log = join(root, "pids");
    const workspace = join(root, "project");
    await mkdir(workspace);
    const shim = `#!/usr/bin/env bash\nargs=("$@"); if [[ \${PIC_TEST_FAIL_STATE:-} == 1 && \${args[4]:-} == list-sessions ]]; then echo state-unreadable >&2; exit 1; fi; for i in "\${!args[@]}"; do if [[ "\${args[i]}" == /opt/pic/config/tmux.conf ]]; then args[i]=${JSON.stringify(resolve("config/tmux.conf"))}; fi; if [[ "\${args[i]}" == /workspace ]]; then args[i]=${JSON.stringify(workspace)}; fi; if [[ "\${args[i]}" == /opt/pic/scripts/run-pi.sh ]]; then args[i]=${JSON.stringify(resolve("scripts/run-pi.sh"))}; fi; done; exec ${JSON.stringify(tmux)} "\${args[@]}"\n`;
    await writeFile(join(bin, "tmux"), shim, { mode: 0o755 });
    await writeFile(
      join(bin, "pi"),
      [
        "#!/bin/bash",
        'echo $$ >> "$PIC_TEST_PID_LOG"',
        'printf "%s" "$*" > "$PIC_TEST_ARGS_LOG"',
        'printf "LIVE-PID:%s\\n" "$$"',
        'counter=0',
        'while true; do',
        '  if IFS= read -r -t 0.05 line; then printf "ECHO:%s\\n" "$line"; fi',
        '  counter=$((counter+1))',
        '  printf "STREAM:%s:%s\\n" "$$" "$counter"',
        '  printf "%s\\n" "$counter" > "$PIC_TEST_PROGRESS"',
        'done',
        '',
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      TMUX_TMPDIR: root,
      PIC_TEST_PID_LOG: log,
      PIC_TEST_ARGS_LOG: join(root, "argv"),
      PIC_TEST_PROGRESS: join(root, "progress"),
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PIC_PI_BOOTSTRAP_MANIFEST: join(root, "bootstrap.json"),
      TERM: "xterm-256color",
    };
    delete env.TMUX;
    await writeFile(env.PIC_PI_BOOTSTRAP_MANIFEST, '{"packages":[]}');
    const helper = resolve("scripts/pic-session.sh");
    const hostedLauncher = join(root, 'hosted-launcher.sh');
    await writeFile(hostedLauncher, (await readFile(resolve('scripts/run-pi.sh'), 'utf8')).replace('exec /usr/local/bin/pic-session "$@"', `exec bash ${JSON.stringify(helper)} "$@"`));
    await writeFile(join(root, 'bootstrap-pi.mjs'), await readFile(resolve('scripts/bootstrap-pi.mjs')));
    const run = (args, extra = {}) =>
      spawnSync("/bin/bash", args[0] === 'start' ? [hostedLauncher, '--hosted', ...args] : [helper, ...args], {
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 5000,
      });
    t.after(async () => {
      spawnSync(join(bin, "tmux"), ["-L", "pic", "kill-server"], { env });
      await rm(root, { recursive: true, force: true });
    });
    const created = run(["start", "main"]);
    assert.equal(created.status, 0, created.stderr);
    await wait(async () => !!(await readFile(log, "utf8").catch(() => "")));
    const original = await readFile(log, "utf8");
    assert.equal(original.trim().split("\n").length, 1);
    assert.equal(await readFile(env.PIC_TEST_ARGS_LOG, "utf8"), "");
    assert.equal(run(["start", "main"]).status, 1, "starting the same process twice must fail");
    const progress = async () => Number(await readFile(env.PIC_TEST_PROGRESS, "utf8").catch(() => "0"));
    await wait(async () => await progress() > 0);
    function attach() {
      const p = pty.spawn("/bin/bash", [helper, "attach", "main"], {
        cwd: workspace,
        env,
        cols: 90,
        rows: 25,
      });
      let output = "";
      p.onData((d) => (output += d));
      let exited = false;
      p.onExit(() => {
        exited = true;
      });
      return {
        p,
        get output() {
          return output;
        },
        get exited() {
          return exited;
        },
      };
    }
    const first = attach();
    await wait(() => first.output.includes(`STREAM:${original.trim()}:`));
    first.p.write("first-marker\r");
    await wait(() => first.output.includes("ECHO:first-marker"));
    first.p.write("\x02d");
    await wait(() => first.exited);
    assert.match(run(["list"]).stdout, /main\t0\t/);
    assert.equal(run(["count"]).stdout.trim(), "1");
    assert.equal(spawnSync('flock', ['-n', '-x', join(env.PI_CODING_AGENT_DIR, '.pic-packages.lock'), 'true']).status, 1, 'detached tmux Pi must retain the shared package lease');
    const detachedProgress = await progress();
    await wait(async () => await progress() > detachedProgress + 2);
    assert.equal(await readFile(log, "utf8"), original, "output must progress without a replacement process");
    const second = attach();
    await wait(() => second.output.includes(`STREAM:${original.trim()}:`));
    second.p.kill("SIGHUP");
    await wait(() => second.exited);
    await wait(() => /main\t0\t/.test(run(["list"]).stdout));
    const disconnectedProgress = await progress();
    await wait(async () => await progress() > disconnectedProgress + 2);
    const third = attach();
    await wait(() => third.output.includes(`STREAM:${original.trim()}:`));
    await wait(() => [...third.output.matchAll(/STREAM:\d+:(\d+)/g)].some(m => Number(m[1]) > disconnectedProgress));
    third.p.write("third-marker\r");
    await wait(() => third.output.includes("ECHO:third-marker"));
    assert.equal(
      await readFile(log, "utf8"),
      original,
      "must not spawn a replacement/resumed Pi",
    );
    assert.equal(run(["close", "main"]).status, 0);
    await wait(() => third.exited);
    assert.equal(run(["count"]).stdout.trim(), "0");
    await wait(() => spawnSync('flock', ['-n', '-x', join(env.PI_CODING_AGENT_DIR, '.pic-packages.lock'), 'true']).status === 0);
    assert.equal(
      run(["attach", "main"]).status,
      1,
      "missing live process never becomes a new Pi",
    );
    assert.equal(run(["count"], { PIC_TEST_FAIL_STATE: "1" }).status, 1, "unreadable process state must not look idle");
    assert.equal(run(["history", "restored"]).status, 2, "pic does not wrap native history recovery");
    assert.equal(run(["new", "conversation"]).status, 2, "pic has no conversation-level new action");
    assert.equal(await readFile(log, "utf8"), original);
    assert.equal(run(["start", "another-process"]).status, 0);
    await wait(
      async () => (await readFile(log, "utf8")).trim().split("\n").length === 2,
    );
    assert.equal(await readFile(env.PIC_TEST_ARGS_LOG, "utf8"), "");
    assert.equal(run(["close", "another-process"]).status, 0);
    await writeFile(env.PIC_PI_BOOTSTRAP_MANIFEST, JSON.stringify({packages:[{source:'git:github.com/example/not-ready'}]}));
    const blocked = spawnSync('/bin/bash', [helper, 'start', 'blocked'], {env, encoding:'utf8', timeout:5000});
    assert.equal(blocked.status, 1, 'tmux creation must report an unready plugin, not a successful Pi');
    assert.equal(run(['count']).stdout.trim(), '0');
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
  },
);
