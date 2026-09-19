import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Production-only smoke test: no SDK imports or test dependency links. The caller
// supplies the real packaged launcher (fixture config, agentDir=null, fake herdr).
// RPC exposes commands, not a tool inventory: command registration and clean
// initialization are checked here, not tool execution, UI, or model/provider calls.
const launcher = process.env.PI_PRODUCTION_LAUNCHER;
assert.ok(launcher && isAbsolute(launcher), "PI_PRODUCTION_LAUNCHER must be an absolute executable path");
assert.ok(process.env.PI_PLUGIN_PATHS, "PI_PLUGIN_PATHS must list four packaged plugins");
const plugins = JSON.parse(process.env.PI_PLUGIN_PATHS);
assert.ok(Array.isArray(plugins) && plugins.length === 4, "expected four plugin paths");
for (const path of plugins) assert.ok(typeof path === "string" && isAbsolute(path), "plugin paths must be absolute");
assert.equal(new Set(plugins.map(path => realpathSync(path))).size, 4, "plugin paths must be distinct and exist");

const dir = mkdtempSync(join(tmpdir(), "pi-cli-"));
const cwd = join(dir, "project");
const agentDir = join(dir, "agent");
try {
  mkdirSync(cwd);
  mkdirSync(agentDir);
  // Deliberately do not inherit credentials, router identity, NODE_PATH, or
  // NODE_OPTIONS. No dependency tree is installed or linked into this cwd.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    TMPDIR: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_DATA_HOME: join(dir, "data"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
  const args = [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    ...plugins.flatMap(path => ["-e", path]),
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", outputBytes = 0, failure;
    const responses = new Map();
    const requests = new Map([["commands", "get_commands"], ["state", "get_state"]]);
    const fail = error => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(new Error("production CLI startup/shutdown timed out after 30s")), 30000);
    const consume = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      assert.notEqual(event.type, "extension_error", `extension error: ${line}`);
      assert.notEqual(event.type, "agent_start", "smoke test must not start a model turn");
      if (event.type === "extension_ui_request") {
        assert.notEqual(event.notifyType, "error", `startup notification: ${line}`);
        assert.ok(!["select", "confirm", "input", "editor"].includes(event.method), `unexpected startup dialog: ${line}`);
      }
      if (event.type !== "response") return;
      assert.equal(event.success, true, `RPC failed: ${line}`);
      assert.equal(event.command, requests.get(event.id), `unexpected response: ${line}`);
      assert.ok(!responses.has(event.id), `duplicate response: ${event.id}`);
      responses.set(event.id, event.data);
      if (responses.size === requests.size) child.stdin.end();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      try {
        outputBytes += Buffer.byteLength(chunk);
        assert.ok(outputBytes <= 1024 * 1024, "excessive CLI output");
        stdout += chunk;
        let newline;
        // LF-only framing preserves valid Unicode separators inside JSON strings.
        while ((newline = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, newline).replace(/\r$/, "");
          stdout = stdout.slice(newline + 1);
          consume(line);
        }
      } catch (error) { fail(error); }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) fail(new Error("excessive CLI stderr"));
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        if (failure) throw failure;
        assert.equal(code, 0, `CLI exited with signal ${signal}`);
        if (stdout.trim()) consume(stdout.replace(/\r$/, ""));
        assert.doesNotMatch(stderr, /\berrors?\b|\bfailed\b|cannot find|not found/i, "CLI startup/shutdown errors");
        assert.equal(responses.size, requests.size, "CLI must answer both initialization queries");
        const commands = responses.get("commands").commands;
        for (const name of ["permissions-ai", "permission-system", "orchestrator", "workflow", "subagent"]) {
          assert.ok(commands.some(command => command.name === name && command.source === "extension"), `missing mandatory command: ${name}`);
        }
        const state = responses.get("state");
        assert.equal(state.isStreaming, false);
        assert.equal(state.isCompacting, false);
        assert.equal(state.pendingMessageCount, 0);
        assert.equal(state.messageCount, 0);
        assert.ok(!state.sessionFile, "--no-session must disable persistence");
        resolve();
      } catch (error) {
        reject(new Error(`${error.message}\nCLI stderr:\n${stderr}`, { cause: error }));
      }
    });
    for (const [id, type] of requests) child.stdin.write(`${JSON.stringify({ id, type })}\n`);
  });
  console.log("Production Pi CLI check passed: offline RPC startup, mandatory commands, four explicit plugins, idle ephemeral session, clean shutdown.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
