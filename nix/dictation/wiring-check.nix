{
  pkgs,
  lib,
  runtimeModule,
  plugins,
}:
let
  evaluate =
    enabled:
    (lib.evalModules {
      specialArgs = {
        inherit pkgs;
        osConfig = { };
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
  enabled = evaluate true;
  disabled = evaluate false;
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
assert lib.all (entry: entry.assertion) enabled.assertions;
assert lib.all (entry: entry.assertion) disabled.assertions;
assert active.settings.packages == expectedPlugins;
assert inactive.settings.packages == expectedPlugins;
assert active.extensions == [ "${voice.package}/${voice.package.extensionPath}" ];
assert inactive.extensions == [ ];
assert inactive.environment == null;
assert active.environment.PI_DICTATION_SHORTCUT.value == "f9";
assert active.environment.PI_DICTATION_LANGUAGE.value == "en";
assert lib.hasInfix "--target 'test capture node'" active.environment.PI_DICTATION_RECORD_CMD.value;
assert lib.all (name: active.environment.${name}.value == voice.assets.environment.${name}) (
  builtins.attrNames voice.assets.environment
);
pkgs.runCommand "pi-runtime-dictation-wiring-check" { } ''
  touch "$out"
''
