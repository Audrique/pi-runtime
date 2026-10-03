{
  lib,
  runCommand,
  nodejs_24,
  dependencies,
  pi,
  hostPackages,
}:
runCommand "pi-runtime-host-dependencies-${pi.version}"
  {
    nativeBuildInputs = [ nodejs_24 ];
    passthru = { inherit dependencies pi hostPackages; };
  }
  ''
    # Keep npm fetching independent of host SDK updates. Copy files, not symlinked
    # plugin roots: native ESM resolution must stay inside this composed tree.
    mkdir -p "$out"
    cp -r ${dependencies}/. "$out/"
    chmod -R u+w "$out"
    # These locks describe the unmodified fetch input, not the host-composed tree.
    rm -f "$out/package-lock.json" "$out/node_modules/.package-lock.json"
    node ${./host-packages.mjs} --manifest "$out/package.json" ${lib.escapeShellArg (builtins.toJSON hostPackages)}
    node ${./host-packages.mjs} --node-modules "$out/node_modules" \
      ${lib.escapeShellArg (builtins.toJSON hostPackages)} \
      ${pi}/lib/node_modules/@earendil-works/pi-coding-agent/package.json
  ''
