import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";
import { requestHerdr, type HerdrRequest } from "./herdr-client.ts";

type State = "working" | "blocked" | "idle";
type Options = {
  env?: NodeJS.ProcessEnv;
  request?: typeof requestHerdr;
  settleDelayMs?: number;
  retryDelayMs?: number;
};

/** Pair with ui.sound.agents.pi = "off": only the root sends explicit sounds. */
export function installHerdrNotifications(pi: ExtensionAPI, options: Options = {}) {
  const env = options.env ?? process.env;
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socketPath || !paneId) return;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const child = env.PI_DOTFILES_SUBAGENT === "1";
  const managed = !!env.PI_ORCHESTRATOR_CONFIG;
  const request = options.request ?? requestHerdr;
  let context: ExtensionContext | undefined;
  let active = false;
  let blocked = false;
  let backgroundBusy = false;
  let activityKnown = child || !managed;
  let armed = false;
  let state: State | undefined;
  let revision = 0;
  let sequence = Date.now() * 1000;
  let stopped = false;
  let warned = false;
  const abort = new AbortController();
  let queue = Promise.resolve();
  let completionTimer: ReturnType<typeof setTimeout> | undefined;

  const desired = (): State => blocked ? "blocked"
    : active || backgroundBusy || !activityKnown || context?.isIdle() === false
      || context?.hasPendingMessages() ? "working" : "idle";

  function warn() {
    if (warned || stopped) return;
    warned = true;
    context?.ui.notify("Herdr notification delivery failed. Check Herdr's connection and notification settings.", "warning");
  }

  function enqueue(task: () => Promise<void>) {
    queue = queue.then(async () => {
      if (!stopped) await task();
    }).catch(warn);
  }

  function send(method: string, params: HerdrRequest["params"]) {
    return request(endpoint, { method, params }, abort.signal);
  }

  function sessionRef() {
    const file = context?.sessionManager.getSessionFile();
    return file ? { agent_session_path: file }
      : { agent_session_id: context?.sessionManager.getSessionId() };
  }

  function publish(force = false) {
    if (!context || stopped) return;
    const next = desired();
    if (!force && next === state) return;
    state = next;
    revision++;
    const params = {
      pane_id: paneId, source: "herdr:pi", agent: "pi", state: next,
      seq: ++sequence, ...sessionRef(),
    };
    enqueue(async () => {
      // Reports are idempotent for this sequence; retry a transient disconnect once.
      try { await send("pane.report_agent", params); }
      catch {
        if (stopped) return;
        await send("pane.report_agent", params);
      }
    });
  }

  function notify(sound: "done" | "request") {
    if (child) return;
    const expected = revision;
    const relevant = () => !stopped && expected === revision
      && desired() === (sound === "done" ? "idle" : "blocked");
    enqueue(async () => {
      for (let attempt = 0; attempt < 4 && relevant(); attempt++) {
        // Generic text deliberately excludes permission arguments and prompt contents.
        const result = await send("notification.show", {
          title: sound === "done" ? "Pi finished" : "Pi needs your input",
          body: `${context?.cwd ?? ""} · ${paneId}`, sound,
        });
        if (result.shown === true || result.reason === "disabled") return;
        if (!["busy", "rate_limited", "no_foreground_client"].includes(String(result.reason))) break;
        if (attempt < 3) await delay(options.retryDelayMs ?? 1000, undefined, { signal: abort.signal });
      }
      if (relevant()) warn();
    });
  }

  function cancelCompletion() {
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = undefined;
  }

  function reconcile() {
    cancelCompletion();
    if (!context || stopped) return;
    if (child || !armed || desired() !== "idle") {
      publish();
      return;
    }
    // Let a queued child/workflow result start Pi before reporting idle or sounding.
    completionTimer = setTimeout(() => {
      completionTimer = undefined;
      if (stopped || !armed || desired() !== "idle") return;
      armed = false;
      publish();
      notify("done");
    }, options.settleDelayMs ?? 100);
    completionTimer.unref?.();
  }

  const unsubscribe = pi.events.on("pi-orchestrator:activity", (raw) => {
    if (child || stopped || !raw || typeof raw !== "object" || !("busy" in raw)
      || typeof raw.busy !== "boolean") return;
    activityKnown = true;
    backgroundBusy = raw.busy;
    if (backgroundBusy && context) armed = true;
    reconcile();
  });

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui" || stopped) return;
    context = ctx;
    active = !ctx.isIdle() || ctx.hasPendingMessages();
    armed = active || backgroundBusy;
    // Subscribe above before requesting, so load order cannot lose the snapshot.
    if (!child && managed) pi.events.emit("pi-orchestrator:activity-request", {});
    if (!activityKnown) ctx.ui.notify(
      "Herdr completion sounds are paused: the orchestrator activity API is unavailable. Update the orchestration fork and runtime together.",
      "warning",
    );
    const params = {
      pane_id: paneId, source: "herdr:pi", agent: "pi", seq: ++sequence,
      session_start_source: event.reason, ...sessionRef(),
    };
    enqueue(async () => { await send("pane.report_agent_session", params); });
    publish(true);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!context || stopped) return;
    context = ctx;
    active = true;
    armed = true;
    reconcile();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!context || stopped || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    context = ctx;
    active = false;
    reconcile();
  });
  pi.on("ui_prompt_start", () => {
    if (!context || stopped || blocked) return;
    blocked = true;
    reconcile();
    notify("request");
  });
  pi.on("ui_prompt_end", () => {
    if (!context || stopped) return;
    blocked = false;
    reconcile();
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    armed = false;
    cancelCompletion();
    abort.abort();
    unsubscribe();
    context = undefined;
  });

  // Useful for deterministic transport tests; not a Pi tool or user-facing API.
  return { flush: () => queue };
}

export default function (pi: ExtensionAPI) {
  installHerdrNotifications(pi);
}
