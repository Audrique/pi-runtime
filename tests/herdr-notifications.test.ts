import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installHerdrNotifications } from "../extensions/herdr-notifications.ts";

function fixture(options: { child?: boolean; mode?: string; handshake?: boolean; enabled?: boolean; retryDelayMs?: number } = {}) {
  const hooks = new Map<string, Function[]>();
  const listeners = new Map<string, Set<Function>>();
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  let idle = true;
  let pending = false;
  let busy = false;
  let answer = { shown: true, reason: "shown" };
  let failures = 0;
  const events = {
    on(name: string, fn: Function) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return () => { listeners.get(name)?.delete(fn); };
    },
    emit(name: string, data: unknown) { for (const fn of listeners.get(name) ?? []) fn(data); },
  };
  if (options.handshake !== false) events.on("pi-orchestrator:activity-request", () => {
    events.emit("pi-orchestrator:activity", { busy });
  });
  const pi = {
    events,
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
  };
  const ctx = {
    mode: options.mode ?? "tui", cwd: "/project",
    isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionFile: () => "/sessions/root.jsonl", getSessionId: () => "root" },
    ui: { notify: (text: string) => warnings.push(text) },
  };
  const installed = installHerdrNotifications(pi as any, {
    env: {
      HERDR_ENV: options.enabled === false ? "0" : "1", HERDR_SOCKET_PATH: "/not-a-live-socket",
      HERDR_PANE_ID: "w1:p1", PI_ORCHESTRATOR_CONFIG: "/config.json",
      PI_DOTFILES_SUBAGENT: options.child ? "1" : undefined,
    },
    settleDelayMs: 1, retryDelayMs: options.retryDelayMs ?? 1,
    request: async (_endpoint, request) => {
      requests.push(request);
      if (failures > 0) { failures--; throw new Error("test disconnect"); }
      return request.method === "notification.show" ? answer : {};
    },
  });
  return {
    requests, warnings, ctx, events, listeners,
    setIdle(value: boolean) { idle = value; },
    setPending(value: boolean) { pending = value; },
    setAnswer(value: typeof answer) { answer = value; },
    failRequests(count: number) { failures = count; },
    activity(value: boolean) { busy = value; events.emit("pi-orchestrator:activity", { busy }); },
    async emit(name: string, data: unknown = {}) {
      for (const fn of hooks.get(name) ?? []) await fn(data, ctx);
      await installed?.flush();
    },
    async drain() { await delay(10); await installed?.flush(); },
    notifications() { return requests.filter(r => r.method === "notification.show"); },
    state() { return requests.filter(r => r.method === "pane.report_agent").at(-1)?.params.state; },
  };
}

async function start(f: ReturnType<typeof fixture>) {
  await f.emit("session_start", { reason: "startup" });
  f.setIdle(false);
  await f.emit("agent_start");
}

async function settle(f: ReturnType<typeof fixture>) {
  f.setIdle(true);
  await f.emit("agent_settled");
  await f.drain();
}

test("startup is silent; only fully settled root completion sounds once", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  await f.drain();
  assert.equal(f.notifications().length, 0);
  assert.equal(f.state(), "idle");
  await start(f);
  await f.emit("agent_end");
  assert.equal(f.notifications().length, 0);
  assert.equal(f.state(), "working");
  await settle(f);
  assert.deepEqual(f.notifications().map(r => r.params.sound), ["done"]);
  await f.emit("agent_settled");
  await f.drain();
  assert.equal(f.notifications().length, 1);
  await f.emit("session_shutdown");
});

test("workflow step gaps and child delivery do not finish the parent", async () => {
  const f = fixture();
  await start(f);
  f.activity(true);
  await settle(f);
  assert.equal(f.state(), "working");
  assert.equal(f.notifications().length, 0);
  // Completion is queued before the background hold is released.
  f.setPending(true);
  f.activity(false);
  await f.drain();
  assert.equal(f.notifications().length, 0);
  f.setPending(false);
  f.setIdle(false);
  await f.emit("agent_start");
  await settle(f);
  assert.deepEqual(f.notifications().map(r => r.params.sound), ["done"]);
  await f.emit("session_shutdown");
});

test("deferred result agent_start cancels pending completion", async () => {
  const f = fixture();
  await start(f);
  f.activity(true);
  await settle(f);
  f.activity(false);
  f.setIdle(false);
  await f.emit("agent_start");
  await f.drain();
  assert.equal(f.notifications().length, 0);
  await settle(f);
  assert.equal(f.notifications().length, 1);
  await f.emit("session_shutdown");
});

test("permissions and questions use actual UI spans, not tool names or AI reviews", async () => {
  const f = fixture();
  await start(f);
  await f.emit("tool_execution_start", { toolName: "bash" });
  assert.equal(f.notifications().length, 0);
  await f.emit("ui_prompt_start", { kind: "custom", title: "secret permission arguments" });
  assert.equal(f.state(), "blocked");
  assert.deepEqual(f.notifications().map(r => r.params.sound), ["request"]);
  assert.ok(!JSON.stringify(f.notifications()).includes("secret"));
  await f.emit("ui_prompt_start"); // Defensive dedup; Pi coalesces nested UI already.
  assert.equal(f.notifications().length, 1);
  await f.emit("ui_prompt_end");
  assert.equal(f.state(), "working");
  await f.emit("ui_prompt_start", { kind: "custom" }); // ask_user_question
  await f.emit("ui_prompt_end");
  await settle(f);
  assert.deepEqual(f.notifications().map(r => r.params.sound), ["request", "request", "done"]);
  await f.emit("session_shutdown");
});

test("forwarded prompt while root waits on children still requests input", async () => {
  const f = fixture();
  await start(f);
  f.activity(true);
  await settle(f);
  await f.emit("ui_prompt_start");
  assert.equal(f.state(), "blocked");
  await f.emit("ui_prompt_end");
  assert.equal(f.state(), "working");
  assert.deepEqual(f.notifications().map(r => r.params.sound), ["request"]);
  await f.emit("session_shutdown");
});

test("idle settings UI does not manufacture a completion notification", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  await f.emit("ui_prompt_start");
  await f.emit("ui_prompt_end");
  await f.drain();
  assert.deepEqual(f.notifications().map(r => r.params.sound), ["request"]);
  await f.emit("session_shutdown");
});

test("children report state/session but never send sounds", async () => {
  const f = fixture({ child: true });
  await start(f);
  await f.emit("ui_prompt_start");
  await f.emit("ui_prompt_end");
  await settle(f);
  assert.equal(f.state(), "idle");
  assert.equal(f.requests[0].method, "pane.report_agent_session");
  assert.equal(f.notifications().length, 0);
  await f.emit("session_shutdown");
});

test("headless/non-Herdr processes never report or notify", async () => {
  for (const options of [{ enabled: false }, { mode: "rpc" }, { mode: "json" }, { mode: "print" }]) {
    const f = fixture(options);
    await start(f);
    f.activity(true);
    await f.emit("ui_prompt_start");
    await settle(f);
    assert.equal(f.requests.length, 0);
    await f.emit("session_shutdown");
  }
});

test("missing lifecycle producer fails closed, late snapshot releases it", async () => {
  const f = fixture({ handshake: false });
  await start(f);
  await settle(f);
  assert.equal(f.notifications().length, 0);
  assert.equal(f.state(), "working");
  assert.match(f.warnings[0], /activity API is unavailable/);
  f.activity(false);
  await f.drain();
  assert.equal(f.notifications().length, 1);
  await f.emit("session_shutdown");
});

test("shutdown cancels completion and unsubscribes activity", async () => {
  const f = fixture();
  await start(f);
  f.setIdle(true);
  await f.emit("agent_settled");
  await f.emit("session_shutdown", { reason: "reload" });
  f.activity(true);
  await f.emit("ui_prompt_start");
  await f.drain();
  assert.equal(f.notifications().length, 0);
  assert.equal(f.listeners.get("pi-orchestrator:activity")?.size, 0);
});

test("disabled notifications are respected; rate limiting retries are bounded", async () => {
  const f = fixture();
  await start(f);
  f.setAnswer({ shown: false, reason: "disabled" });
  await f.emit("ui_prompt_start");
  assert.equal(f.notifications().length, 1);
  assert.equal(f.warnings.length, 0);
  await f.emit("ui_prompt_end");
  f.setAnswer({ shown: false, reason: "rate_limited" });
  await f.emit("ui_prompt_start");
  assert.equal(f.notifications().length, 5);
  assert.equal(f.warnings.length, 1);
  await f.emit("session_shutdown");
});

test("transient report failure retries the same sequence and later completion still works", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  f.failRequests(1);
  f.setIdle(false);
  await f.emit("agent_start");
  const reports = f.requests.filter(r => r.method === "pane.report_agent");
  assert.deepEqual(reports.at(-1), reports.at(-2));
  assert.equal(f.warnings.length, 0);
  await settle(f);
  assert.equal(f.notifications().length, 1);
  await f.emit("session_shutdown");
});

test("transport failure warns without breaking future state or notification delivery", async () => {
  const f = fixture();
  await start(f);
  f.failRequests(3); // Both state attempts plus the non-retried explicit notification.
  await f.emit("ui_prompt_start");
  assert.equal(f.warnings.length, 1);
  await f.emit("ui_prompt_end");
  await settle(f);
  assert.equal(f.notifications().at(-1)?.params.sound, "done");
  await f.emit("session_shutdown");
});

test("an answered question cancels its rate-limited sound instead of sounding late", async () => {
  const f = fixture({ retryDelayMs: 25 });
  await start(f);
  f.setAnswer({ shown: false, reason: "rate_limited" });
  const opening = f.emit("ui_prompt_start");
  await delay(5);
  const closing = f.emit("ui_prompt_end");
  await Promise.all([opening, closing]);
  assert.equal(f.notifications().length, 1);
  assert.equal(f.warnings.length, 0);
  await f.emit("session_shutdown");
});

test("Pi's replacement factory reports and sounds after the old instance is shut down", async () => {
  const old = fixture();
  await start(old);
  await old.emit("session_shutdown", { reason: "new" });
  // Pi reloads and rebinds extension factories on /new, /resume, /fork and /reload.
  const replacement = fixture();
  await replacement.emit("session_start", { reason: "new" });
  await replacement.drain();
  assert.equal(replacement.notifications().length, 0);
  replacement.setIdle(false);
  await replacement.emit("agent_start");
  await settle(replacement);
  assert.equal(replacement.notifications().length, 1);
  assert.equal(old.notifications().length, 0);
  await replacement.emit("session_shutdown");
});

test("reload mid-run seeds activity from Pi without manufacturing startup completion", async () => {
  const f = fixture();
  f.setIdle(false);
  await f.emit("session_start", { reason: "reload" });
  await f.drain();
  assert.equal(f.state(), "working");
  assert.equal(f.notifications().length, 0);
  await settle(f);
  assert.equal(f.notifications().length, 1);
  await f.emit("session_shutdown");
});
