import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";

// Exercise real extension loading, event dispatch, and parent/child transports.
// Only the model and UI are fakes: this check uses no credentials or live panes.
const childMode = process.argv.includes("--child");
function requiredExtensionPath(name) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `${name} must point to an absolute packaged extension directory`);
  return value;
}
const entry = requiredExtensionPath("PI_SUBAGENTS_EXTENSION");
const permission = requiredExtensionPath("PI_PERMISSIONS_EXTENSION");
let reviews = 0, prompts = 0;
let answer = "allow";
const model = {
  id: "reviewer", provider: "test", name: "Test reviewer", api: "openai-responses",
  baseUrl: "https://test.invalid", reasoning: false, input: ["text"], contextWindow: 100000,
  maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const registry = {
  find: (provider, id) => provider === "test" && id === "reviewer" ? model : undefined,
  getAvailable: () => [model],
  getApiKeyAndHeaders: async () => ({ ok: true }),
  getProvider: () => ({ streamSimple: () => {
    assert.equal(childMode, false, "child must never review its own asks");
    reviews++;
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: "verdict", name: "permission_verdict", arguments: { verdict: answer, reason: "Test verdict" } }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    return stream;
  } }),
};

async function start() {
  const cwd = process.env.PI_TEST_CWD;
  const session = SessionManager.create(cwd, join(process.env.PI_CODING_AGENT_DIR, "sessions"));
  session.appendMessage({ role: "user", content: "Run the local tests and print their results.", timestamp: Date.now() });
  const loaded = await discoverAndLoadExtensions([
    join(entry, childMode ? "orchestrator/index.ts" : "index.ts"),
    join(permission, "index.ts"), join(permission, "ai-authorizer/index.ts"),
  ], cwd, process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, [], "all mandatory extensions must load");
  assert.equal(loaded.extensions.length, 3);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, session, registry);
  const errors = [];
  runner.onError(error => errors.push(error));
  let tools = ["read", "write", "edit", "bash", "grep", "find", "ls", "ask_question", "subagent", "subagent_message", "subagents_list", "workflow"];
  runner.bindCore({
    sendMessage() {}, sendUserMessage() {},
    appendEntry: (type, data) => session.appendCustomEntry(type, data),
    getSessionName: () => undefined, setSessionName() {}, setLabel() {},
    getActiveTools: () => tools,
    getAllTools: () => tools.map(name => ({ name, description: name, parameters: {} })),
    setActiveTools: next => { tools = next; }, refreshTools() {},
    getCommands: () => runner.getRegisteredCommands(),
    setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {},
  }, {
    getModel: () => model, getScopedModels: () => [], isIdle: () => true,
    isProjectTrusted: () => true, getSignal: () => undefined,
    abort() {}, hasPendingMessages: () => false,
    shutdown: () => errors.push({ error: "unexpected shutdown" }),
    getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "Test",
  });
  runner.setUIContext({
    ...runner.getUIContext(),
    select: async (_title, options) => {
      assert.equal(childMode, false, "child UI must never receive permission prompts");
      prompts++;
      return options[0];
    },
    notify: (message, kind) => { if (kind === "error") errors.push({ error: message }); },
  }, "rpc");
  await runner.emit({ type: "session_start" });
  assert.deepEqual(errors, [], "session initialization must succeed");
  return {
    runner, session, errors,
    tool: command => runner.emitToolCall({ type: "tool_call", toolCallId: crypto.randomUUID(), toolName: "bash", input: { command } }),
    command: args => runner.getCommand("permissions-ai").handler(args, runner.createCommandContext()),
    stop: () => runner.emit({ type: "session_shutdown", reason: "quit" }),
  };
}

if (childMode) {
  const child = await start();
  process.send({ ready: true, sessionFile: child.session.getSessionFile() });
  process.on("message", async message => {
    try {
      if (message.stop) { await child.stop(); process.disconnect(); return; }
      const result = await child.tool(message.command);
      assert.deepEqual(child.errors, []);
      process.send({ id: message.id, result, prompts, reviews });
    } catch (error) { process.send({ id: message.id, error: String(error) }); }
  });
} else {
  const dir = mkdtempSync(join(tmpdir(), "pi-smoke-"));
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const config = JSON.parse(readFileSync(new URL("./fixtures/orchestrator.json", import.meta.url), "utf8"));
  config.reviewer = { ...config.reviewer, mode: "manual", provider: "test", model: "reviewer", reasoning: "off" };
  config.permissions.permission.bash = { "*": "ask", "git status *": "allow", "rm *": "deny" };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  Object.assign(process.env, { PI_TEST_CWD: cwd, PI_CODING_AGENT_DIR: agentDir, PI_ORCHESTRATOR_CONFIG: configPath });
  let root, worker;
  try {
    root = await start();
    assert.equal((await root.tool("git status"))?.block, undefined);
    assert.equal((await root.tool("rm forbidden"))?.block, true);
    assert.equal(reviews, 0); assert.equal(prompts, 0);
    assert.equal((await root.tool("printf root"))?.block, undefined);
    assert.equal(prompts, 1);
    const runtime = globalThis[Symbol.for("dotfiles.pi.orchestrator")];
    const lease = await runtime.reserve({ agent: "worker", name: "smoke", cwd });
    worker = fork(fileURLToPath(import.meta.url), ["--child"], { env: { ...process.env, ...lease.env }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const responses = new Map();
    const ready = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("child startup timed out")), 15000);
      worker.on("exit", code => { clearTimeout(timer); rej(new Error(`child exited ${code}`)); });
      worker.on("message", data => {
        if (data.ready) { clearTimeout(timer); res(data); }
        else responses.get(data.id)?.(data);
      });
    });
    await ready;
    const childTool = command => new Promise((res, rej) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { responses.delete(id); rej(new Error(`child tool timed out: ${command}`)); }, 15000);
      responses.set(id, data => {
        clearTimeout(timer); responses.delete(id);
        try {
          if (data.error) throw new Error(data.error);
          assert.equal(data.prompts, 0); assert.equal(data.reviews, 0);
          res(data.result);
        } catch (error) { rej(error); }
      });
      worker.send({ id, command });
    });
    assert.equal((await childTool("git status"))?.block, undefined);
    assert.equal((await childTool("rm forbidden"))?.block, true);
    assert.equal(prompts, 1); assert.equal(reviews, 0);
    assert.equal((await childTool("printf manual"))?.block, undefined);
    assert.equal(prompts, 2, "child manual ask must reach the parent UI");
    await root.command("auto");
    assert.equal((await childTool("printf auto"))?.block, undefined);
    assert.equal(prompts, 2); assert.equal(reviews, 1);
    answer = "deny";
    assert.equal((await childTool("printf declined"))?.block, true);
    answer = "defer";
    assert.equal((await childTool("printf uncertain"))?.block, undefined);
    assert.equal(prompts, 3); assert.equal(reviews, 3);
    assert.equal((await childTool("git status"))?.block, undefined);
    assert.equal((await childTool("rm forbidden"))?.block, true);
    assert.equal(reviews, 3, "allow/deny must bypass the reviewer even in auto mode");
    await root.command("manual");
    assert.equal((await childTool("printf manual-again"))?.block, undefined);
    assert.equal(prompts, 4); assert.equal(reviews, 3);
    assert.equal((await runtime.status()).totalTokens, 6);
    assert.deepEqual(root.errors, []);
    console.log("Cross-process Pi loader check passed: allow/deny, parent manual/AI approval, defer, mode switch, shared usage.");
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise(res => worker.once("exit", res));
      if (worker.connected) worker.send({ stop: true }, () => {});
      const timer = setTimeout(() => worker.kill("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await root?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
