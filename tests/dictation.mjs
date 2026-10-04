import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Test the exact package and settings used by Home Manager. No recording occurs.
const packagePath = process.env.PI_DICTATION_PACKAGE;
const hostEntry = process.env.PI_DICTATION_HOST;
const executable = process.env.PI_DICTATION_EXECUTABLE;
assert.ok(packagePath && hostEntry && executable, "Nix must supply the package and Pi host");
const settings = JSON.parse(readFileSync(process.env.PI_DICTATION_SETTINGS, "utf8"));
const environment = JSON.parse(process.env.PI_DICTATION_ENVIRONMENT);
const manifest = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
assert.equal(manifest.name, "pi-dictation");
assert.equal(manifest.version, "0.6.0");
assert.deepEqual(Object.keys(manifest.dependencies), ["cli-spinners"]);
for (const name of ["pi-coding-agent", "pi-tui"]) {
  assert.equal(manifest.peerDependencies[`@earendil-works/${name}`], "*");
  assert.equal(existsSync(join(packagePath, "node_modules", "@earendil-works", name)), false,
    "the extension must not bundle private Pi libraries");
}
assert.match(settings.recordCommand, /\/nix\/store\/.*\/bin\/pw-record/);
assert.match(settings.recordCommand, /--format s16 --rate 16000 --channels 1/);
assert.match(settings.transcribeCommand, /\/nix\/store\/.*\/bin\/pi-dictation-transcribe/);
assert.ok(settings.recordCommand.endsWith("{file}"));
assert.ok(settings.transcribeCommand.endsWith("{file}"));

const directory = mkdtempSync(join(tmpdir(), "pi-dictation-check-"));
const cwd = join(directory, "project");
const agentDir = join(directory, ".pi", "agent");
try {
  mkdirSync(cwd);
  mkdirSync(agentDir, { recursive: true });
  Object.assign(process.env, environment, {
    HOME: directory,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  });

  // Even a valid optional config with contrary settings cannot change the
  // Nix-configured backend, shortcut, language, or duration limits.
  const optionalConfig = join(agentDir, "pi-dictation.json");
  writeFileSync(optionalConfig, JSON.stringify({
    shortcut: "insert",
    language: "ja",
    recordCommand: "unmanaged recorder",
    transcribeCommand: "unmanaged transcriber",
    timeoutMs: 1000,
    maxRecordingMs: 1000,
    spinner: "dots",
  }));
  const { loadConfig, getConfigPath } = await import(
    pathToFileURL(join(packagePath, "extensions", "config.ts")).href
  );
  assert.equal(getConfigPath(), optionalConfig);
  const effective = loadConfig();
  assert.equal(effective.configError, undefined);
  for (const [name, value] of Object.entries(settings)) {
    assert.equal(effective[name], value, `declarative setting must win: ${name}`);
  }

  // Exercise Pi's real package discovery and jiti extension loader, including
  // the host TUI import and cli-spinners JSON import, without any npm install.
  const hostManifest = JSON.parse(readFileSync(hostEntry, "utf8"));
  const sdkEntry = hostManifest.exports["."].import;
  assert.equal(typeof sdkEntry, "string", "the Pi host must provide its ESM SDK entry");
  const { DefaultResourceLoader, SettingsManager } = await import(
    new URL(sdkEntry, pathToFileURL(hostEntry)).href
  );
  for (const mode of ["package", "explicit"]) {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(mode === "package" ? { packages: [packagePath] } : {}),
      additionalExtensionPaths: mode === "explicit" ? [join(packagePath, manifest.pi.extensions[0])] : [],
      noExtensions: mode === "explicit",
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.warnings, [], `${mode}: the pinned package must load without warnings`);
    assert.deepEqual(loaded.errors, [], `${mode}: the pinned package must load without errors`);
    assert.equal(loaded.extensions.length, 1);
    for (const name of ["dictate", "dictate-cancel", "dictate-config", "dictate-help"]) {
      assert.ok(loaded.extensions[0].commands.has(name), `${mode}: ${name} must be registered`);
    }
    assert.ok(loaded.extensions[0].shortcuts.has(settings.shortcut));
  }

  // Invoke the actual wrapped host. Its environment must override contrary
  // values inherited from a shell, not depend on a new login/sessionVariables.
  const capture = join(directory, "captured-environment.json");
  const fixture = join(cwd, "capture.ts");
  writeFileSync(fixture, `
    import { writeFileSync } from "node:fs";
    export default function () {
      const names = ${JSON.stringify(Object.keys(environment))};
      writeFileSync(process.env.DICTATION_TEST_CAPTURE,
        JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))));
    }
  `);
  execFileSync(executable, ["--no-extensions", "--extension", fixture, "--help"], {
    cwd,
    env: {
      ...process.env,
      ...Object.fromEntries(Object.keys(environment).map(name => [name, "unmanaged override"])),
      DICTATION_TEST_CAPTURE: capture,
    },
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), environment);
  console.log("Pi dictation integration passed: real loader, host ABI, and authoritative launcher settings.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
