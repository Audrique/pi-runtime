{
  lib,
  stdenvNoCC,
  nodejs_24,
  subagentSource,
  permissionSource,
  dependencies,
  testDependencies,
}:
let
  mkExtension =
    {
      pname,
      src,
      directory,
      files,
      checkCommand,
    }:
    stdenvNoCC.mkDerivation {
      inherit pname src;
      version = (builtins.fromJSON (builtins.readFile "${src}/${directory}/package.json")).version;
      nativeBuildInputs = [ nodejs_24 ];
      dontConfigure = true;
      dontBuild = true;
      doCheck = false;
      checkPhase = ''
        runHook preCheck
        export HOME="$TMPDIR/home"
        export CI=true
        mkdir -p "$HOME" /tmp/opencode
        ln -s ${testDependencies}/node_modules node_modules
        export PATH=${testDependencies}/node_modules/.bin:$PATH
        ${checkCommand}
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p "$out/share/pi-extensions/${pname}"
        cd ${directory}
        cp -r ${lib.escapeShellArgs files} "$out/share/pi-extensions/${pname}/"
        ln -s ${dependencies}/node_modules "$out/share/pi-extensions/${pname}/node_modules"
        runHook postInstall
      '';
      passthru.extensionPath = "share/pi-extensions/${pname}";
    };
in
{
  subagents = mkExtension {
    pname = "pi-interactive-subagents";
    src = subagentSource;
    directory = ".";
    files = [
      "pi-extension"
      "package.json"
      "LICENSE"
    ];
    checkCommand = ''
      tsc --noEmit
      node --experimental-transform-types --test test/test.ts test/*.test.ts
    '';
  };
  permissions = mkExtension {
    pname = "pi-permission-system";
    src = permissionSource;
    directory = "packages/pi-permission-system";
    files = [
      "src"
      "package.json"
      "LICENSE"
      "schemas"
      "config"
    ];
    checkCommand = ''
      tsc --noEmit -p packages/pi-permission-system/tsconfig.json
      vitest run --root packages/pi-permission-system
    '';
  };
}
