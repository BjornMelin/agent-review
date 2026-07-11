import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const RELEASE_MANIFEST_SCHEMA = 'review-agent.release-manifest.v1';
export const RELEASE_MANIFEST_NAME = 'RELEASE_MANIFEST.json';
export const MINIMUM_NODE_MAJOR = 24;
export const LINUX_GLIBC_MINIMUM = '2.39';

export const SUPPORTED_TARGETS = Object.freeze({
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-x64',
  'linux-arm64': 'linux-arm64-gnu',
  'linux-x64': 'linux-x64-gnu',
  'win32-x64': 'windows-x64',
});

const ROOT_FILES = new Set([
  'LICENSE',
  'README.md',
  RELEASE_MANIFEST_NAME,
  'bin',
  'dist',
  'node_modules',
  'package.json',
]);

const ROOT_DIST_FILES = new Set([
  'index.d.ts',
  'index.js',
  'service-client.d.ts',
  'service-client.js',
]);

const ROOT_BIN_FILES = new Set(['review-agent', 'review-agent.cmd']);

const WORKSPACE_RUNTIME_FILES = Object.freeze({
  'review-convex-bridge': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-core': new Set(['dist/index.d.ts', 'dist/index.js', 'package.json']),
  'review-git': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'dist/rust-diff-index.d.ts',
    'dist/rust-diff-index.js',
    'package.json',
  ]),
  'review-prompts': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-provider-codex': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-provider-openai': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-provider-registry': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-reporters': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-runner': new Set([
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]),
  'review-types': new Set(['dist/index.d.ts', 'dist/index.js', 'package.json']),
});

export const INTERNAL_RUNTIME_PACKAGES = Object.freeze(
  Object.keys(WORKSPACE_RUNTIME_FILES)
);

export const RUNTIME_PACKAGE_MANIFEST_FIELDS = Object.freeze([
  'name',
  'version',
  'private',
  'license',
  'type',
  'main',
  'types',
  'exports',
  'bin',
  'engines',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]);

const PACKAGE_MANAGER_METADATA_NAMES = new Set([
  '.modules.yaml',
  '.pnpm-workspace-state-v1.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);

function posixPath(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function compareDottedVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function resolveReleaseTarget({ arch, glibcVersionRuntime, platform }) {
  const key = `${platform}-${arch}`;
  const target = SUPPORTED_TARGETS[key];
  if (!target) {
    throw new Error(
      `unsupported release host ${key}; supported hosts: ${Object.keys(
        SUPPORTED_TARGETS
      ).join(', ')}`
    );
  }
  if (platform === 'linux' && !glibcVersionRuntime) {
    throw new Error(
      'unsupported Linux C runtime; release archives require glibc'
    );
  }
  if (
    platform === 'linux' &&
    compareDottedVersions(glibcVersionRuntime, LINUX_GLIBC_MINIMUM) < 0
  ) {
    throw new Error(
      `unsupported GLIBC_${glibcVersionRuntime}; release archives require GLIBC_${LINUX_GLIBC_MINIMUM} or newer`
    );
  }
  return target;
}

export function currentReleaseTarget() {
  const glibcVersionRuntime =
    process.platform === 'linux'
      ? process.report?.getReport()?.header?.glibcVersionRuntime
      : undefined;
  return resolveReleaseTarget({
    arch: process.arch,
    glibcVersionRuntime,
    platform: process.platform,
  });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function collectTree(root, options = {}) {
  const exclude = new Set(options.exclude ?? []);
  const includeDirectories = options.includeDirectories ?? false;
  const entries = [];

  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = `${directory}/${child.name}`;
      const relativePath = posixPath(relative(root, absolutePath));
      if (exclude.has(relativePath)) {
        continue;
      }
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        if (includeDirectories) {
          entries.push({ path: relativePath, type: 'directory' });
        }
        await walk(absolutePath);
        continue;
      }
      if (stats.isSymbolicLink()) {
        const linkTarget = posixPath(await readlink(absolutePath));
        const resolvedTarget = resolve(dirname(absolutePath), linkTarget);
        const targetWithinRoot = relative(root, resolvedTarget);
        if (
          isAbsolute(linkTarget) ||
          targetWithinRoot === '..' ||
          targetWithinRoot.startsWith(`..${sep}`) ||
          isAbsolute(targetWithinRoot)
        ) {
          throw new Error(
            `release tree contains escaping symlink: ${relativePath} -> ${linkTarget}`
          );
        }
        entries.push({
          path: relativePath,
          type: 'symlink',
          size: Buffer.byteLength(linkTarget),
          sha256: await sha256Text(linkTarget),
          linkTarget,
        });
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(
          `release tree contains unsupported entry: ${relativePath}`
        );
      }
      entries.push({
        path: relativePath,
        type: 'file',
        size: stats.size,
        sha256: await sha256File(absolutePath),
      });
    }
  }

  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function assertExactNames(actual, expected, label) {
  const unexpected = [...actual].filter((name) => !expected.has(name));
  const missing = [...expected].filter((name) => !actual.has(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} allowlist mismatch; unexpected=[${unexpected.join(
        ', '
      )}] missing=[${missing.join(', ')}]`
    );
  }
}

function isPackageManagerMetadataPath(path) {
  const segments = path.split('/');
  return (
    segments.includes('.pnpm') ||
    segments.includes('.bin') ||
    segments.some((segment) => PACKAGE_MANAGER_METADATA_NAMES.has(segment))
  );
}

function isRuntimePackageManifest(path) {
  return (
    path === 'package.json' ||
    /(?:^|\/)node_modules\/@review-agent\/[^/]+\/package\.json$/.test(path)
  );
}

export async function assertReleaseAllowlist(root, options = {}) {
  const target = options.target ?? currentReleaseTarget();
  const rootNames = new Set(await readdir(root));
  const expectedRootFiles = new Set(ROOT_FILES);
  if (options.beforeManifest) {
    expectedRootFiles.delete(RELEASE_MANIFEST_NAME);
  }
  assertExactNames(rootNames, expectedRootFiles, 'release root');

  assertExactNames(
    new Set(await readdir(`${root}/dist`)),
    ROOT_DIST_FILES,
    'release dist'
  );
  assertExactNames(
    new Set(await readdir(`${root}/bin`)),
    ROOT_BIN_FILES,
    'release bin'
  );

  const nodeModulesRootNames = await readdir(`${root}/node_modules`);
  const forbiddenNodeModulesRoots = nodeModulesRootNames.filter((name) =>
    isPackageManagerMetadataPath(name)
  );
  if (forbiddenNodeModulesRoots.length > 0) {
    throw new Error(
      `release contains package-manager metadata or shims: ${forbiddenNodeModulesRoots
        .sort()
        .map((name) => `node_modules/${name}`)
        .join(', ')}`
    );
  }

  const tree = await collectTree(root, {
    exclude: options.beforeManifest ? [] : [RELEASE_MANIFEST_NAME],
  });
  const packageManagerMetadata = tree
    .filter((entry) => isPackageManagerMetadataPath(entry.path))
    .map((entry) => entry.path);
  if (packageManagerMetadata.length > 0) {
    throw new Error(
      `release contains package-manager metadata or shims: ${packageManagerMetadata.join(', ')}`
    );
  }
  for (const entry of tree) {
    const match = entry.path.match(
      /(?:^|\/)node_modules\/@review-agent\/([^/]+)(?:\/(.+))?$/
    );
    if (!match) {
      continue;
    }
    const [, packageName, packagePath] = match;
    if (!packagePath && entry.type === 'symlink') {
      continue;
    }
    const baseAllowlist = WORKSPACE_RUNTIME_FILES[packageName];
    if (!baseAllowlist) {
      throw new Error(
        `release contains unexpected internal package @review-agent/${packageName}`
      );
    }
    const allowlist = new Set(baseAllowlist);
    const windowsTarget = target === 'windows-x64';
    if (packageName === 'review-git') {
      allowlist.add(`dist/bin/review-git-diff${windowsTarget ? '.exe' : ''}`);
    }
    if (packageName === 'review-runner') {
      allowlist.add(`dist/bin/review-runner${windowsTarget ? '.exe' : ''}`);
    }
    if (!packagePath || !allowlist.has(packagePath)) {
      throw new Error(
        `release contains non-runtime internal artifact @review-agent/${packageName}/${
          packagePath ?? ''
        }`
      );
    }
  }

  const internalPackages = new Set(
    tree.flatMap((entry) => {
      const match = entry.path.match(
        /(?:^|\/)node_modules\/@review-agent\/([^/]+)\/package\.json$/
      );
      return match ? [match[1]] : [];
    })
  );
  assertExactNames(
    internalPackages,
    new Set(Object.keys(WORKSPACE_RUNTIME_FILES)),
    'internal runtime package'
  );

  return tree;
}

function pathRepresentations(path) {
  return [
    ...new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]),
  ];
}

export async function assertNoReleaseBuildLeaks(root, entries, options = {}) {
  const forbiddenTextRoots = (options.forbiddenTextRoots ?? []).filter(
    (value) => typeof value === 'string' && value.length > 0
  );
  for (const entry of entries) {
    if (entry.type !== 'file') {
      continue;
    }
    const contents = await readFile(join(root, ...entry.path.split('/')));
    if (!contents.includes(0)) {
      const text = contents.toString('utf8');
      for (const forbiddenRoot of forbiddenTextRoots) {
        const leaked = pathRepresentations(forbiddenRoot).find((candidate) =>
          text.includes(candidate)
        );
        if (leaked) {
          throw new Error(
            `release text artifact leaks a build path in ${entry.path}: ${leaked}`
          );
        }
      }
    }
    if (isRuntimePackageManifest(entry.path)) {
      const manifestText = contents.toString('utf8');
      if (/\b(?:file|workspace):/.test(manifestText)) {
        throw new Error(
          `runtime package manifest contains a workspace or file dependency: ${entry.path}`
        );
      }
    }
  }
}

export async function assertRuntimePackageManifests(root, entries) {
  const manifestEntries = entries.filter(
    (entry) => entry.type === 'file' && isRuntimePackageManifest(entry.path)
  );
  const manifests = await Promise.all(
    manifestEntries.map(async (entry) => ({
      path: entry.path,
      metadata: JSON.parse(
        await readFile(join(root, ...entry.path.split('/')), 'utf8')
      ),
    }))
  );
  const versions = new Map(
    manifests.map(({ metadata }) => [metadata.name, metadata.version])
  );
  const allowedFields = new Set(RUNTIME_PACKAGE_MANIFEST_FIELDS);
  for (const { path, metadata } of manifests) {
    const unexpectedFields = Object.keys(metadata).filter(
      (field) => !allowedFields.has(field)
    );
    if (unexpectedFields.length > 0) {
      throw new Error(
        `runtime package manifest contains build-only fields in ${path}: ${unexpectedFields.join(', ')}`
      );
    }
    if (
      typeof metadata.name !== 'string' ||
      typeof metadata.version !== 'string' ||
      metadata.private !== true ||
      metadata.type !== 'module'
    ) {
      throw new Error(
        `runtime package manifest has invalid identity fields: ${path}`
      );
    }
    for (const dependencyField of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, version] of Object.entries(
        metadata[dependencyField] ?? {}
      )) {
        const internalVersion = versions.get(name);
        if (internalVersion && version !== internalVersion) {
          throw new Error(
            `runtime package manifest does not pin ${name}@${internalVersion} in ${path}`
          );
        }
      }
    }
  }
}

export async function assertFileOmitsPrefixes(path, prefixes, label) {
  const contents = await readFile(path);
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
      continue;
    }
    const leaked = pathRepresentations(prefix).find((candidate) =>
      contents.includes(Buffer.from(candidate))
    );
    if (leaked) {
      throw new Error(`${label} leaks build path prefix: ${leaked}`);
    }
  }
}

function readElfSectionNames(contents) {
  const is64Bit = contents[4] === 2;
  const isLittleEndian = contents[5] === 1;
  if (!is64Bit || !isLittleEndian) {
    throw new Error(
      'release ELF hygiene check supports 64-bit little-endian binaries'
    );
  }
  const sectionOffset = Number(contents.readBigUInt64LE(0x28));
  const sectionEntrySize = contents.readUInt16LE(0x3a);
  const sectionCount = contents.readUInt16LE(0x3c);
  const stringTableIndex = contents.readUInt16LE(0x3e);
  const stringTableHeader = sectionOffset + stringTableIndex * sectionEntrySize;
  const stringTableOffset = Number(
    contents.readBigUInt64LE(stringTableHeader + 0x18)
  );
  const stringTableSize = Number(
    contents.readBigUInt64LE(stringTableHeader + 0x20)
  );
  const stringTable = contents.subarray(
    stringTableOffset,
    stringTableOffset + stringTableSize
  );
  const names = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionOffset + index * sectionEntrySize;
    const nameOffset = contents.readUInt32LE(header);
    const nameEnd = stringTable.indexOf(0, nameOffset);
    names.push(
      stringTable.toString(
        'utf8',
        nameOffset,
        nameEnd === -1 ? stringTable.length : nameEnd
      )
    );
  }
  return names;
}

function assertStrippedElf(contents, label) {
  const sectionNames = readElfSectionNames(contents);
  const forbidden = sectionNames.filter(
    (name) =>
      name === '.symtab' ||
      name === '.strtab' ||
      name.startsWith('.debug_') ||
      name.startsWith('.zdebug_')
  );
  if (forbidden.length > 0) {
    throw new Error(
      `${label} is not stripped; forbidden ELF sections: ${forbidden.join(', ')}`
    );
  }
}

function assertStrippedMachO(contents, label) {
  const commandCount = contents.readUInt32LE(16);
  let commandOffset = 32;
  let sawDynamicSymbols = false;
  for (let index = 0; index < commandCount; index += 1) {
    const command = contents.readUInt32LE(commandOffset);
    const commandSize = contents.readUInt32LE(commandOffset + 4);
    if (commandSize < 8 || commandOffset + commandSize > contents.length) {
      throw new Error(`${label} has an invalid Mach-O load command table`);
    }
    if (command === 0xb) {
      sawDynamicSymbols = true;
      const localSymbolCount = contents.readUInt32LE(commandOffset + 12);
      if (localSymbolCount !== 0) {
        throw new Error(
          `${label} is not stripped; Mach-O contains ${localSymbolCount} local symbols`
        );
      }
    }
    commandOffset += commandSize;
  }
  if (!sawDynamicSymbols) {
    throw new Error(`${label} has no Mach-O dynamic symbol table to validate`);
  }
}

function assertStrippedPe(contents, label) {
  const peOffset = contents.readUInt32LE(0x3c);
  if (contents.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`${label} has an invalid PE header`);
  }
  const coffOffset = peOffset + 4;
  const symbolTableOffset = contents.readUInt32LE(coffOffset + 8);
  const symbolCount = contents.readUInt32LE(coffOffset + 12);
  if (symbolTableOffset !== 0 || symbolCount !== 0) {
    throw new Error(
      `${label} is not stripped; PE/COFF contains ${symbolCount} symbols`
    );
  }
}

export async function assertStrippedExecutable(path, label) {
  const contents = await readFile(path);
  if (
    contents[0] === 0x7f &&
    contents[1] === 0x45 &&
    contents[2] === 0x4c &&
    contents[3] === 0x46
  ) {
    assertStrippedElf(contents, label);
    return;
  }
  if (contents.readUInt32LE(0) === 0xfeedfacf) {
    assertStrippedMachO(contents, label);
    return;
  }
  if (contents.toString('ascii', 0, 2) === 'MZ') {
    assertStrippedPe(contents, label);
    return;
  }
  throw new Error(`${label} uses an unsupported executable format`);
}

export function findInternalPackageRoot(root, entries, packageName) {
  const suffix = `/node_modules/@review-agent/${packageName}/package.json`;
  const candidates = entries.filter(
    (entry) =>
      entry.type === 'file' &&
      (entry.path === suffix.slice(1) || entry.path.endsWith(suffix))
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected one deployed @review-agent/${packageName} package, found ${candidates.length}`
    );
  }
  const relativePackageRoot = candidates[0].path.slice(
    0,
    -'/package.json'.length
  );
  return join(root, ...relativePackageRoot.split('/'));
}

export async function assertNoInternalSourceMapDirectives(root, entries) {
  const internalBuildFiles = entries.filter(
    (entry) =>
      entry.type === 'file' &&
      (entry.path.startsWith('dist/') ||
        /(?:^|\/)node_modules\/@review-agent\/[^/]+\/dist\//.test(
          entry.path
        )) &&
      (entry.path.endsWith('.js') || entry.path.endsWith('.d.ts'))
  );
  for (const entry of internalBuildFiles) {
    const contents = await readFile(
      join(root, ...entry.path.split('/')),
      'utf8'
    );
    if (/^\/\/[#@] sourceMappingURL=/m.test(contents)) {
      throw new Error(
        `release contains dangling source map reference: ${entry.path}`
      );
    }
  }
}

export function assertManifestEntries(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualPaths = new Set(actual.map((entry) => entry.path));
    const expectedPaths = new Set(expected.map((entry) => entry.path));
    const unexpected = [...actualPaths].filter(
      (path) => !expectedPaths.has(path)
    );
    const missing = [...expectedPaths].filter((path) => !actualPaths.has(path));
    throw new Error(
      `release manifest mismatch; unexpected=[${unexpected.join(
        ', '
      )}] missing=[${missing.join(', ')}]`
    );
  }
}

export async function archivePathList(root) {
  const rootName = posixPath(root.split(sep).at(-1));
  const entries = await collectTree(root, { includeDirectories: true });
  return [rootName, ...entries.map((entry) => `${rootName}/${entry.path}`)];
}
