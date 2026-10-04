{
  pkgs,
  lib,
  runCommand,
  nodejs_24,
  formats,
  pi,
  piLibrary,
  dictation,
  whisperPackage,
}:
let
  settingsFile = (formats.json { }).generate "pi-dictation-settings.json" dictation.settings;
  # Test pi.nix's real environment wrapper without the guarded launcher's fixed
  # personal agent directory, permissions, or unrelated plugins.
  testPi =
    (piLibrary.mkCodingAgent {
      inherit pkgs;
      modules = [
        {
          pi.coding-agent = {
            package = pi;
            environment = lib.mapAttrs (_: value: { inherit value; }) dictation.environment;
          };
        }
      ];
    }).package;
in
{
  integration =
    runCommand "pi-dictation-integration-check"
      {
        nativeBuildInputs = [ nodejs_24 ];
        PI_OFFLINE = "1";
        PI_DICTATION_HOST = "${pi}/lib/node_modules/@earendil-works/pi-coding-agent/package.json";
        PI_DICTATION_PACKAGE = toString dictation.extension;
        PI_DICTATION_CAPTURE_BACKEND = dictation.captureBackend;
        PI_DICTATION_RECORDER = dictation.recorder;
        PI_DICTATION_SETTINGS = settingsFile;
        PI_DICTATION_ENVIRONMENT = builtins.toJSON dictation.environment;
        PI_DICTATION_EXECUTABLE = "${testPi}/bin/pi";
      }
      ''
        export HOME="$TMPDIR/home"
        mkdir -p "$HOME"
        node --experimental-strip-types ${../../tests/dictation.mjs}
        touch "$out"
      '';

  # This is actual offline inference on a public, prerecorded speech fixture.
  # No microphone, provider credentials, desktop session, or cloud API is used.
  transcription = runCommand "pi-dictation-transcription-check" { } ''
    ${lib.getExe dictation.transcriber} ${whisperPackage.src}/samples/jfk.wav > transcript.txt
    test -s transcript.txt
    if [ ${lib.escapeShellArg dictation.settings.language} = auto ] || \
       [ ${lib.escapeShellArg dictation.settings.language} = en ]; then
      grep -qi 'ask not what your country can do for you' transcript.txt
    fi
    if grep -Eq '\[[0-9]{2}:[0-9]{2}:[0-9]{2}' transcript.txt; then
      echo 'Transcription must not include timestamps' >&2
      exit 1
    fi
    cp transcript.txt "$out"
  '';
}
