// Test-only real PTY using util-linux script; no native npm dependency or transcript file.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

export const pty = {
  spawn(file, args, { cwd, env, cols = 100, rows = 30 }) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
      throw new Error("Invalid test terminal dimensions");
    const command = `stty cols ${cols} rows ${rows}; exec ${[file, ...args].map(quote).join(" ")}`;
    const child = spawn(
      process.env.TEST_SCRIPT_BINARY || "script",
      ["--quiet", "--return", "--flush", "--command", command, "/dev/null"],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const events = new EventEmitter();
    let result;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => events.emit("data", d));
    child.stderr.on("data", (d) => events.emit("data", d));
    child.on("error", (e) => events.emit("data", `Test PTY failed: ${e.message}`));
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE")
        events.emit("data", `Test PTY input failed: ${e.message}`);
    });
    child.on("close", (code, signal) => {
      result = { exitCode: code ?? 128, signal };
      events.emit("exit", result);
    });
    return {
      write(data) {
        if (!child.stdin.destroyed) child.stdin.write(data);
      },
      kill(signal = "SIGHUP") {
        if (!result) child.kill(signal);
      },
      onData(fn) {
        events.on("data", fn);
      },
      onExit(fn) {
        if (result) queueMicrotask(() => fn(result));
        else events.once("exit", fn);
      },
    };
  },
};
