{
  config,
  lib,
  pkgs,
  ...
}@args:
let
  cfg = config.programs.pi-runtime.dictation;
  osConfig = args.osConfig or (config._module.args.osConfig or { });
  isWSL = lib.isAttrs osConfig && (osConfig.wsl.enable or false);
  models = import ./models.nix;
  assets = (pkgs.callPackage ./assets.nix { }) cfg;
in
{
  options.programs.pi-runtime.dictation = {
    enable = lib.mkEnableOption "declarative local dictation in the guarded Pi runtime";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "Pi dictation extension package. May be overridden with a packaged fork.";
    };

    whisperPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.whisper-cpp;
      description = "Whisper CLI package; override for GPU acceleration if desired.";
    };

    model = lib.mkOption {
      type = lib.types.enum (builtins.attrNames models.hashes);
      default = "small";
      description = "Hash-pinned Whisper model fetched by Nix. Models ending in .en are English-only.";
    };

    language = lib.mkOption {
      type = lib.types.str;
      default = "auto";
      description = "Whisper language code, or auto for detection. Speech is transcribed, not translated.";
    };

    shortcut = lib.mkOption {
      type = lib.types.str;
      default = "f8";
      description = "Pi shortcut to start recording, then stop and insert the transcript without submitting.";
    };

    threads = lib.mkOption {
      type = lib.types.ints.positive;
      default = 4;
      description = "Number of CPU threads used by Whisper.";
    };

    captureBackend = lib.mkOption {
      type = lib.types.enum [
        "pipewire"
        "pulseaudio"
      ];
      default = if isWSL then "pulseaudio" else "pipewire";
      defaultText = lib.literalExpression ''if osConfig.wsl.enable or false then "pulseaudio" else "pipewire"'';
      description = "Microphone backend: PipeWire normally, or WSLg's existing PulseAudio server on NixOS-WSL.";
    };

    pulseServer = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = if isWSL then "unix:/mnt/wslg/PulseServer" else null;
      defaultText = lib.literalExpression ''if osConfig.wsl.enable or false then "unix:/mnt/wslg/PulseServer" else null'';
      description = "PulseAudio server address. Null uses the client's environment/configuration; NixOS-WSL defaults to WSLg's socket.";
    };

    captureTarget = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "PipeWire capture node name/serial or PulseAudio source name; null uses the server's default microphone.";
    };

    timeoutMs = lib.mkOption {
      type = lib.types.ints.between 1000 3600000;
      default = 120000;
      description = "Maximum transcription duration in milliseconds.";
    };

    maxRecordingMs = lib.mkOption {
      type = lib.types.ints.between 1000 3600000;
      default = 120000;
      description = "Maximum microphone recording duration in milliseconds.";
    };

    assets = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
      default = assets;
      description = "Resolved model, extension, transcriber, and settings used by the integration checks.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.programs.pi-runtime.enable;
        message = "programs.pi-runtime.dictation requires programs.pi-runtime.enable.";
      }
    ];

    # Use pi.nix's existing launcher options. Its legacy settings attribute type
    # merges packages lists by replacement, so use the additive extensions option
    # rather than replacing pi-runtime's four existing plugin packages.
    programs.pi.coding-agent = {
      extensions = [ "${cfg.package}/${cfg.package.extensionPath}" ];
      environment = lib.mapAttrs (_: value: { inherit value; }) assets.environment;
    };

    # Deliberately do not manage ~/.pi/agent/pi-dictation.json: upstream's
    # /dictate-config can replace a Home Manager symlink when saving. The
    # immutable launcher environment is authoritative over its optional file.
  };
}
