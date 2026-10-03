import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostPackageRoots, normalizeManifest, packageRoots } from "../nix/host-packages.mjs";

const hosts = JSON.parse(process.env.PI_HOST_PACKAGES);
// An independent ABI assertion prevents an accidental omission from the Nix policy.
assert.deepEqual([...hosts].sort(), [
  "@earendil-works/pi-ai", "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
].sort());
const hostRoots = hostPackageRoots(process.env.PI_HOST_ENTRY, hosts);
const hostEntry = pathToFileURL(process.env.PI_HOST_ENTRY).href;
const roots = JSON.parse(process.env.PI_DEPENDENCY_ROOTS);
const manifests = JSON.parse(process.env.PI_FORK_MANIFESTS);
const pluginPaths = JSON.parse(process.env.PI_PLUGIN_PATHS);

function checkManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(manifest, normalizeManifest(manifest, hosts), `non-host-owned dependency in ${path}`);
}
function checkTree(directory, root = true) {
  for (const name of hosts) {
    const path = join(directory, name);
    if (root) {
      assert.ok(lstatSync(path).isSymbolicLink(), `${path} must link to Pi`);
      assert.equal(realpathSync(path), hostRoots[name]);
    } else assert.equal(existsSync(path), false, `nested host copy: ${path}`);
  }
  for (const packagePath of packageRoots(directory)) {
    if (existsSync(join(packagePath, "package.json"))) checkManifest(join(packagePath, "package.json"));
    const nested = join(packagePath, "node_modules");
    if (existsSync(nested)) checkTree(nested, false);
  }
}
for (const root of roots) {
  assert.equal(existsSync(join(root, "package-lock.json")), false);
  assert.equal(existsSync(join(root, "node_modules/.package-lock.json")), false);
  checkManifest(join(root, "package.json"));
  checkTree(join(root, "node_modules"));
}
for (const manifest of manifests) checkManifest(manifest);

// Native Node resolution bypasses jiti aliases. This checks compiled ESM helpers
// as well as plugin entry points see the very same module, not just its version.
for (const path of [...pluginPaths, join(roots[0], "node_modules/@juicesharp/rpiv-config")]) {
  const manifestPath = join(path, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const imports = hosts.filter(name => Object.hasOwn(manifest.peerDependencies ?? {}, name));
  if (imports.includes("typebox")) imports.push("typebox/compile", "typebox/value");
  for (const name of imports) {
    // The Nix check enables parent-URL resolution; use import conditions for ESM SDKs.
    const resolved = import.meta.resolve(name, pathToFileURL(manifestPath).href);
    const hostResolved = import.meta.resolve(name, hostEntry);
    assert.equal(realpathSync(fileURLToPath(resolved)), realpathSync(fileURLToPath(hostResolved)), `${name} resolves outside Pi from ${path}`);
    assert.equal(await import(resolved), await import(hostResolved));
  }
}
console.log("Host dependency packaging check passed: manifests, nested copy removal, Nix links, native module identity.");
