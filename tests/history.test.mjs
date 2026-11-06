import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pty } from "./helpers/pty.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const cli = fileURLToPath(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    import.meta.url,
  ),
);
const piVersion = JSON.parse(await readFile(
  new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
  "utf8",
)).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(30);
  }
  throw new Error("native Pi picker timed out");
}
test(
  "native Pi --resume actually selects saved history; cancel or empty history never starts a new conversation",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pic-native-history-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project"),
      agent = join(root, "agent"),
      history = join(agent, "project-history"),
      empty = join(agent, "empty");
    for (const d of [project, agent, history, empty])
      await mkdir(d, { recursive: true });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        theme: "dark",
        quietStartup: true,
        enableAnalytics: false,
        lastChangelogVersion: piVersion,
      }),
    );
    const manager = SessionManager.create(project, history);
    manager.appendSessionInfo("PIC_HISTORY_FIXTURE");
    manager.appendMessage({
      role: "user",
      content: "Saved history marker",
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile(),
      before = await readFile(file, "utf8");
    // Deliberately construct the environment: no real provider keys, HOME, packages or settings.
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    if (process.env.LD_LIBRARY_PATH)
      env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    const launch = (dir) => {
      const proc = pty.spawn(
        process.execPath,
        [
          cli,
          "--resume",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
        ],
        {
          cwd: project,
          env: { ...env, PI_CODING_AGENT_SESSION_DIR: dir },
          cols: 110,
          rows: 32,
        },
      );
      let output = "",
        exited = false,
        code;
      proc.onData((d) => {
        output += d;
        if (d.includes("\x1b[6n")) proc.write("\x1b[1;1R");
      });
      proc.onExit((e) => {
        exited = true;
        code = e.exitCode;
      });
      t.after(() => {
        if (!exited) proc.kill("SIGTERM");
      });
      return {
        proc,
        get output() {
          return output;
        },
        get exited() {
          return exited;
        },
        get code() {
          return code;
        },
      };
    };
    const cancelled = launch(history);
    await wait(() => cancelled.output.includes("PIC_HISTORY_FIXTURE"));
    cancelled.proc.write("\x1b");
    await wait(() => cancelled.exited);
    assert.equal(cancelled.code, 0);
    assert.equal(await readFile(file, "utf8"), before);
    const missing = launch(empty);
    await wait(() => /No sessions|no sessions/i.test(missing.output));
    missing.proc.write("\x1b");
    await wait(() => missing.exited);
    assert.equal(missing.code, 0);
    assert.deepEqual(await readdir(empty), []);
    const restored = launch(history);
    await wait(() => restored.output.includes("PIC_HISTORY_FIXTURE"));
    restored.proc.write("\r");
    await wait(
      () =>
        /Saved history marker/.test(restored.output) &&
        /commands|No models available|providers/i.test(restored.output),
    );
    assert.equal(restored.exited, false);
    assert.deepEqual(
      (await readdir(history)).filter((x) => x.endsWith(".jsonl")),
      [file.split("/").at(-1)],
    );
    assert(
      (await readFile(file, "utf8")).startsWith(before),
      "native restore reuses the file and preserves all existing history entries; it may append runtime metadata",
    );
    restored.proc.write("/quit\r");
    await wait(() => restored.exited);
    assert.equal(restored.code, 0);
  },
);
