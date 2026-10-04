{ lib, pkgs }:
{
  package ? pkgs.callPackage ./package.nix { },
  whisperPackage ? pkgs.whisper-cpp,
  model ? "small",
  language ? "auto",
  shortcut ? "f8",
  threads ? 4,
  captureTarget ? null,
  timeoutMs ? 120000,
  maxRecordingMs ? 120000,
  ...
}:
let
  models = import ./models.nix;
  modelFile = pkgs.fetchurl {
    name = "ggml-${model}.bin";
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/${models.revision}/ggml-${model}.bin";
    hash = models.hashes.${model};
  };
  transcriber = pkgs.writeShellApplication {
    name = "pi-dictation-transcribe";
    text = ''
      if [ "$#" -ne 1 ]; then
        printf 'Usage: pi-dictation-transcribe RECORDING.wav\n' >&2
        exit 2
      fi
      exec ${lib.getExe whisperPackage} \
        --model ${lib.escapeShellArg (toString modelFile)} \
        --language ${lib.escapeShellArg language} \
        --threads ${toString threads} \
        --no-timestamps --no-prints \
        --file "$1"
    '';
  };
  settings = {
    inherit
      shortcut
      language
      timeoutMs
      maxRecordingMs
      ;
    spinner = "arc";
    recordCommand = lib.concatStringsSep " " (
      [
        (lib.escapeShellArg "${pkgs.pipewire}/bin/pw-record")
        "--format s16 --rate 16000 --channels 1"
      ]
      ++ lib.optionals (captureTarget != null) [
        "--target"
        (lib.escapeShellArg captureTarget)
      ]
      ++ [ "{file}" ]
    );
    transcribeCommand = "${lib.escapeShellArg (lib.getExe transcriber)} {file}";
  };
  environment = {
    PI_DICTATION_SHORTCUT = settings.shortcut;
    PI_DICTATION_LANGUAGE = settings.language;
    PI_DICTATION_RECORD_CMD = settings.recordCommand;
    PI_DICTATION_TRANSCRIBE_CMD = settings.transcribeCommand;
    PI_DICTATION_TIMEOUT_MS = toString settings.timeoutMs;
    PI_DICTATION_MAX_RECORDING_MS = toString settings.maxRecordingMs;
    PI_DICTATION_SPINNER = settings.spinner;
  };
in
{
  extension = package;
  model = modelFile;
  inherit transcriber settings environment;
}
