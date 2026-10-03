# Pi runtime

Nix integration for the separate orchestration and permission forks.
This repository owns their packaging, the guarded launcher, third-party plugin
pins, and cross-plugin tests—not fork implementation or personal settings.

## Use

Add this private flake as an input using an SSH-authenticated GitHub account:

```nix
inputs.pi-runtime.url = "git+ssh://git@github.com/Audrique/pi-runtime?ref=main";
```

Then import `homeModules.default`:

```nix
{
  imports = [ inputs.pi-runtime.homeModules.default ];
  programs.pi-runtime = {
    enable = true;
    settings = builtins.fromJSON (builtins.readFile ./orchestrator.json);
  };
  programs.pi.coding-agent.settings.defaultProvider = "openai-codex";
}
```

The module wraps Pi for both parent and child processes and loads the mandatory
orchestrator, permission system, AI authorizer, and Herdr notification bridge.
The launcher supplies Herdr, Bash and Coreutils on PATH, including `mv` for
atomic subagent completion-record publication.
All four additional plugins
(web access, questions, todos, tuicr) are installed from Nix paths, not downloaded
by Pi on startup. Configuration goes into the Nix store: never include secrets.
The module exposes `package` and `herdrPackage` overrides under
`programs.pi-runtime`; Pi's usual Home Manager settings remain available.

## Herdr notifications

The launcher includes `extensions/herdr-notifications.ts`; do **not** also install
Herdr's stock Pi integration, since both would report state for the same pane.
The bridge requires Pi's `agent_settled` and `ui_prompt_start`/`ui_prompt_end`
events (introduced by Pi 0.85.1), plus the orchestration fork's
`pi-orchestrator:activity` / `pi-orchestrator:activity-request` contract.
Update the orchestration fork and runtime together.

After deploying the updated runtime, set this in Herdr's `config.toml`:

```toml
[ui.sound]
enabled = true

[ui.sound.agents]
pi = "off"

[ui.toast]
delivery = "system"
```

Then run `herdr server reload-config` and restart Pi with the updated launcher.
Mute automatic Pi sounds **only when deploying the bridge**; without the bridge,
this setting silences all Pi notifications. It also mutes automatic sounds for
Pi processes launched outside the guarded runtime. Other agent sound settings
are unchanged. Existing Herdr custom `done_path` / `request_path` sounds still
apply to the explicit notifications.

Behavior:

- Only the parent sends explicit completion and input-needed sounds, including
  when its tab is focused. Child panes still report their working/blocked/idle
  state, but do not send explicit notifications.
- Completion waits for Pi to settle (including retries and queued messages) and
  for background launches, children, workflow steps, and delivery to finish.
  No completion sound is sent merely because the parent yields to a child.
- Actual blocking UI prompts, including permission dialogs, forwarded child
  permissions, and question forms, request your attention. AI permission reviews
  and a child's question to its parent are not human-input notifications.
- Startup, session replacement, shutdown, and headless reviewer processes do not
  manufacture completion notifications. Closing an idle settings dialog does
  not count as completing work.

The bridge uses `notification.show` with Herdr's `done`/`request` sounds.
Explicit notifications require toast delivery to be enabled; `off` deliberately
mutes them. `system` requires a working desktop notification service (for example,
Dunst). `terminal` can be used if the outer terminal supports notifications.
Avoid `herdr` delivery for this setup: an existing in-app toast can block the next
notification. Herdr may still show its own **silent** background state-change
toasts, including child completions; per-agent sound muting does not disable
those toasts.

Notifications are best-effort: there must be an attached client and working
sound/desktop delivery. The bridge retries explicit `busy`, `rate_limited`, and
`no_foreground_client` replies while the event remains relevant, with a bounded
retry budget. Transport failures produce a Pi warning rather than disrupting
work; ambiguous notification timeouts are not retried to avoid duplicate sounds.
Permission arguments and question contents are never included in notification
text. A missing orchestration snapshot suppresses completion rather than
incorrectly claiming the workflow is finished.

### Verification

```sh
node --experimental-strip-types --test tests/herdr-client.test.ts tests/herdr-notifications.test.ts
nix flake check
```

After activation, test in a fresh Pi session:

1. Complete an ordinary request, both with Pi focused and with another tab focused.
2. Run a multi-step workflow: child exits and step gaps should stay quiet; the
   final parent/workflow completion should sound once.
3. Trigger a permission dialog and an `ask_user_question` form: each should sound
   when shown and clear the blocked state when answered or cancelled.
4. Exercise a child permission forwarded to the parent, then a queued follow-up.
5. Use `herdr agent explain "$HERDR_PANE_ID"` inside the pane to verify state is
   hook-reported, not just guessed from the terminal's working border.

The automated tests use mocked Pi events and local test sockets; they do not
prove audible output on a real desktop.

## Develop and update

```sh
nix flake check
nix build .#extensions
nix flake update pi-interactive-subagents pi-permission-packages
```

Each fork has its own derivation and runs its own typecheck/tests. The shared
`dependencies/package.json` and npm lockfile pin a compatible dependency set;
production dependencies are pruned separately from test tooling. npm peer
auto-installation is disabled with `--legacy-peer-deps`.

Nix owns the extension ABI through `nix/host-packages.nix`: `pi-ai`,
`pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox` come from the pinned
Pi package, including TypeBox subpath imports. `nix/dependencies.nix` fetches
unchanged npm inputs; the separate `nix/host-dependencies.nix` derivation composes
the runtime and test trees without running npm again. It normalizes host-library
declarations to wildcard peers, removes root and nested private copies, and
links the host's package roots. Genuine third-party dependencies are preserved.
The same manifest policy applies to packaged forks, without changing fork sources
or hand-editing npm lockfiles. Build-input locks remain in the fetch derivation,
not the composed runtime tree. A missing host package fails the build.

Home Manager uses `lib.mkRuntime` with `programs.pi-runtime.package`, so a host
package override supplies both the executable and its libraries. Overrides must
provide the standard Pi Nix package layout, not just a standalone executable.

Integration checks use Pi's real resource loader with package settings and
reject warnings as well as errors. The `host-packaging` check verifies manifests,
nested-copy removal, symlinks to the pinned host, and native ESM module identity
for plugins and their configuration helper. Parent/child permission routing,
launcher arguments/environment, and the production CLI are also checked without
credentials or live panes.

To update Pi, run `nix flake update pi`, then `nix flake check`. No npm Pi
version pins or npm dependency hash changes are needed for a Pi-only update.

To update npm plugins, edit `dependencies/package.json`, then run:

```sh
nix develop -c npm install --prefix dependencies --package-lock-only --ignore-scripts --legacy-peer-deps --no-audit --no-fund
```

Refresh `npmDepsHash` in `nix/dependencies.nix` using Nix's reported hash, then
rerun `nix flake check`. No lockfile-repair helper is required by the current lock.
The tests do not replace a live Herdr/subagent smoke test.

Update and publish each fork first, update/test its pin here, then update this
flake's pin in dotfiles with `nix flake update pi-runtime`. Each machine fetching
this private input needs SSH access to the repository; do not put credentials in
flake URLs or configuration.
