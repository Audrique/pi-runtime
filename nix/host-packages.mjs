import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function normalizeManifest(manifest, hostPackages) {
  const result = structuredClone(manifest);
  for (const name of hostPackages) {
    let declared = Object.hasOwn(result.peerDependencies ?? {}, name);
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
      if (!Object.hasOwn(result[field] ?? {}, name)) continue;
      delete result[field][name];
      declared = true;
    }
    for (const field of ["bundledDependencies", "bundleDependencies"]) {
      if (Array.isArray(result[field])) {
        declared ||= result[field].includes(name);
        result[field] = result[field].filter(dependency => dependency !== name);
      }
    }
    if (declared) {
      result.peerDependencies ??= {};
      result.peerDependencies[name] = "*";
    }
  }
  return result;
}

export function normalizeManifestFile(file, hostPackages) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(normalizeManifest(manifest, hostPackages), null, 2)}\n`);
}

export function packageRoots(nodeModules) {
  const packages = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory() && !scoped.isSymbolicLink()) packages.push(join(path, scoped.name));
      }
    } else packages.push(path);
  }
  return packages;
}

export function hostPackageRoots(hostEntry, hostPackages) {
  const require = createRequire(hostEntry);
  return Object.fromEntries(hostPackages.map(name => {
    // Locate package roots without requiring a CJS export. Pi's SDK is ESM-only.
    for (const nodeModules of require.resolve.paths(name) ?? []) {
      const directory = join(nodeModules, name);
      const manifest = join(directory, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
        return [name, directory];
      }
    }
    throw new Error(`Cannot locate ${name} in pinned Pi package`);
  }));
}

export function composeHostDependencies(nodeModules, hostEntry, hostPackages) {
  // Resolve every provider before changing the output; a changed Pi layout fails loudly.
  const hosts = hostPackageRoots(hostEntry, hostPackages);
  function normalizeTree(directory) {
    for (const name of hostPackages) rmSync(join(directory, name), { recursive: true, force: true });
    for (const root of packageRoots(directory)) {
      const manifest = join(root, "package.json");
      if (existsSync(manifest)) normalizeManifestFile(manifest, hostPackages);
      const nested = join(root, "node_modules");
      if (existsSync(nested)) normalizeTree(nested);
    }
  }
  normalizeTree(nodeModules);
  for (const [name, source] of Object.entries(hosts)) {
    const destination = join(nodeModules, name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(source, destination);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, path, packagesJson, hostEntry] = process.argv.slice(2);
  const hostPackages = JSON.parse(packagesJson);
  if (mode === "--manifest") normalizeManifestFile(path, hostPackages);
  else if (mode === "--node-modules" && hostEntry) composeHostDependencies(path, hostEntry, hostPackages);
  else throw new Error("Usage: host-packages.mjs --manifest|--node-modules PATH PACKAGES_JSON [HOST_ENTRY]");
}
