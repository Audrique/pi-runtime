import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Loader-only smoke check: invoke real factories, but no tools, UI, or providers.
// Supply the four packaged plugin directories (or explicit entry files), not npm specs.
assert.ok(process.env.PI_PLUGIN_PATHS, "PI_PLUGIN_PATHS must be a JSON array of four packaged plugin paths");
const paths = JSON.parse(process.env.PI_PLUGIN_PATHS);
assert.ok(Array.isArray(paths) && paths.length === 4, "PI_PLUGIN_PATHS must contain exactly four paths");
for (const path of paths) {
  assert.ok(typeof path === "string" && isAbsolute(path), "plugin paths must be absolute");
}
assert.equal(new Set(paths.map(path => realpathSync(path))).size, 4, "plugin paths must be distinct");

const dir = mkdtempSync(join(tmpdir(), "pi-plugins-"));
const cwd = join(dir, "project");
const agentDir = join(dir, "agent");
try {
  mkdirSync(cwd);
  mkdirSync(agentDir);
  // Avoid loading any personal settings or credential files during factory initialization.
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
  for (const path of paths) {
    const loaded = await discoverAndLoadExtensions([path], cwd, agentDir);
    assert.deepEqual(loaded.errors, [], `plugin must load: ${path}`);
    assert.ok(loaded.extensions.length > 0, `plugin must expose at least one extension: ${path}`);
  }
  console.log("Pi third-party plugin loader check passed: all four packaged plugins loaded.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
