{
  description = "Pinned Pi extensions, guarded launcher, and integration checks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pi = {
      url = "github:lukasl-dev/pi.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    herdr = {
      url = "github:herdrdev/herdr";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pi-interactive-subagents = {
      url = "github:Audrique/pi-interactive-subagents/herdr-orchestration";
      flake = false;
    };
    pi-permission-packages = {
      url = "github:Audrique/pi-packages/centralized-ai-permissions";
      flake = false;
    };
  };

  outputs =
    inputs@{ self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      build =
        {
          system,
          pi ? inputs.pi.packages.${system}.default,
        }:
        let
          pkgs = import nixpkgs { inherit system; };
          hostPackages = import ./nix/host-packages.nix;
          npmDependencies = pkgs.callPackage ./nix/dependencies.nix { };
          composeDependencies =
            dependencies:
            pkgs.callPackage ./nix/host-dependencies.nix {
              inherit dependencies hostPackages;
              inherit pi;
            };
          dependencies = composeDependencies npmDependencies;
          testDependencies = composeDependencies (npmDependencies.override { production = false; });
          extensions = pkgs.callPackage ./nix/extensions.nix {
            subagentSource = inputs.pi-interactive-subagents;
            permissionSource = inputs.pi-permission-packages;
            inherit dependencies testDependencies hostPackages;
          };
          plugins = {
            web = "${dependencies}/node_modules/pi-web-access";
            ask = "${dependencies}/node_modules/@juicesharp/rpiv-ask-user-question";
            todo = "${dependencies}/node_modules/@juicesharp/rpiv-todo";
            tuicr = "${dependencies}/node_modules/@joelazar/pi-tuicr";
          };
          dictation = (pkgs.callPackage ./nix/dictation/assets.nix { }) { };
          bundle = pkgs.symlinkJoin {
            name = "pi-runtime-extensions";
            paths = [
              extensions.subagents
              extensions.permissions
            ];
            passthru = { inherit plugins; };
          };
        in
        {
          inherit
            pkgs
            dependencies
            testDependencies
            extensions
            plugins
            bundle
            dictation
            hostPackages
            ;
        };
    in
    {
      # Use the same host package for SDK composition and the launcher, including overrides.
      lib.mkRuntime = build;
      homeModules.default = import ./nix/home-manager.nix { inherit inputs self; };
      homeManagerModules.default = self.homeModules.default;
      overlays.default = inputs.pi.overlays.default;

      packages = forAllSystems (
        system:
        let
          runtime = build { inherit system; };
        in
        {
          default = runtime.bundle;
          extensions = runtime.bundle;
          inherit (runtime) dependencies;
          test-dependencies = runtime.testDependencies;
          inherit (runtime.extensions) subagents permissions;
          dictation = runtime.dictation.extension;
          dictation-model = runtime.dictation.model;
          dictation-transcribe = runtime.dictation.transcriber;
        }
      );

      checks = forAllSystems (
        system:
        let
          runtime = build { inherit system; };
          inherit (runtime)
            pkgs
            dependencies
            extensions
            plugins
            testDependencies
            hostPackages
            ;
          configFile = ./tests/fixtures/orchestrator.json;
          dictationChecks = pkgs.callPackage ./nix/dictation/checks.nix {
            dictation = runtime.dictation;
            pi = inputs.pi.packages.${system}.default;
            piLibrary = inputs.pi.lib;
            whisperPackage = pkgs.whisper-cpp;
          };
          mkLauncher = pkgs.callPackage ./nix/launcher.nix { };
          productionLauncher = mkLauncher {
            pi = inputs.pi.packages.${system}.default;
            herdr = pkgs.writeShellScriptBin "herdr" "exit 1";
            inherit (extensions) subagents permissions;
            inherit plugins configFile;
          };
          testLauncher = mkLauncher {
            pi = pkgs.writeShellScriptBin "pi" ''
              exec ${pkgs.nodejs_24}/bin/node ${./tests/capture-launch.mjs} "$@"
            '';
            herdr = pkgs.writeShellScriptBin "herdr" "exit 1";
            inherit (extensions) subagents permissions;
            inherit plugins configFile;
            agentDir = "/test/pi agent";
          };
        in
        {
          dictation = dictationChecks.integration;
          dictation-transcription = dictationChecks.transcription;
          dictation-wiring = pkgs.callPackage ./nix/dictation/wiring-check.nix {
            runtimeModule = self.homeModules.default;
            inherit plugins;
          };
          host-packaging =
            pkgs.runCommand "pi-runtime-host-packaging-check"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
                PI_HOST_PACKAGES = builtins.toJSON hostPackages;
                PI_HOST_ENTRY = "${
                  inputs.pi.packages.${system}.default
                }/lib/node_modules/@earendil-works/pi-coding-agent/package.json";
                PI_DEPENDENCY_ROOTS = builtins.toJSON [
                  dependencies
                  testDependencies
                ];
                PI_PLUGIN_PATHS = builtins.toJSON (builtins.attrValues plugins);
                PI_FORK_MANIFESTS = builtins.toJSON [
                  "${extensions.subagents}/${extensions.subagents.extensionPath}/package.json"
                  "${extensions.permissions}/${extensions.permissions.extensionPath}/package.json"
                ];
              }
              ''
                cp -r ${./tests} tests
                cp -r ${./nix} nix
                node --test tests/host-packages.test.mjs
                node --experimental-import-meta-resolve tests/host-dependencies.mjs
                touch "$out"
              '';
          subagents = extensions.subagents.overrideAttrs { doCheck = true; };
          permissions = extensions.permissions.overrideAttrs { doCheck = true; };
          production-cli =
            pkgs.runCommand "pi-runtime-production-cli-check"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
                PI_PRODUCTION_LAUNCHER = "${productionLauncher}/bin/pi";
                PI_PLUGIN_PATHS = builtins.toJSON (builtins.attrValues plugins);
              }
              ''
                export HOME="$TMPDIR/home"
                export PI_OFFLINE=1
                mkdir -p "$HOME"
                test "$(${productionLauncher}/bin/pi --version)" = "${inputs.pi.packages.${system}.default.version}"
                node ${./tests/cli.mjs}
                touch "$out"
              '';
          launcher =
            pkgs.runCommand "pi-runtime-launcher-check"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
                PI_TEST_LAUNCHER = "${testLauncher}/bin/pi";
                PI_EXPECT_CONFIG = "${configFile}";
                PI_EXPECT_WEB = "${plugins.web}/index.ts";
                PI_EXPECT_HERDR_NOTIFICATIONS = "${./extensions}/herdr-notifications.ts";
                PI_SUBAGENTS_EXTENSION = "${extensions.subagents}/${extensions.subagents.extensionPath}/pi-extension/subagents";
                PI_PERMISSIONS_EXTENSION = "${extensions.permissions}/${extensions.permissions.extensionPath}/src";
              }
              ''
                node ${./tests/launcher.mjs}
                touch "$out"
              '';
          herdr-notifications =
            pkgs.runCommand "pi-runtime-herdr-notifications-check"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
              }
              ''
                cp -r ${./extensions} extensions
                cp -r ${./tests} tests
                ln -s ${testDependencies}/node_modules node_modules
                node node_modules/typescript/bin/tsc --strict --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions extensions/herdr-*.ts
                node --experimental-strip-types --test tests/herdr-notifications.test.ts tests/herdr-client.test.ts
                touch "$out"
              '';
          integration =
            pkgs.runCommand "pi-runtime-integration"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
                PI_SUBAGENTS_EXTENSION = "${extensions.subagents}/${extensions.subagents.extensionPath}/pi-extension/subagents";
                PI_PERMISSIONS_EXTENSION = "${extensions.permissions}/${extensions.permissions.extensionPath}/src";
                PI_PLUGIN_PATHS = builtins.toJSON (builtins.attrValues plugins);
              }
              ''
                export HOME="$TMPDIR/home"
                mkdir -p "$HOME"
                cp -r ${./tests} tests
                ln -s ${testDependencies}/node_modules node_modules
                node tests/runtime.mjs
                node tests/plugins.mjs
                touch "$out"
              '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = (build { inherit system; }).pkgs;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.nixfmt
            ];
          };
        }
      );
    };
}
