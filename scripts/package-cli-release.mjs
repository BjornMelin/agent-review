#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as createTar } from 'tar';
import {
  archivePathList,
  assertFileOmitsPrefixes,
  assertNoInternalSourceMapDirectives,
  assertNoReleaseBuildLeaks,
  assertReleaseAllowlist,
  assertRuntimePackageManifests,
  assertStrippedExecutable,
  collectTree,
  currentReleaseTarget,
  findInternalPackageRoot,
  INTERNAL_RUNTIME_PACKAGES,
  LINUX_GLIBC_MINIMUM,
  MINIMUM_NODE_MAJOR,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SCHEMA,
  RUNTIME_PACKAGE_MANIFEST_FIELDS,
  removePackageManagerMetadata,
  sha256File,
} from './cli-release-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(args) {
  const options = {
    outDir: resolve(repoRoot, 'release'),
    verify: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--out-dir') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--out-dir requires a path');
      }
      options.outDir = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--expected-target') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--expected-target requires a target name');
      }
      options.expectedTarget = value;
      index += 1;
      continue;
    }
    if (argument === '--verify') {
      options.verify = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function pnpmInvocation(args) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (pnpmEntrypoint) {
    return {
      command: process.execPath,
      args: [pnpmEntrypoint, ...args],
    };
  }
  if (process.platform === 'win32') {
    throw new Error(
      'Windows release packaging must be invoked through `pnpm release:cli:archive`'
    );
  }
  return { command: 'pnpm', args };
}

async function runPnpm(args, options = {}) {
  const invocation = pnpmInvocation(args);
  await run(invocation.command, invocation.args, options);
}

async function pnpmOutput(args, options = {}) {
  const invocation = pnpmInvocation(args);
  return await commandOutput(invocation.command, invocation.args, options);
}

async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code ?? 1}`));
        return;
      }
      resolveRun();
    });
  });
}

async function commandOutput(command, args, options = {}) {
  let stdout = '';
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(`${command} ${args.join(' ')} exited with ${code ?? 1}`)
        );
        return;
      }
      resolveRun();
    });
  });
  return stdout.trim();
}

async function gitOutput(args) {
  return await commandOutput('git', args);
}

async function removeIfPresent(path) {
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
}

async function createArchive({ archivePath, stagingRoot, timestamp }) {
  await removeIfPresent(archivePath);
  const entries = await archivePathList(stagingRoot);
  await createTar(
    {
      cwd: dirname(stagingRoot),
      file: archivePath,
      follow: false,
      gzip: { level: 9, portable: true },
      mtime: timestamp,
      noDirRecurse: true,
      portable: true,
      strict: true,
    },
    entries
  );
}

async function replaceStagingFile(path, contents, options = 'utf8') {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, contents, options);
  try {
    // pnpm may inject workspace files as hardlinks. Unlinking before rename
    // guarantees release rewrites cannot mutate source or store files.
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function stripInternalSourceMapDirectives(stagingRoot, entries) {
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
    const path = join(stagingRoot, ...entry.path.split('/'));
    const contents = await readFile(path, 'utf8');
    const stripped = contents.replace(
      /\r?\n\/\/[#@] sourceMappingURL=[^\r\n]+\r?\n?$/,
      '\n'
    );
    if (stripped !== contents) {
      await replaceStagingFile(path, stripped);
    }
  }
}

function releaseReadme(version, target) {
  return `# Review Agent CLI v${version}\n\nThis is the ${target} release archive for the Review Agent CLI. It requires Node.js ${MINIMUM_NODE_MAJOR}+ and git.\n\nRun \`bin/review-agent --version\` on Linux/macOS or \`bin\\review-agent.cmd --version\` on Windows.\n\nCanonical resources:\n\n- Repository: https://github.com/BjornMelin/agent-review\n- CLI distribution and supported platforms: https://github.com/BjornMelin/agent-review/blob/v${version}/docs/release/cli-distribution.md\n- CLI command and exit-code contract: https://github.com/BjornMelin/agent-review/blob/v${version}/docs/architecture/spec/cli-contract.md\n- GitHub Actions example: https://github.com/BjornMelin/agent-review/blob/v${version}/examples/github-actions/review-agent.yml\n`;
}

function compareVersions(left, right) {
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

async function requiredGlibcVersion(binary) {
  const output = await commandOutput('readelf', ['--version-info', binary]);
  const versions = [...output.matchAll(/GLIBC_(\d+\.\d+)/g)].map(
    (match) => match[1]
  );
  if (versions.length === 0) {
    throw new Error(`readelf found no GLIBC version requirements in ${binary}`);
  }
  versions.sort(compareVersions);
  return versions.at(-1);
}

async function assertReleaseHelpers(
  stagingRoot,
  payloadEntries,
  cargoTargetDir,
  forbiddenPrefixes
) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const checks = [
    {
      packageName: 'review-git',
      binaryName: `review-git-diff${extension}`,
    },
    {
      packageName: 'review-runner',
      binaryName: `review-runner${extension}`,
    },
  ];
  const glibcRequirements = {};
  for (const check of checks) {
    const packageRoot = findInternalPackageRoot(
      stagingRoot,
      payloadEntries,
      check.packageName
    );
    const stagedBinary = join(packageRoot, 'dist', 'bin', check.binaryName);
    const releaseBinary = join(cargoTargetDir, 'release', check.binaryName);
    const [stagedHash, releaseHash] = await Promise.all([
      sha256File(stagedBinary),
      sha256File(releaseBinary),
    ]);
    if (stagedHash !== releaseHash) {
      throw new Error(
        `${check.binaryName} does not match the Cargo release-profile binary`
      );
    }
    await assertStrippedExecutable(stagedBinary, check.binaryName);
    await assertFileOmitsPrefixes(
      stagedBinary,
      forbiddenPrefixes,
      check.binaryName
    );
    if (
      process.platform !== 'win32' &&
      ((await stat(stagedBinary)).mode & 0o111) === 0
    ) {
      throw new Error(`${check.binaryName} is not executable`);
    }
    if (process.platform === 'linux') {
      const requiredVersion = await requiredGlibcVersion(stagedBinary);
      if (compareVersions(requiredVersion, LINUX_GLIBC_MINIMUM) > 0) {
        throw new Error(
          `${check.binaryName} requires GLIBC_${requiredVersion}, newer than the documented GLIBC_${LINUX_GLIBC_MINIMUM} contract`
        );
      }
      glibcRequirements[check.binaryName] = requiredVersion;
    }
  }
  return glibcRequirements;
}

function canonicalDependencies(dependencies, internalVersions) {
  if (dependencies === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => [
      name,
      internalVersions.get(name) ?? version,
    ])
  );
}

function runtimeManifest(metadata, internalVersions, fallbackLicense) {
  const sanitized = {};
  for (const field of RUNTIME_PACKAGE_MANIFEST_FIELDS) {
    let value = metadata[field];
    if (field === 'license') {
      value ??= fallbackLicense;
    }
    if (
      field === 'dependencies' ||
      field === 'optionalDependencies' ||
      field === 'peerDependencies'
    ) {
      value = canonicalDependencies(value, internalVersions);
    }
    if (value !== undefined) {
      sanitized[field] = value;
    }
  }
  return sanitized;
}

async function writeRuntimeManifest(path, metadata) {
  await replaceStagingFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function rewriteRuntimePackageManifests(stagingRoot) {
  const rootManifestPath = join(stagingRoot, 'package.json');
  const rootMetadata = JSON.parse(await readFile(rootManifestPath, 'utf8'));
  const deployedEntries = await collectTree(stagingRoot);
  const internalManifests = [];
  const internalVersions = new Map();
  for (const packageName of INTERNAL_RUNTIME_PACKAGES) {
    const packageRoot = findInternalPackageRoot(
      stagingRoot,
      deployedEntries,
      packageName
    );
    const manifestPath = join(packageRoot, 'package.json');
    const metadata = JSON.parse(await readFile(manifestPath, 'utf8'));
    internalManifests.push({ manifestPath, metadata });
    internalVersions.set(metadata.name, metadata.version);
  }
  await writeRuntimeManifest(
    rootManifestPath,
    runtimeManifest(rootMetadata, internalVersions)
  );

  for (const { manifestPath, metadata } of internalManifests) {
    await writeRuntimeManifest(
      manifestPath,
      runtimeManifest(metadata, internalVersions, rootMetadata.license)
    );
  }
}

function canonicalReleaseRustFlags({
  cargoHome,
  cargoTargetDir,
  home,
  rustupHome,
}) {
  const remaps = [
    [cargoTargetDir, '/target'],
    [repoRoot, '/workspace'],
    [cargoHome, '/cargo'],
    [rustupHome, '/rustup'],
    [home, '/build-home'],
  ]
    .filter(([source]) => source)
    .sort((left, right) => right[0].length - left[0].length);
  const seen = new Set();
  const flags = [];
  for (const [source, destination] of remaps) {
    if (seen.has(source)) {
      continue;
    }
    seen.add(source);
    flags.push(`--remap-path-prefix=${source}=${destination}`);
  }
  flags.push('-Cstrip=symbols');
  return flags.join('\x1f');
}

function sanitizedVerificationEnv(environment) {
  const sanitized = { ...environment };
  for (const key of [
    'CARGO_TARGET_DIR',
    'NODE_OPTIONS',
    'NODE_PATH',
    'REVIEW_AGENT_DIFF_INDEX_ALLOW_BUILD',
    'REVIEW_AGENT_DIFF_INDEX_BIN',
    'REVIEW_AGENT_RUNNER_ALLOW_BUILD',
    'REVIEW_AGENT_RUNNER_BIN',
  ]) {
    delete sanitized[key];
  }
  return sanitized;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodeMajor = Number.parseInt(
    process.versions.node.split('.')[0] ?? '',
    10
  );
  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `CLI release packaging requires Node ${MINIMUM_NODE_MAJOR}+`
    );
  }

  const target = currentReleaseTarget();
  if (options.expectedTarget && options.expectedTarget !== target) {
    throw new Error(
      `release target mismatch: expected ${options.expectedTarget}, detected ${target}`
    );
  }

  const cliPackage = JSON.parse(
    await readFile(join(repoRoot, 'apps/review-cli/package.json'), 'utf8')
  );
  const version = cliPackage.version;
  const expectedTag = `v${version}`;
  if (
    process.env.GITHUB_REF_TYPE === 'tag' &&
    process.env.GITHUB_REF_NAME !== expectedTag
  ) {
    throw new Error(
      `release tag ${process.env.GITHUB_REF_NAME} does not match CLI version ${expectedTag}`
    );
  }

  const sourceCommit = await gitOutput(['rev-parse', 'HEAD']);
  const sourceEpochText =
    process.env.SOURCE_DATE_EPOCH ??
    (await gitOutput(['show', '-s', '--format=%ct', 'HEAD']));
  const sourceEpoch = Number.parseInt(sourceEpochText, 10);
  if (!Number.isInteger(sourceEpoch) || sourceEpoch <= 0) {
    throw new Error(`invalid SOURCE_DATE_EPOCH: ${sourceEpochText}`);
  }
  const timestamp = new Date(sourceEpoch * 1000);

  const home = homedir();
  const cargoTargetDir = process.env.CARGO_TARGET_DIR
    ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
    : join(repoRoot, 'target');
  const cargoHome = resolve(process.env.CARGO_HOME ?? join(home, '.cargo'));
  const rustupHome = resolve(process.env.RUSTUP_HOME ?? join(home, '.rustup'));
  const pnpmStoreDir = await pnpmOutput(['store', 'path']);
  const buildEnv = {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: canonicalReleaseRustFlags({
      cargoHome,
      cargoTargetDir,
      home,
      rustupHome,
    }),
    CARGO_TARGET_DIR: cargoTargetDir,
    CI: process.env.CI ?? 'true',
    NODE_ENV: 'production',
    REVIEW_AGENT_RUST_PROFILE: 'release',
  };
  for (const key of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS']) {
    delete buildEnv[key];
  }
  await runPnpm(
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@review-agent/review-cli...',
      '--force',
      '--env-mode=loose',
    ],
    { env: buildEnv }
  );

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-release-'));
  const artifactBase = `review-agent-v${version}-${target}`;
  const stagingRoot = join(temporaryRoot, artifactBase);
  await mkdir(options.outDir, { recursive: true });

  const archivePath = join(options.outDir, `${artifactBase}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  const externalManifestPath = join(
    options.outDir,
    `${artifactBase}.manifest.json`
  );
  const externalManifestChecksumPath = `${externalManifestPath}.sha256`;
  const reproducibilityPath = `${archivePath}.reproducibility-check`;
  let releaseOutput;

  try {
    await runPnpm(
      [
        '--config.node-linker=hoisted',
        '--config.package-import-method=copy',
        '--filter',
        '@review-agent/review-cli',
        '--prod',
        'deploy',
        stagingRoot,
      ],
      { env: buildEnv }
    );

    // pnpm deploy includes workspace state and can generate nested .bin shims
    // during platform-specific lifecycle scripts. They are build inputs, not
    // part of the standalone runtime.
    await removePackageManagerMetadata(stagingRoot);
    await rewriteRuntimePackageManifests(stagingRoot);

    const license = await readFile(join(repoRoot, 'LICENSE'));
    await Promise.all([
      replaceStagingFile(join(stagingRoot, 'LICENSE'), license),
      replaceStagingFile(
        join(stagingRoot, 'README.md'),
        releaseReadme(version, target)
      ),
      mkdir(join(stagingRoot, 'bin'), { recursive: true }),
    ]);
    await writeFile(
      join(stagingRoot, 'bin', 'review-agent'),
      '#!/bin/sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec node "$SCRIPT_DIR/../dist/index.js" "$@"\n',
      { encoding: 'utf8', mode: 0o755 }
    );
    await writeFile(
      join(stagingRoot, 'bin', 'review-agent.cmd'),
      '@echo off\r\nsetlocal\r\nnode "%~dp0..\\dist\\index.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
      'utf8'
    );
    if (process.platform !== 'win32') {
      await chmod(join(stagingRoot, 'bin', 'review-agent'), 0o755);
    }

    const initialPayloadEntries = await assertReleaseAllowlist(stagingRoot, {
      beforeManifest: true,
      target,
    });
    await stripInternalSourceMapDirectives(stagingRoot, initialPayloadEntries);
    const strippedPayloadEntries = await assertReleaseAllowlist(stagingRoot, {
      beforeManifest: true,
      target,
    });
    await assertNoInternalSourceMapDirectives(
      stagingRoot,
      strippedPayloadEntries
    );
    const glibcRequirements = await assertReleaseHelpers(
      stagingRoot,
      strippedPayloadEntries,
      cargoTargetDir,
      [repoRoot, home, cargoHome, rustupHome, cargoTargetDir]
    );
    const payloadEntries = await assertReleaseAllowlist(stagingRoot, {
      beforeManifest: true,
      target,
    });
    await assertNoInternalSourceMapDirectives(stagingRoot, payloadEntries);
    await assertNoReleaseBuildLeaks(stagingRoot, payloadEntries, {
      forbiddenTextRoots: [
        repoRoot,
        home,
        cargoHome,
        rustupHome,
        cargoTargetDir,
        pnpmStoreDir,
      ],
    });
    await assertRuntimePackageManifests(stagingRoot, payloadEntries);
    const manifest = {
      schema: RELEASE_MANIFEST_SCHEMA,
      version,
      target,
      node: `>=${MINIMUM_NODE_MAJOR}`,
      nativeRuntime:
        process.platform === 'linux'
          ? {
              family: 'glibc',
              minimumVersion: LINUX_GLIBC_MINIMUM,
              observedHelperRequirements: glibcRequirements,
            }
          : { family: 'native' },
      sourceCommit,
      sourceDateEpoch: sourceEpoch,
      generatedAt: timestamp.toISOString(),
      excludedFromFiles: [RELEASE_MANIFEST_NAME],
      files: payloadEntries,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await Promise.all([
      writeFile(join(stagingRoot, RELEASE_MANIFEST_NAME), manifestText, 'utf8'),
      writeFile(externalManifestPath, manifestText, 'utf8'),
    ]);
    const externalManifestHash = await sha256File(externalManifestPath);
    await writeFile(
      externalManifestChecksumPath,
      `${externalManifestHash}  ${externalManifestPath.split(/[\\/]/).at(-1)}\n`,
      'utf8'
    );
    await assertReleaseAllowlist(stagingRoot, { target });

    await createArchive({ archivePath, stagingRoot, timestamp });
    await createArchive({
      archivePath: reproducibilityPath,
      stagingRoot,
      timestamp,
    });
    const [archiveHash, reproducibilityHash] = await Promise.all([
      sha256File(archivePath),
      sha256File(reproducibilityPath),
    ]);
    if (archiveHash !== reproducibilityHash) {
      throw new Error(
        'repeated release archive creation was not deterministic'
      );
    }
    await removeIfPresent(reproducibilityPath);
    await writeFile(
      checksumPath,
      `${archiveHash}  ${archivePath.split(/[\\/]/).at(-1)}\n`,
      'utf8'
    );

    const archiveStats = await stat(archivePath);
    releaseOutput = {
      schema: 'review-agent.release-output.v1',
      version,
      target,
      sourceCommit,
      archive: archivePath,
      manifest: externalManifestPath,
      manifestChecksum: externalManifestChecksumPath,
      manifestSha256: externalManifestHash,
      checksum: checksumPath,
      sha256: archiveHash,
      bytes: archiveStats.size,
      verified: false,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await removeIfPresent(reproducibilityPath);
  }

  if (!releaseOutput) {
    throw new Error('release packaging completed without an output record');
  }
  if (options.verify) {
    await run(
      process.execPath,
      [
        join(repoRoot, 'scripts/verify-cli-release.mjs'),
        '--archive',
        archivePath,
        '--checksum',
        checksumPath,
        '--manifest',
        externalManifestPath,
        '--manifest-checksum',
        externalManifestChecksumPath,
        '--expected-target',
        target,
        '--fixtures',
      ],
      { env: sanitizedVerificationEnv(buildEnv) }
    );
    releaseOutput.verified = true;
  }
  process.stdout.write(`${JSON.stringify(releaseOutput, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
