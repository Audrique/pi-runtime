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
orchestrator, permission system, and AI authorizer. All four additional plugins
(web access, questions, todos, tuicr) are installed from Nix paths, not downloaded
by Pi on startup. Configuration goes into the Nix store: never include secrets.
The module exposes `package` and `herdrPackage` overrides under
`programs.pi-runtime`; Pi's usual Home Manager settings remain available.

## Develop and update

```sh
nix flake check
nix build .#extensions
nix flake update pi-interactive-subagents pi-permission-packages
```

Each fork has its own derivation and runs its own typecheck/tests. The shared
`dependencies/package.json` and npm lockfile pin a compatible dependency set;
production dependencies are pruned separately from test tooling. Integration
checks load the installed packages, test parent/child permission routing without
credentials or live panes, check launcher arguments/environment, and start the
real Pi CLI with production dependencies only.

To update npm plugins, edit `dependencies/package.json`, then run:

```sh
nix develop -c npm install --prefix dependencies --package-lock-only --ignore-scripts --no-audit --no-fund
```

Refresh `npmDepsHash` in `nix/dependencies.nix` using Nix's reported hash, then
rerun `nix flake check`. No lockfile-repair helper is required by the current lock.
The tests do not replace a live Herdr/subagent smoke test.

Update and publish each fork first, update/test its pin here, then update this
flake's pin in dotfiles with `nix flake update pi-runtime`. Each machine fetching
this private input needs SSH access to the repository; do not put credentials in
flake URLs or configuration.
