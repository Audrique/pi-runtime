{
  lib,
  buildNpmPackage,
  nodejs_24,
  production ? true,
}:
buildNpmPackage {
  pname = "pi-runtime-${if production then "dependencies" else "test-dependencies"}";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../dependencies;
    fileset = lib.fileset.unions [
      ../dependencies/package.json
      ../dependencies/package-lock.json
    ];
  };
  nodejs = nodejs_24;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-qKgzUBmiV58XOigPTC9YoyDip1aZqcuXWbdeT4TRfJg=";
  # Pi peer dependencies come from the Nix package, not a second npm install.
  npmFlags = [ "--ignore-scripts" "--legacy-peer-deps" ];
  dontNpmBuild = true;
  installPhase = ''
    runHook preInstall
    ${lib.optionalString production "npm prune --omit=dev --ignore-scripts --legacy-peer-deps --offline --no-audit --no-fund"}
    mkdir -p "$out"
    cp -r node_modules package.json package-lock.json "$out/"
    runHook postInstall
  '';
}
