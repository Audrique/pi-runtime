{ inputs, self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi-runtime;
  runtime = self.lib.mkRuntime {
    system = pkgs.stdenv.hostPlatform.system;
    pi = cfg.package;
  };
  configFile = pkgs.writeText "pi-orchestrator.json" (builtins.toJSON cfg.settings);
  mkLauncher = pkgs.callPackage ./launcher.nix { };
  plugins = runtime.plugins;
  launcher = mkLauncher {
    pi = cfg.package;
    herdr = cfg.herdrPackage;
    inherit (runtime.extensions) subagents permissions;
    inherit plugins configFile;
    agentDir = "${config.home.homeDirectory}/.pi/agent";
  };
in
{
  imports = [ inputs.pi.homeModules.default ];

  options.programs.pi-runtime = {
    enable = lib.mkEnableOption "the guarded Pi runtime";
    package = lib.mkOption {
      type = lib.types.package;
      default = inputs.pi.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Pi executable wrapped with mandatory orchestration and permissions extensions.";
    };
    herdrPackage = lib.mkOption {
      type = lib.types.package;
      default = inputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Herdr executable used to launch subagent panes.";
    };
    settings = lib.mkOption {
      type = (pkgs.formats.json { }).type;
      description = "Managed orchestrator configuration. Stored in the Nix store; must not contain secrets.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.pi.coding-agent = {
      enable = true;
      package = launcher;
      settings.packages = [
        plugins.web
        plugins.ask
        plugins.todo
        plugins.tuicr
      ];
    };
    home.file.".pi/agent/orchestrator.json".source = configFile;
  };
}
