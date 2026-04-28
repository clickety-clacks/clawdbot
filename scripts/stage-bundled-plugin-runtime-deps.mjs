import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semverSatisfies from "semver/functions/satisfies.js";
import { resolveNpmRunner } from "./npm-runner.mjs";

const TRANSIENT_TEMP_REMOVE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
const TEMP_REMOVE_RETRY_DELAYS_MS = [10, 25, 50];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readOptionalUtf8(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function isTransientTempRemoveError(error) {
  return (
    !!error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    TRANSIENT_TEMP_REMOVE_ERROR_CODES.has(error.code)
  );
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeTempDir(parentDir, prefix) {
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

function sanitizeTempPrefixSegment(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : "plugin";
}

function makePluginOwnedTempDir(pluginDir, label) {
  return makeTempDir(pluginDir, `.openclaw-runtime-deps-${label}-`);
}

function assertPathIsNotSymlink(targetPath, label) {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`refusing to ${label} via symlinked path: ${targetPath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function replaceDirAtomically(targetPath, sourcePath) {
  assertPathIsNotSymlink(targetPath, "replace runtime deps");
  const targetParentDir = path.dirname(targetPath);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const backupPath = makeTempDir(
    targetParentDir,
    `.openclaw-runtime-deps-backup-${sanitizeTempPrefixSegment(path.basename(targetPath))}-`,
  );
  removePathIfExists(backupPath);

  let movedExistingTarget = false;
  try {
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath);
      movedExistingTarget = true;
    }
    fs.renameSync(sourcePath, targetPath);
    removePathIfExists(backupPath);
  } catch (error) {
    if (movedExistingTarget && !fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
    }
    throw error;
  }
}

function writeJsonAtomically(targetPath, value) {
  assertPathIsNotSymlink(targetPath, "write runtime deps stamp");
  const targetParentDir = path.dirname(targetPath);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const tempDir = makeTempDir(
    targetParentDir,
    `.openclaw-runtime-deps-stamp-${sanitizeTempPrefixSegment(path.basename(targetPath))}-`,
  );
  const tempPath = path.join(tempDir, path.basename(targetPath));
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(tempPath, targetPath);
  } finally {
    removePathIfExists(tempDir);
  }
}

function dependencyPathSegments(depName) {
  if (typeof depName !== "string" || depName.length === 0) {
    return null;
  }
  const segments = depName.split("/");
  if (depName.startsWith("@")) {
    if (segments.length !== 2) {
      return null;
    }
    const [scope, name] = segments;
    if (
      !/^@[A-Za-z0-9._-]+$/.test(scope) ||
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      scope === "@." ||
      scope === "@.."
    ) {
      return null;
    }
    return [scope, name];
  }
  if (segments.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(segments[0])) {
    return null;
  }
  return segments;
}

function dependencyNodeModulesPath(nodeModulesDir, depName) {
  const segments = dependencyPathSegments(depName);
  return segments ? path.join(nodeModulesDir, ...segments) : null;
}

function listPackageRootsInNodeModules(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }
  const packageRoots = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) {
          packageRoots.push(path.join(entryPath, scopedEntry.name));
        }
      }
      continue;
    }
    packageRoots.push(entryPath);
  }
  return packageRoots;
}

function findNestedInstalledDependencyRoots(rootNodeModulesDir, depName) {
  const roots = [];
  const queue = [rootNodeModulesDir];
  const seenNodeModulesDirs = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const nodeModulesDir = queue[index];
    let realNodeModulesDir;
    try {
      realNodeModulesDir = fs.realpathSync(nodeModulesDir);
    } catch {
      continue;
    }
    if (seenNodeModulesDirs.has(realNodeModulesDir)) {
      continue;
    }
    seenNodeModulesDirs.add(realNodeModulesDir);

    const depRoot = dependencyNodeModulesPath(nodeModulesDir, depName);
    if (depRoot !== null && fs.existsSync(path.join(depRoot, "package.json"))) {
      roots.push(depRoot);
    }

    for (const packageRoot of listPackageRootsInNodeModules(nodeModulesDir)) {
      const childNodeModulesDir = path.join(packageRoot, "node_modules");
      if (fs.existsSync(childNodeModulesDir)) {
        queue.push(childNodeModulesDir);
      }
    }
  }
  return roots;
}

function dependencyVersionSatisfied(spec, installedVersion) {
  return semverSatisfies(installedVersion, spec, { includePrerelease: false });
}

function readInstalledDependencyVersionFromRoot(depRoot) {
  const packageJsonPath = path.join(depRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

const defaultStagedRuntimeDepGlobalPruneSuffixes = [".d.ts", ".map"];
const defaultStagedRuntimeDepGlobalPruneDirectories = [
  "__snapshots__",
  "__tests__",
  "test",
  "tests",
];
const defaultStagedRuntimeDepGlobalPruneFilePatterns = [
  /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u,
];
const defaultStagedRuntimeDepPruneRules = new Map([
  // Type declarations only; runtime resolves through lib/es entrypoints.
  ["@larksuiteoapi/node-sdk", { paths: ["types"] }],
  [
    "@matrix-org/matrix-sdk-crypto-nodejs",
    {
      paths: ["index.d.ts", "README.md", "CHANGELOG.md", "RELEASING.md", ".node-version"],
    },
  ],
  [
    "@matrix-org/matrix-sdk-crypto-wasm",
    {
      paths: [
        "index.d.ts",
        "pkg/matrix_sdk_crypto_wasm.d.ts",
        "pkg/matrix_sdk_crypto_wasm_bg.wasm.d.ts",
        "README.md",
      ],
    },
  ],
  [
    "matrix-js-sdk",
    {
      paths: ["src", "CHANGELOG.md", "CONTRIBUTING.rst", "README.md", "release.sh"],
      suffixes: [".d.ts"],
    },
  ],
  ["matrix-widget-api", { paths: ["src"], suffixes: [".d.ts"] }],
  ["oidc-client-ts", { paths: ["README.md"], suffixes: [".d.ts"] }],
  ["music-metadata", { paths: ["README.md"], suffixes: [".d.ts"] }],
  ["@cloudflare/workers-types", { paths: ["."] }],
  ["gifwrap", { paths: ["test"] }],
  ["playwright-core", { paths: ["types"], suffixes: [".d.ts"] }],
  ["@jimp/plugin-blit", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-blur", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-color", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-print", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-quantize", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-threshold", { paths: ["src/__image_snapshots__"] }],
]);
const runtimeDepsStagingVersion = 7;
const exactVersionSpecRe = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveRuntimeDepPruneConfig(params = {}) {
  return {
    globalPruneDirectories:
      params.stagedRuntimeDepGlobalPruneDirectories ??
      defaultStagedRuntimeDepGlobalPruneDirectories,
    globalPruneFilePatterns:
      params.stagedRuntimeDepGlobalPruneFilePatterns ??
      defaultStagedRuntimeDepGlobalPruneFilePatterns,
    globalPruneSuffixes:
      params.stagedRuntimeDepGlobalPruneSuffixes ?? defaultStagedRuntimeDepGlobalPruneSuffixes,
    pruneRules: params.stagedRuntimeDepPruneRules ?? defaultStagedRuntimeDepPruneRules,
  };
}

function resolveInstalledDependencyRoot(params) {
  const candidates = [];
  if (params.parentPackageRoot) {
    const nestedDepRoot = dependencyNodeModulesPath(
      path.join(params.parentPackageRoot, "node_modules"),
      params.depName,
    );
    if (nestedDepRoot !== null) {
      candidates.push(nestedDepRoot);
    }
  }
  const rootDepRoot = dependencyNodeModulesPath(params.rootNodeModulesDir, params.depName);
  if (rootDepRoot !== null) {
    candidates.push(rootDepRoot);
  }
  if (params.enforceSpec !== false) {
    candidates.push(
      ...findNestedInstalledDependencyRoots(params.rootNodeModulesDir, params.depName),
    );
  }

  for (const depRoot of candidates) {
    const installedVersion = readInstalledDependencyVersionFromRoot(depRoot);
    if (installedVersion === null) {
      continue;
    }
    if (params.enforceSpec === false || dependencyVersionSatisfied(params.spec, installedVersion)) {
      return depRoot;
    }
  }

  return null;
}

function collectInstalledRuntimeDependencyRoots(
  rootNodeModulesDir,
  dependencySpecs,
  directDependencyPackageRoot = null,
  optionalDependencyNames = new Set(),
) {
  const packageCache = new Map();
  const directRoots = [];
  const allRoots = [];
  const queue = Object.entries(dependencySpecs).map(([depName, spec]) => ({
    depName,
    optional: optionalDependencyNames.has(depName),
    spec,
    parentPackageRoot: directDependencyPackageRoot,
    direct: true,
  }));
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const depRoot = resolveInstalledDependencyRoot({
      depName: current.depName,
      spec: current.spec,
      enforceSpec: current.direct,
      parentPackageRoot: current.parentPackageRoot,
      rootNodeModulesDir,
    });
    if (depRoot === null) {
      if (current.optional) {
        continue;
      }
      return null;
    }
    const canonicalDepRoot = fs.realpathSync(depRoot);

    const seenKey = `${current.depName}\0${canonicalDepRoot}`;
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);

    const record = { name: current.depName, root: depRoot, realRoot: canonicalDepRoot };
    allRoots.push(record);
    if (current.direct) {
      directRoots.push(record);
    }

    const packageJson =
      packageCache.get(canonicalDepRoot) ?? readJson(path.join(depRoot, "package.json"));
    packageCache.set(canonicalDepRoot, packageJson);
    for (const [childName, childSpec] of Object.entries(packageJson.dependencies ?? {})) {
      queue.push({
        depName: childName,
        optional: false,
        spec: childSpec,
        parentPackageRoot: depRoot,
        direct: false,
      });
    }
    for (const [childName, childSpec] of Object.entries(packageJson.optionalDependencies ?? {})) {
      queue.push({
        depName: childName,
        optional: true,
        spec: childSpec,
        parentPackageRoot: depRoot,
        direct: false,
      });
    }
  }

  return { allRoots, directRoots };
}

function pathIsInsideCopiedRoot(candidateRoot, copiedRoot) {
  return candidateRoot === copiedRoot || candidateRoot.startsWith(`${copiedRoot}${path.sep}`);
}

function findContainingRealRoot(candidatePath, allowedRealRoots) {
  return (
    allowedRealRoots.find((rootPath) => pathIsInsideCopiedRoot(candidatePath, rootPath)) ?? null
  );
}

function isNodeModulesBinPath(filePath) {
  return (
    path.basename(path.dirname(filePath)) === ".bin" &&
    path.basename(path.dirname(path.dirname(filePath))) === "node_modules"
  );
}

function copyMaterializedDependencyTree(params) {
  const { activeRoots, allowedRealRoots, sourcePath, targetPath } = params;
  const sourceStats = fs.lstatSync(sourcePath);

  if (sourceStats.isSymbolicLink()) {
    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(sourcePath);
    } catch {
      return isNodeModulesBinPath(sourcePath);
    }
    const containingRoot = findContainingRealRoot(resolvedPath, allowedRealRoots);
    if (containingRoot === null) {
      return false;
    }
    if (activeRoots.has(containingRoot)) {
      return true;
    }
    const nextActiveRoots = new Set(activeRoots);
    nextActiveRoots.add(containingRoot);
    return copyMaterializedDependencyTree({
      activeRoots: nextActiveRoots,
      allowedRealRoots,
      sourcePath: resolvedPath,
      targetPath,
    });
  }

  if (sourceStats.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs
      .readdirSync(sourcePath, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (
        !copyMaterializedDependencyTree({
          activeRoots,
          allowedRealRoots,
          sourcePath: path.join(sourcePath, entry.name),
          targetPath: path.join(targetPath, entry.name),
        })
      ) {
        return false;
      }
    }
    return true;
  }

  if (sourceStats.isFile()) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, sourceStats.mode);
    return true;
  }

  return true;
}

function selectRuntimeDependencyRootsToCopy(resolution) {
  const rootsToCopy = [];

  for (const record of resolution.directRoots) {
    rootsToCopy.push(record);
  }

  for (const record of resolution.allRoots) {
    if (rootsToCopy.some((entry) => pathIsInsideCopiedRoot(record.realRoot, entry.realRoot))) {
      continue;
    }
    rootsToCopy.push(record);
  }

  return rootsToCopy;
}

function resolveInstalledDirectDependencyNames(
  rootNodeModulesDir,
  dependencySpecs,
  directDependencyPackageRoot = null,
  optionalDependencyNames = new Set(),
) {
  const directDependencyNames = [];
  for (const [depName, spec] of Object.entries(dependencySpecs)) {
    const depRoot = resolveInstalledDependencyRoot({
      depName,
      spec,
      parentPackageRoot: directDependencyPackageRoot,
      rootNodeModulesDir,
    });
    if (depRoot === null) {
      if (optionalDependencyNames.has(depName)) {
        continue;
      }
      return null;
    }
    const installedVersion = readInstalledDependencyVersionFromRoot(depRoot);
    if (installedVersion === null || !dependencyVersionSatisfied(spec, installedVersion)) {
      return null;
    }
    directDependencyNames.push(depName);
  }
  return directDependencyNames;
}

function appendDirectoryFingerprint(hash, rootDir, currentDir = rootDir) {
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
    if (entry.isSymbolicLink()) {
      hash.update(`symlink:${relativePath}->${fs.readlinkSync(fullPath).replace(/\\/g, "/")}\n`);
      continue;
    }
    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\n`);
      appendDirectoryFingerprint(hash, rootDir, fullPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    hash.update(`file:${relativePath}:${stat.size}\n`);
    hash.update(fs.readFileSync(fullPath));
  }
}

function createInstalledRuntimeClosureFingerprint(rootNodeModulesDir, dependencyNames) {
  const hash = createHash("sha256");
  for (const depName of [...dependencyNames].toSorted((left, right) => left.localeCompare(right))) {
    const depRoot = dependencyNodeModulesPath(rootNodeModulesDir, depName);
    if (depRoot === null || !fs.existsSync(depRoot)) {
      return null;
    }
    hash.update(`package:${depName}\n`);
    appendDirectoryFingerprint(hash, depRoot);
  }
  return hash.digest("hex");
}

function resolveInstalledRuntimeClosureFingerprint(params) {
  const dependencySpecs = {
    ...params.packageJson.dependencies,
    ...params.packageJson.optionalDependencies,
  };
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(params.rootNodeModulesDir)) {
    return null;
  }
  const resolution = collectInstalledRuntimeDependencyRoots(
    params.rootNodeModulesDir,
    dependencySpecs,
    params.directDependencyPackageRoot,
    new Set(Object.keys(params.packageJson.optionalDependencies ?? {})),
  );
  if (resolution === null) {
    return null;
  }
  return createInstalledRuntimeClosureFingerprint(
    params.rootNodeModulesDir,
    selectRuntimeDependencyRootsToCopy(resolution).map((record) => record.name),
  );
}

function walkFiles(rootDir, visitFile) {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const queue = [rootDir];
  for (let index = 0; index < queue.length; index += 1) {
    const currentDir = queue[index];
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        visitFile(fullPath);
      }
    }
  }
}

function pruneDependencyFilesBySuffixes(depRoot, suffixes) {
  if (!suffixes || suffixes.length === 0 || !fs.existsSync(depRoot)) {
    return;
  }
  walkFiles(depRoot, (fullPath) => {
    if (suffixes.some((suffix) => fullPath.endsWith(suffix))) {
      removePathIfExists(fullPath);
    }
  });
}

function relativePathSegments(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).filter(Boolean);
}

function isNodeModulesPackageRoot(segments, index) {
  const parent = segments[index - 1];
  if (parent === "node_modules") {
    return true;
  }
  return parent?.startsWith("@") === true && segments[index - 2] === "node_modules";
}

function pruneDependencyDirectoriesByBasename(depRoot, basenames) {
  if (!basenames || basenames.length === 0 || !fs.existsSync(depRoot)) {
    return;
  }
  const basenameSet = new Set(basenames);
  const queue = [depRoot];
  for (let index = 0; index < queue.length; index += 1) {
    const currentDir = queue[index];
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const segments = relativePathSegments(depRoot, fullPath);
      if (basenameSet.has(entry.name) && !isNodeModulesPackageRoot(segments, segments.length - 1)) {
        removePathIfExists(fullPath);
        continue;
      }
      queue.push(fullPath);
    }
  }
}

function pruneDependencyFilesByPatterns(depRoot, patterns) {
  if (!patterns || patterns.length === 0 || !fs.existsSync(depRoot)) {
    return;
  }
  walkFiles(depRoot, (fullPath) => {
    const relativePath = relativePathSegments(depRoot, fullPath).join("/");
    if (patterns.some((pattern) => pattern.test(relativePath))) {
      removePathIfExists(fullPath);
    }
  });
}

function pruneStagedInstalledDependencyCargo(nodeModulesDir, depName, pruneConfig) {
  const depRoot = dependencyNodeModulesPath(nodeModulesDir, depName);
  if (depRoot === null) {
    return;
  }
  const pruneRule = pruneConfig.pruneRules.get(depName);
  for (const relativePath of pruneRule?.paths ?? []) {
    removePathIfExists(path.join(depRoot, relativePath));
  }
  pruneDependencyDirectoriesByBasename(depRoot, pruneConfig.globalPruneDirectories);
  pruneDependencyFilesByPatterns(depRoot, pruneConfig.globalPruneFilePatterns);
  pruneDependencyFilesBySuffixes(depRoot, pruneConfig.globalPruneSuffixes);
  pruneDependencyFilesBySuffixes(depRoot, pruneRule?.suffixes ?? []);
}

function listInstalledDependencyNames(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }
  const names = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      for (const scopedEntry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) {
          names.push(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

function pruneStagedRuntimeDependencyCargo(nodeModulesDir, pruneConfig) {
  for (const depName of listInstalledDependencyNames(nodeModulesDir)) {
    pruneStagedInstalledDependencyCargo(nodeModulesDir, depName, pruneConfig);
  }
}

function listBundledPluginRuntimeDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(extensionsRoot, dirent.name))
    .filter((pluginDir) => fs.existsSync(path.join(pluginDir, "package.json")));
}

function resolveInstalledWorkspacePluginRoot(repoRoot, pluginId) {
  const currentPluginRoot = path.join(repoRoot, "extensions", pluginId);
  if (fs.existsSync(path.join(currentPluginRoot, "node_modules"))) {
    return currentPluginRoot;
  }

  const nodeModulesDir = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    return currentPluginRoot;
  }

  let installedWorkspaceRoot;
  try {
    installedWorkspaceRoot = path.dirname(fs.realpathSync(nodeModulesDir));
  } catch {
    return currentPluginRoot;
  }

  const installedPluginRoot = path.join(installedWorkspaceRoot, "extensions", pluginId);
  if (fs.existsSync(path.join(installedPluginRoot, "package.json"))) {
    return installedPluginRoot;
  }

  return currentPluginRoot;
}

function hasRuntimeDeps(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function shouldStageRuntimeDeps(packageJson) {
  return packageJson.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  if (packageJson.peerDependencies) {
    delete packageJson.peerDependencies;
    changed = true;
  }

  if (packageJson.peerDependenciesMeta) {
    delete packageJson.peerDependenciesMeta;
    changed = true;
  }

  if (packageJson.devDependencies) {
    delete packageJson.devDependencies;
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }

  return packageJson;
}

function isSafeRuntimeDependencySpec(spec) {
  if (typeof spec !== "string") {
    return false;
  }
  const normalized = spec.trim();
  if (normalized.length === 0) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (
    lower.startsWith("file:") ||
    lower.startsWith("link:") ||
    lower.startsWith("workspace:") ||
    lower.startsWith("git:") ||
    lower.startsWith("git+") ||
    lower.startsWith("ssh:") ||
    lower.startsWith("http:") ||
    lower.startsWith("https:")
  ) {
    return false;
  }
  if (normalized.includes("://")) {
    return false;
  }
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    normalized.startsWith("../") ||
    normalized.startsWith("..\\") ||
    normalized.includes("/../") ||
    normalized.includes("\\..\\")
  ) {
    return false;
  }
  return true;
}

function normalizeNativeRuntimeDependencyLoadPath(depName, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`native runtime dependency ${depName} has an invalid load path`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`native runtime dependency ${depName} load path must be relative: ${value}`);
  }
  const segments = value.split(/[\\/]+/u).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`native runtime dependency ${depName} load path must stay inside the package`);
  }
  return segments.join(path.sep);
}

function normalizeNativeRuntimeDependencySpec(entry) {
  if (typeof entry === "string") {
    if (dependencyPathSegments(entry) === null) {
      throw new Error(`invalid native runtime dependency name: ${entry}`);
    }
    return { name: entry, loadPaths: [] };
  }
  if (!isPlainObject(entry) || typeof entry.name !== "string") {
    throw new Error("native runtime dependency entries must be package names or objects");
  }
  if (dependencyPathSegments(entry.name) === null) {
    throw new Error(`invalid native runtime dependency name: ${entry.name}`);
  }
  if (entry.loadPaths !== undefined && !Array.isArray(entry.loadPaths)) {
    throw new Error(`native runtime dependency ${entry.name} loadPaths must be an array`);
  }
  const loadPaths = (entry.loadPaths ?? []).map((loadPath) =>
    normalizeNativeRuntimeDependencyLoadPath(entry.name, loadPath),
  );
  return { name: entry.name, loadPaths };
}

function collectNativeRuntimeDependencySpecs(packageJson) {
  const raw = packageJson.openclaw?.bundle?.nativeRuntimeDependencies;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("openclaw.bundle.nativeRuntimeDependencies must be an array");
  }
  const runtimeDependencyNames = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ]);
  return raw.map((entry) => {
    const spec = normalizeNativeRuntimeDependencySpec(entry);
    if (!runtimeDependencyNames.has(spec.name)) {
      throw new Error(
        `native runtime dependency ${spec.name} must also be declared as a runtime dependency`,
      );
    }
    return spec;
  });
}

function createNativeRuntimeEnvironmentFingerprint(packageJson) {
  if (collectNativeRuntimeDependencySpecs(packageJson).length === 0) {
    return null;
  }
  return {
    arch: process.arch,
    nodeModuleVersion: process.versions.modules ?? null,
    platform: process.platform,
  };
}

function assertSafeRuntimeDependencySpec(depName, spec) {
  if (!isSafeRuntimeDependencySpec(spec)) {
    throw new Error(`disallowed runtime dependency spec for ${depName}: ${spec}`);
  }
}

function resolveInstalledPinnedDependencyVersion(params) {
  const depRoot = resolveInstalledDependencyRoot({
    depName: params.depName,
    enforceSpec: true,
    parentPackageRoot: params.parentPackageRoot,
    rootNodeModulesDir: params.rootNodeModulesDir,
    spec: params.spec,
  });
  if (depRoot === null) {
    return null;
  }
  return readInstalledDependencyVersionFromRoot(depRoot);
}

function resolvePinnedRuntimeDependencyVersion(params) {
  assertSafeRuntimeDependencySpec(params.depName, params.spec);
  if (exactVersionSpecRe.test(params.spec)) {
    return params.spec;
  }
  const installedVersion = resolveInstalledPinnedDependencyVersion(params);
  if (typeof installedVersion === "string" && exactVersionSpecRe.test(installedVersion)) {
    return installedVersion;
  }
  throw new Error(
    `runtime dependency ${params.depName} must resolve to an exact installed version, got: ${params.spec}`,
  );
}

function collectRuntimeDependencyGroups(packageJson) {
  const readRuntimeGroup = (group) =>
    Object.fromEntries(
      Object.entries(group ?? {}).filter(
        (entry) => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  return {
    dependencies: readRuntimeGroup(packageJson.dependencies),
    optionalDependencies: readRuntimeGroup(packageJson.optionalDependencies),
  };
}

function resolvePinnedRuntimeDependencyGroup(group, params = {}) {
  return Object.fromEntries(
    Object.entries(group).map(([name, version]) => {
      const pinnedVersion = resolvePinnedRuntimeDependencyVersion({
        depName: name,
        parentPackageRoot: params.directDependencyPackageRoot ?? null,
        rootNodeModulesDir: params.rootNodeModulesDir ?? path.join(process.cwd(), "node_modules"),
        spec: version,
      });
      return [name, pinnedVersion];
    }),
  );
}

function resolvePinnedRuntimeDependencyGroups(packageJson, params = {}) {
  const runtimeGroups = collectRuntimeDependencyGroups(packageJson);
  return {
    dependencies: resolvePinnedRuntimeDependencyGroup(runtimeGroups.dependencies, params),
    optionalDependencies: resolvePinnedRuntimeDependencyGroup(
      runtimeGroups.optionalDependencies,
      params,
    ),
  };
}

export function collectRuntimeDependencyInstallManifest(packageJson, params = {}) {
  const pinnedGroups = resolvePinnedRuntimeDependencyGroups(packageJson, params);
  return createRuntimeInstallManifest(params.pluginId ?? "runtime-deps", pinnedGroups);
}

export function collectRuntimeDependencyInstallSpecs(packageJson, params = {}) {
  const manifest = collectRuntimeDependencyInstallManifest(packageJson, params);
  const buildSpecs = (group) =>
    Object.entries(group ?? {}).map(([name, version]) => `${name}@${String(version)}`);
  return {
    dependencies: buildSpecs(manifest.dependencies),
    optionalDependencies: buildSpecs(manifest.optionalDependencies),
  };
}

function createRuntimeInstallManifest(pluginId, pinnedGroups) {
  const manifest = {
    name: `openclaw-runtime-deps-${sanitizeTempPrefixSegment(pluginId)}`,
    private: true,
    version: "0.0.0",
  };
  if (Object.keys(pinnedGroups.dependencies).length > 0) {
    manifest.dependencies = pinnedGroups.dependencies;
  }
  if (Object.keys(pinnedGroups.optionalDependencies).length > 0) {
    manifest.optionalDependencies = pinnedGroups.optionalDependencies;
  }
  return manifest;
}

function runNpmInstall(params) {
  const npmEnv = {
    ...(params.npmRunner.env ?? process.env),
    CI: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_legacy_peer_deps: "true",
    npm_config_loglevel: "error",
    npm_config_package_lock: "false",
    npm_config_progress: "false",
    npm_config_save: "false",
    npm_config_yes: "true",
  };
  const result = spawnSync(params.npmRunner.command, params.npmRunner.args, {
    cwd: params.cwd,
    encoding: "utf8",
    env: npmEnv,
    shell: params.npmRunner.shell,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: params.timeoutMs ?? 5 * 60 * 1000,
    windowsVerbatimArguments: params.npmRunner.windowsVerbatimArguments,
  });
  if (result.status === 0) {
    return;
  }
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(output || "npm install failed");
}

function resolveLegacyRuntimeDepsStampPath(pluginDir) {
  return path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
}

function resolveRuntimeDepsStampPath(repoRoot, pluginId) {
  return path.join(
    repoRoot,
    ".artifacts",
    "bundled-runtime-deps-stamps",
    `${sanitizeTempPrefixSegment(pluginId)}.json`,
  );
}

function createRuntimeDepsFingerprint(packageJson, pruneConfig, params = {}) {
  const repoRoot = params.repoRoot;
  const lockfilePath =
    typeof repoRoot === "string" && repoRoot.length > 0
      ? path.join(repoRoot, "pnpm-lock.yaml")
      : null;
  const rootLockfile = lockfilePath ? readOptionalUtf8(lockfilePath) : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        globalPruneDirectories: pruneConfig.globalPruneDirectories,
        globalPruneFilePatterns: pruneConfig.globalPruneFilePatterns.map((pattern) =>
          pattern.toString(),
        ),
        globalPruneSuffixes: pruneConfig.globalPruneSuffixes,
        packageJson,
        nativeRuntime: createNativeRuntimeEnvironmentFingerprint(packageJson),
        pruneRules: [...pruneConfig.pruneRules.entries()],
        rootInstalledRuntimeFingerprint: params.rootInstalledRuntimeFingerprint ?? null,
        rootLockfile,
        version: runtimeDepsStagingVersion,
      }),
    )
    .digest("hex");
}

function runNodeRequire(modulePath) {
  const result = spawnSync(process.execPath, ["-e", "require(process.argv[1])", modulePath], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60 * 1000,
  });
  if (result.status === 0) {
    return { ok: true };
  }
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  return { ok: false, error: output || "native dependency load check failed" };
}

function verifyNativeRuntimeDependency(params) {
  const depRoot = dependencyNodeModulesPath(params.nodeModulesDir, params.spec.name);
  if (depRoot === null) {
    return { ok: false, error: `invalid native dependency name: ${params.spec.name}` };
  }
  if (!fs.existsSync(depRoot)) {
    if (params.optionalDependencyNames.has(params.spec.name)) {
      return { ok: true };
    }
    return { ok: false, error: `native dependency ${params.spec.name} was not staged` };
  }
  const loadPaths =
    params.spec.loadPaths.length > 0 ? params.spec.loadPaths : [path.join("package.json")];
  for (const loadPath of loadPaths) {
    const modulePath = path.join(depRoot, loadPath);
    if (!fs.existsSync(modulePath)) {
      return {
        ok: false,
        error: `native dependency ${params.spec.name} load path was not staged: ${loadPath}`,
      };
    }
    const result = runNodeRequire(modulePath);
    if (!result.ok) {
      return {
        ok: false,
        error: `native dependency ${params.spec.name} failed load check at ${loadPath}: ${result.error}`,
      };
    }
  }
  return { ok: true };
}

function runNpmRebuild(params) {
  const npmRunner = resolveNpmRunner({ npmArgs: ["rebuild", params.depName] });
  const npmEnv = {
    ...(npmRunner.env ?? process.env),
    CI: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "false",
    npm_config_legacy_peer_deps: "true",
    npm_config_loglevel: "error",
    npm_config_package_lock: "false",
    npm_config_progress: "false",
    npm_config_save: "false",
    npm_config_yes: "true",
  };
  const result = spawnSync(npmRunner.command, npmRunner.args, {
    cwd: params.cwd,
    encoding: "utf8",
    env: npmEnv,
    shell: npmRunner.shell,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000,
    windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
  });
  if (result.status === 0) {
    return;
  }
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(output || `npm rebuild ${params.depName} failed`);
}

function repairNativeRuntimeDependencies(params) {
  const specs = collectNativeRuntimeDependencySpecs(params.packageJson);
  if (specs.length === 0) {
    return;
  }
  const nodeModulesDir = path.join(params.pluginDir, "node_modules");
  const optionalDependencyNames = new Set(
    Object.keys(params.packageJson.optionalDependencies ?? {}),
  );
  for (const spec of specs) {
    const initialCheck = verifyNativeRuntimeDependency({
      nodeModulesDir,
      optionalDependencyNames,
      spec,
    });
    if (!initialCheck.ok) {
      runNpmRebuild({ cwd: params.pluginDir, depName: spec.name });
      const postRebuildCheck = verifyNativeRuntimeDependency({
        nodeModulesDir,
        optionalDependencyNames,
        spec,
      });
      if (!postRebuildCheck.ok) {
        throw new Error(
          `failed to repair native runtime dependency for ${params.pluginId}: ${postRebuildCheck.error}`,
        );
      }
    }
  }
}

function readRuntimeDepsStamp(stampPath) {
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return readJson(stampPath);
  } catch {
    return null;
  }
}

function removeStaleRuntimeDepsTempDirs(pluginDir) {
  if (!fs.existsSync(pluginDir)) {
    return;
  }
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".openclaw-runtime-deps-")) {
      const targetPath = path.join(pluginDir, entry.name);
      for (let attempt = 0; attempt <= TEMP_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          removePathIfExists(targetPath);
          break;
        } catch (error) {
          if (!isTransientTempRemoveError(error)) {
            throw error;
          }
          const delay = TEMP_REMOVE_RETRY_DELAYS_MS[attempt];
          if (delay === undefined) {
            break;
          }
          sleepSync(delay);
        }
      }
    }
  }
}

function stageInstalledRootRuntimeDeps(params) {
  const {
    directDependencyPackageRoot = null,
    fingerprint,
    packageJson,
    pluginDir,
    pruneConfig,
    repoRoot,
    repairNativeRuntimeDependenciesImpl,
    stampPath,
  } = params;
  const dependencySpecs = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const optionalDependencyNames = new Set(Object.keys(packageJson.optionalDependencies ?? {}));
  const rootNodeModulesDir = path.join(repoRoot, "node_modules");
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(rootNodeModulesDir)) {
    return false;
  }

  const directDependencyNames = resolveInstalledDirectDependencyNames(
    rootNodeModulesDir,
    dependencySpecs,
    directDependencyPackageRoot,
    optionalDependencyNames,
  );
  if (directDependencyNames === null) {
    return false;
  }
  const resolution = collectInstalledRuntimeDependencyRoots(
    rootNodeModulesDir,
    dependencySpecs,
    directDependencyPackageRoot,
    optionalDependencyNames,
  );
  if (resolution === null) {
    return false;
  }
  const rootsToCopy = selectRuntimeDependencyRootsToCopy(resolution);
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  if (rootsToCopy.length === 0) {
    assertPathIsNotSymlink(nodeModulesDir, "remove runtime deps");
    removePathIfExists(nodeModulesDir);
    writeJsonAtomically(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  }
  const allowedRealRoots = rootsToCopy.map((record) => record.realRoot);

  const stagedNodeModulesDir = path.join(
    makePluginOwnedTempDir(pluginDir, "stage"),
    "node_modules",
  );

  try {
    for (const record of rootsToCopy.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const sourcePath = record.realRoot;
      const targetPath = dependencyNodeModulesPath(stagedNodeModulesDir, record.name);
      if (targetPath === null) {
        return false;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const sourceRootReal = findContainingRealRoot(sourcePath, allowedRealRoots);
      if (
        sourceRootReal === null ||
        !copyMaterializedDependencyTree({
          activeRoots: new Set([sourceRootReal]),
          allowedRealRoots,
          sourcePath,
          targetPath,
        })
      ) {
        return false;
      }
    }
    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir, pruneConfig);

    replaceDirAtomically(nodeModulesDir, stagedNodeModulesDir);
    repairNativeRuntimeDependenciesImpl({
      packageJson,
      pluginDir,
      pluginId: path.basename(pluginDir),
    });
    writeJsonAtomically(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    removePathIfExists(path.dirname(stagedNodeModulesDir));
  }
}

function installPluginRuntimeDepsWithRetries(params) {
  const { attempts = 3 } = params;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      params.install({ ...params.installParams, attempt });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
    }
  }
  throw lastError;
}

function createRootRuntimeStagingError(params) {
  const runtimeDependencyNames = [
    ...Object.keys(params.packageJson.dependencies ?? {}),
    ...Object.keys(params.packageJson.optionalDependencies ?? {}),
  ].toSorted((left, right) => left.localeCompare(right));
  const dependencyLabel =
    runtimeDependencyNames.length > 0 ? runtimeDependencyNames.join(", ") : "<none>";
  const causeMessage =
    params.cause instanceof Error && typeof params.cause.message === "string"
      ? ` Cause: ${params.cause.message}`
      : "";
  return new Error(
    `failed to stage bundled runtime deps for ${params.pluginId}: ` +
      `runtime dependency closure must resolve from the installed root workspace graph. ` +
      `Could not materialize: ${dependencyLabel}. ` +
      "Run `pnpm install` and rebuild from a trusted workspace checkout, or provide a hardened fallback installer." +
      causeMessage,
  );
}

function installPluginRuntimeDeps(params) {
  const {
    directDependencyPackageRoot = null,
    fingerprint,
    packageJson,
    pluginDir,
    pluginId,
    pruneConfig,
    repoRoot,
    repairNativeRuntimeDependenciesImpl = repairNativeRuntimeDependencies,
    stampPath,
  } = params;
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const tempInstallDir = makePluginOwnedTempDir(pluginDir, "install");
  const pinnedGroups = resolvePinnedRuntimeDependencyGroups(packageJson, {
    directDependencyPackageRoot,
    rootNodeModulesDir: path.join(repoRoot, "node_modules"),
  });
  const requiredDependencyCount = Object.keys(pinnedGroups.dependencies).length;
  try {
    writeJson(
      path.join(tempInstallDir, "package.json"),
      createRuntimeInstallManifest(pluginId, pinnedGroups),
    );
    if (requiredDependencyCount > 0 || Object.keys(pinnedGroups.optionalDependencies).length > 0) {
      runNpmInstall({
        cwd: tempInstallDir,
        npmRunner: resolveNpmRunner({
          npmArgs: ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--silent"],
        }),
      });
    }
    const stagedNodeModulesDir = path.join(tempInstallDir, "node_modules");
    if (requiredDependencyCount > 0 && !fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: explicit npm install produced no node_modules directory`,
      );
    }
    if (fs.existsSync(stagedNodeModulesDir)) {
      pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir, pruneConfig);
      replaceDirAtomically(nodeModulesDir, stagedNodeModulesDir);
      repairNativeRuntimeDependenciesImpl({ packageJson, pluginDir, pluginId });
    } else {
      assertPathIsNotSymlink(nodeModulesDir, "remove runtime deps");
      removePathIfExists(nodeModulesDir);
    }
    writeJsonAtomically(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removePathIfExists(tempInstallDir);
  }
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const installPluginRuntimeDepsImpl =
    params.installPluginRuntimeDepsImpl ?? installPluginRuntimeDeps;
  const installAttempts = params.installAttempts ?? 3;
  const pruneConfig = resolveRuntimeDepPruneConfig(params);
  const repairNativeRuntimeDependenciesImpl =
    params.repairNativeRuntimeDependenciesImpl ?? repairNativeRuntimeDependencies;
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const sourcePluginRoot = resolveInstalledWorkspacePluginRoot(repoRoot, pluginId);
    const directDependencyPackageRoot = fs.existsSync(path.join(sourcePluginRoot, "package.json"))
      ? sourcePluginRoot
      : null;
    const packageJson = sanitizeBundledManifestForRuntimeInstall(pluginDir);
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    const stampPath = resolveRuntimeDepsStampPath(repoRoot, pluginId);
    const legacyStampPath = resolveLegacyRuntimeDepsStampPath(pluginDir);
    removePathIfExists(legacyStampPath);
    removeStaleRuntimeDepsTempDirs(pluginDir);
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      removePathIfExists(nodeModulesDir);
      removePathIfExists(stampPath);
      continue;
    }
    const rootInstalledRuntimeFingerprint = resolveInstalledRuntimeClosureFingerprint({
      directDependencyPackageRoot,
      packageJson,
      rootNodeModulesDir: path.join(repoRoot, "node_modules"),
    });
    const fingerprint = createRuntimeDepsFingerprint(packageJson, pruneConfig, {
      repoRoot,
      rootInstalledRuntimeFingerprint,
    });
    const stamp = readRuntimeDepsStamp(stampPath);
    if (fs.existsSync(nodeModulesDir) && stamp?.fingerprint === fingerprint) {
      continue;
    }
    if (
      stageInstalledRootRuntimeDeps({
        directDependencyPackageRoot,
        fingerprint,
        packageJson,
        pluginDir,
        pruneConfig,
        repoRoot,
        repairNativeRuntimeDependenciesImpl,
        stampPath,
      })
    ) {
      continue;
    }
    try {
      installPluginRuntimeDepsWithRetries({
        attempts: installAttempts,
        install: installPluginRuntimeDepsImpl,
        installParams: {
          directDependencyPackageRoot,
          fingerprint,
          packageJson,
          pluginDir,
          pluginId,
          pruneConfig,
          repoRoot,
          repairNativeRuntimeDependenciesImpl,
          stampPath,
        },
      });
    } catch (error) {
      throw createRootRuntimeStagingError({ packageJson, pluginId, cause: error });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}
