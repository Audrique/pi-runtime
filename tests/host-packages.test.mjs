import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeHostDependencies, normalizeManifest } from "../nix/host-packages.mjs";

const hosts = ["typebox", "@earendil-works/pi-ai"];

test("only host dependency declarations change, without mutating the input", () => {
  const manifest = {
    name: "fixture", version: "1.0.0", pi: { extensions: ["index.js"] },
    dependencies: { typebox: "^1.2.0", ordinary: "2.0.0" },
    optionalDependencies: { "@earendil-works/pi-ai": "^1.0.0", optional: "3.0.0" },
    devDependencies: { typebox: "1.2.0", typescript: "6.0.3" },
    peerDependencies: { "@earendil-works/pi-ai": "^1.0.0", other: "^4" },
    peerDependenciesMeta: { "@earendil-works/pi-ai": { optional: true } },
    bundleDependencies: ["typebox", "ordinary"],
    bundledDependencies: ["@earendil-works/pi-ai", "optional"],
  };
  const original = structuredClone(manifest);
  assert.deepEqual(normalizeManifest(manifest, hosts), {
    ...manifest,
    dependencies: { ordinary: "2.0.0" },
    optionalDependencies: { optional: "3.0.0" },
    devDependencies: { typescript: "6.0.3" },
    peerDependencies: { "@earendil-works/pi-ai": "*", other: "^4", typebox: "*" },
    bundleDependencies: ["ordinary"], bundledDependencies: ["optional"],
  });
  assert.deepEqual(manifest, original);
  assert.deepEqual(normalizeManifest(normalizeManifest(manifest, hosts), hosts), normalizeManifest(manifest, hosts));
  assert.deepEqual(normalizeManifest({ name: "unrelated" }, hosts), { name: "unrelated" });
});

test("nested private host copies are removed; helper dependencies use the pinned host", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-packages-"));
  const packageAt = (root, name, extra = {}) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js", ...extra }));
    writeFileSync(join(path, "index.js"), "module.exports = {};\n");
    return path;
  };
  try {
    const host = join(dir, "host");
    mkdirSync(host);
    const hostEntry = join(host, "package.json");
    writeFileSync(hostEntry, '{"name":"host"}');
    const hostModules = join(host, "node_modules");
    const typebox = packageAt(hostModules, "typebox");
    const ai = packageAt(hostModules, "@earendil-works/pi-ai");
    const modules = join(dir, "output/node_modules");
    packageAt(modules, "typebox");
    const plugin = packageAt(modules, "plugin", { dependencies: { typebox: "^1", helper: "1" } });
    const nested = join(plugin, "node_modules");
    packageAt(nested, "typebox");
    packageAt(nested, "@earendil-works/pi-ai");
    const helper = packageAt(nested, "helper", { dependencies: { typebox: "^1" } });
    composeHostDependencies(modules, hostEntry, hosts);
    assert.equal(realpathSync(join(modules, "typebox")), typebox);
    assert.equal(realpathSync(join(modules, "@earendil-works/pi-ai")), ai);
    assert.equal(existsSync(join(nested, "typebox")), false);
    assert.equal(existsSync(join(nested, "@earendil-works/pi-ai")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(helper, "package.json"), "utf8")), {
      name: "helper", version: "1.0.0", main: "index.js", dependencies: {}, peerDependencies: { typebox: "*" },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).dependencies, { helper: "1" });
    composeHostDependencies(modules, hostEntry, hosts);
    assert.equal(realpathSync(join(modules, "typebox")), typebox);
    assert.throws(() => composeHostDependencies(modules, hostEntry, [...hosts, "missing-host-module"]), /Cannot locate missing-host-module/);
    assert.equal(realpathSync(join(modules, "typebox")), typebox, "failed host validation must not modify output");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
