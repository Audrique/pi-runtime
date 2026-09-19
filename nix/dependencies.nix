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
  npmDepsHash = "sha256-35ANuwQIMVTQffDhf5C7CGwyvYHoK0W0hnBOoe0oJ7Y=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  installPhase = ''
    runHook preInstall
    ${lib.optionalString production "npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund"}
    mkdir -p "$out"
    cp -r node_modules package.json package-lock.json "$out/"
    runHook postInstall
  '';
}
