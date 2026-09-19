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
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          dependencies = pkgs.callPackage ./nix/dependencies.nix { };
          testDependencies = dependencies.override { production = false; };
          extensions = pkgs.callPackage ./nix/extensions.nix {
            subagentSource = inputs.pi-interactive-subagents;
            permissionSource = inputs.pi-permission-packages;
            inherit dependencies testDependencies;
          };
          plugins = {
            web = "${dependencies}/node_modules/pi-web-access";
            ask = "${dependencies}/node_modules/@juicesharp/rpiv-ask-user-question";
            todo = "${dependencies}/node_modules/@juicesharp/rpiv-todo";
            tuicr = "${dependencies}/node_modules/@joelazar/pi-tuicr";
          };
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
            ;
        };
    in
    {
      homeModules.default = import ./nix/home-manager.nix { inherit inputs self; };
      homeManagerModules.default = self.homeModules.default;
      overlays.default = inputs.pi.overlays.default;

      packages = forAllSystems (
        system:
        let
          runtime = build system;
        in
        {
          default = runtime.bundle;
          extensions = runtime.bundle;
          inherit (runtime) dependencies;
          test-dependencies = runtime.testDependencies;
          inherit (runtime.extensions) subagents permissions;
        }
      );

      checks = forAllSystems (
        system:
        let
          runtime = build system;
          inherit (runtime)
            pkgs
            extensions
            plugins
            testDependencies
            ;
          configFile = ./tests/fixtures/orchestrator.json;
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
                test "$(${productionLauncher}/bin/pi --version)" = "${
                  (builtins.fromJSON (builtins.readFile ./dependencies/package.json))
                  .devDependencies."@earendil-works/pi-coding-agent"
                }"
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
                PI_SUBAGENTS_EXTENSION = "${extensions.subagents}/${extensions.subagents.extensionPath}/pi-extension/subagents";
                PI_PERMISSIONS_EXTENSION = "${extensions.permissions}/${extensions.permissions.extensionPath}/src";
              }
              ''
                node ${./tests/launcher.mjs}
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
          pkgs = (build system).pkgs;
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
