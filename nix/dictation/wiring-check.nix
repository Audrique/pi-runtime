{
  pkgs,
  lib,
  runtimeModule,
  plugins,
}:
let
  evaluate =
    {
      enabled ? true,
      isWSL ? null,
    }:
    (lib.evalModules {
      specialArgs = {
        inherit pkgs;
      }
      // lib.optionalAttrs (isWSL != null) {
        osConfig.wsl.enable = isWSL;
      };
      modules = [
        runtimeModule
        {
          # Only the Home Manager base options consumed by the real runtime module.
          options.home = {
            homeDirectory = lib.mkOption {
              type = lib.types.str;
              default = "/test/pi-dictation";
            };
            packages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
            };
            file = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
          };
          options.assertions = lib.mkOption {
            type = lib.types.listOf lib.types.attrs;
            default = [ ];
          };
          config.programs.pi-runtime = {
            enable = true;
            settings = {
              schemaVersion = 1;
            };
            herdrPackage = pkgs.writeShellScriptBin "herdr" "exit 1";
            dictation = {
              enable = enabled;
              shortcut = "f9";
              language = "en";
              captureTarget = "test capture node";
            };
          };
        }
      ];
    }).config;
  enabled = evaluate { };
  disabled = evaluate { enabled = false; };
  wsl = evaluate { isWSL = true; };
  wslDisabled = evaluate {
    enabled = false;
    isWSL = true;
  };
  expectedPlugins = [
    plugins.web
    plugins.ask
    plugins.todo
    plugins.tuicr
  ];
  active = enabled.programs.pi.coding-agent;
  inactive = disabled.programs.pi.coding-agent;
  voice = enabled.programs.pi-runtime.dictation;
in
assert lib.all
  (
    cfg:
    lib.all (entry: entry.assertion) cfg.assertions
    && cfg.programs.pi.coding-agent.settings.packages == expectedPlugins
  )
  [
    enabled
    disabled
    wsl
    wslDisabled
  ];
assert lib.all
  (
    cfg:
    let
      agent = cfg.programs.pi.coding-agent;
      dictation = cfg.programs.pi-runtime.dictation;
    in
    agent.extensions == [ "${dictation.package}/${dictation.package.extensionPath}" ]
    && agent.environment.PI_DICTATION_SHORTCUT.value == "f9"
    && agent.environment.PI_DICTATION_LANGUAGE.value == "en"
    && lib.all (name: agent.environment.${name}.value == dictation.assets.environment.${name}) (
      builtins.attrNames dictation.assets.environment
    )
  )
  [
    enabled
    wsl
  ];
assert inactive.extensions == [ ] && inactive.environment == null;
assert wslDisabled.programs.pi.coding-agent.extensions == [ ];
assert wslDisabled.programs.pi.coding-agent.environment == null;
assert voice.captureBackend == "pipewire" && voice.pulseServer == null;
assert lib.hasInfix "--target 'test capture node'" active.environment.PI_DICTATION_RECORD_CMD.value;
assert wsl.programs.pi-runtime.dictation.captureBackend == "pulseaudio";
assert wsl.programs.pi-runtime.dictation.pulseServer == "unix:/mnt/wslg/PulseServer";
assert lib.hasInfix "/bin/parecord"
  wsl.programs.pi.coding-agent.environment.PI_DICTATION_RECORD_CMD.value;
assert lib.hasInfix "--server ${lib.escapeShellArg "unix:/mnt/wslg/PulseServer"}"
  wsl.programs.pi.coding-agent.environment.PI_DICTATION_RECORD_CMD.value;
assert lib.hasInfix "--device 'test capture node'"
  wsl.programs.pi.coding-agent.environment.PI_DICTATION_RECORD_CMD.value;
pkgs.runCommand "pi-runtime-dictation-wiring-check" { } ''
  touch "$out"
''
