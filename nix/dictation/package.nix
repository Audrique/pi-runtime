{
  lib,
  stdenvNoCC,
  fetchurl,
}:

stdenvNoCC.mkDerivation rec {
  pname = "pi-dictation";
  version = "0.6.0";

  # Package the published release, not the different API on GitHub main.
  src = fetchurl {
    url = "https://registry.npmjs.org/pi-dictation/-/pi-dictation-${version}.tgz";
    hash = "sha256-qFYKonhfqvboa2kGgpVzYHSuHcCJvyOZ08RcljP3jsY=";
  };

  cliSpinners = fetchurl {
    url = "https://registry.npmjs.org/cli-spinners/-/cli-spinners-3.4.0.tgz";
    hash = "sha256-HbEZPh8wTCoLGA6W8nJPps9p3HlcXFGYn+rw6v9vwMI=";
  };

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/node_modules/cli-spinners"
    cp -r . "$out/"
    tar -xzf "$cliSpinners" --strip-components=1 -C "$out/node_modules/cli-spinners"
    runHook postInstall
  '';

  # Pi supplies its own SDK and TUI through the extension loader. Do not install
  # npm peers or private copies of the host libraries into this package.
  passthru.extensionPath = "extensions/pi-dictation.ts";

  meta = {
    description = "Local-command voice dictation extension for Pi";
    homepage = "https://github.com/yasuhito/pi-dictation";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
