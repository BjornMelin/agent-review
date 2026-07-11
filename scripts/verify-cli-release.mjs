#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract as extractTar } from 'tar';
import {
  assertManifestEntries,
  assertNoInternalSourceMapDirectives,
  assertNoReleaseBuildLeaks,
  assertReleaseAllowlist,
  assertRuntimePackageManifests,
  assertStrippedExecutable,
  collectTree,
  currentReleaseTarget,
  findInternalPackageRoot,
  LINUX_GLIBC_MINIMUM,
  MINIMUM_NODE_MAJOR,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SCHEMA,
  sha256File,
} from './cli-release-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function sanitizedRuntimeEnv(environment) {
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

function parseArgs(args) {
  const options = { fixtures: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === '--archive' ||
      argument === '--checksum' ||
      argument === '--manifest' ||
      argument === '--manifest-checksum' ||
      argument === '--expected-target'
    ) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      const key =
        argument === '--archive'
          ? 'archive'
          : argument === '--checksum'
            ? 'checksum'
            : argument === '--manifest'
              ? 'manifest'
              : argument === '--manifest-checksum'
                ? 'manifestChecksum'
                : 'expectedTarget';
      options[key] = resolve(value);
      if (key === 'expectedTarget') {
        options[key] = value;
      }
      index += 1;
      continue;
    }
    if (argument === '--fixtures') {
      options.fixtures = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.archive) {
    throw new Error('--archive is required');
  }
  options.checksum ??= `${options.archive}.sha256`;
  if (options.manifestChecksum && !options.manifest) {
    throw new Error('--manifest-checksum requires --manifest');
  }
  if (options.manifest) {
    options.manifestChecksum ??= `${options.manifest}.sha256`;
  }
  return options;
}

async function verifyChecksum(path, checksumPath) {
  const hash = await sha256File(path);
  const checksumText = await readFile(checksumPath, 'utf8');
  const checksumMatch = checksumText.match(
    /^([0-9a-f]{64}) {2}([^\r\n]+)\r?\n?$/
  );
  if (!checksumMatch) {
    throw new Error('checksum file must use "<sha256>  <file>" format');
  }
  if (checksumMatch[1] !== hash) {
    throw new Error(
      `${basename(path)} SHA-256 does not match its checksum file`
    );
  }
  if (checksumMatch[2] !== basename(path)) {
    throw new Error(
      `checksum file names a different file than ${basename(path)}`
    );
  }
  return hash;
}

async function runCapture(command, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function requireSuccess(command, args, options = {}) {
  const result = await runCapture(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`
    );
  }
  return result;
}

async function createFixtureRepository(root) {
  await mkdir(root, { recursive: true });
  await requireSuccess('git', ['init', '--initial-branch=main'], { cwd: root });
  await requireSuccess('git', ['config', 'user.name', 'Review Agent Fixture'], {
    cwd: root,
  });
  await requireSuccess(
    'git',
    ['config', 'user.email', 'fixture@review-agent.invalid'],
    { cwd: root }
  );
  const fixturePath = join(root, 'fixture.ts');
  await writeFile(fixturePath, 'export const answer = 41;\n', 'utf8');
  await requireSuccess('git', ['add', 'fixture.ts'], { cwd: root });
  await requireSuccess('git', ['commit', '-m', 'test: add fixture'], {
    cwd: root,
  });
  await writeFile(fixturePath, 'export const answer = 42;\n', 'utf8');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function createMockCodex(fixtureRoot, mode) {
  const mockScript = join(repoRoot, 'scripts/fixtures/mock-codex.mjs');
  if (process.platform === 'win32') {
    const wrapper = join(fixtureRoot, `codex-${mode}.cmd`);
    await writeFile(
      wrapper,
      `@echo off\r\n"${process.execPath}" "${mockScript}" ${mode} %*\r\n`,
      'utf8'
    );
    return wrapper;
  }
  const wrapper = join(fixtureRoot, `codex-${mode}`);
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(
      mockScript
    )} ${shellQuote(mode)} "$@"\n`,
    { encoding: 'utf8', mode: 0o755 }
  );
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function runReviewFixture({
  expectedCode,
  extraArgs = [],
  fixtureRoot,
  launcher,
  mode,
  outputName,
}) {
  const codexBin = await createMockCodex(fixtureRoot, mode);
  const outputPath = join(fixtureRoot, outputName);
  const result = await runCapture(
    launcher,
    [
      'run',
      '--uncommitted',
      '--provider',
      'codex',
      '--format',
      'json',
      '--output',
      outputPath,
      '--severity-threshold',
      'p1',
      '--cwd',
      fixtureRoot,
      '--quiet',
      ...extraArgs,
    ],
    {
      cwd: fixtureRoot,
      env: { ...sanitizedRuntimeEnv(process.env), CODEX_BIN: codexBin },
      shell: process.platform === 'win32',
    }
  );
  if (result.code !== expectedCode) {
    throw new Error(
      `${mode} fixture exited ${result.code}, expected ${expectedCode}: ${result.stderr.trim()}`
    );
  }
  const output = await readFile(outputPath, 'utf8');
  const parsed = JSON.parse(output);
  const expectedFindings = expectedCode === 1 ? 1 : 0;
  if (parsed.findings?.length !== expectedFindings) {
    throw new Error(
      `${mode} fixture emitted ${parsed.findings?.length ?? 'invalid'} findings; expected ${expectedFindings}`
    );
  }
  return output;
}

async function verifyFixtures(launcher, externalRoot) {
  const fixtureRoot = join(externalRoot, 'fixture-repository');
  await createFixtureRepository(fixtureRoot);

  const successFirst = await runReviewFixture({
    expectedCode: 0,
    fixtureRoot,
    launcher,
    mode: 'success',
    outputName: 'success-first.json',
  });
  const successSecond = await runReviewFixture({
    expectedCode: 0,
    fixtureRoot,
    launcher,
    mode: 'success',
    outputName: 'success-second.json',
  });
  if (successFirst !== successSecond) {
    throw new Error('success fixture output is not deterministic');
  }

  const failureFirst = await runReviewFixture({
    expectedCode: 1,
    fixtureRoot,
    launcher,
    mode: 'threshold-failure',
    outputName: 'threshold-first.json',
  });
  const failureSecond = await runReviewFixture({
    expectedCode: 1,
    fixtureRoot,
    launcher,
    mode: 'threshold-failure',
    outputName: 'threshold-second.json',
  });
  if (failureFirst !== failureSecond) {
    throw new Error('threshold-failure fixture output is not deterministic');
  }

  await runReviewFixture({
    expectedCode: 0,
    extraArgs: ['--convex-mirror'],
    fixtureRoot,
    launcher,
    mode: 'success',
    outputName: 'success-convex-mirror.json',
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const archiveHash = await verifyChecksum(options.archive, options.checksum);
  const externalManifestHash = options.manifest
    ? await verifyChecksum(options.manifest, options.manifestChecksum)
    : undefined;

  const extractionRoot = await mkdtemp(join(tmpdir(), 'review-agent-verify-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'review-agent-external-'));
  try {
    await extractTar({
      cwd: extractionRoot,
      file: options.archive,
      preservePaths: false,
      strict: true,
    });
    const extractedNames = await readdir(extractionRoot);
    if (extractedNames.length !== 1) {
      throw new Error(
        `release archive must contain one root directory, found ${extractedNames.length}`
      );
    }
    const releaseRoot = join(extractionRoot, extractedNames[0]);
    const manifestText = await readFile(
      join(releaseRoot, RELEASE_MANIFEST_NAME),
      'utf8'
    );
    if (
      options.manifest &&
      (await readFile(options.manifest, 'utf8')) !== manifestText
    ) {
      throw new Error(
        'external release manifest differs from archive manifest'
      );
    }
    const manifest = JSON.parse(manifestText);
    if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
      throw new Error(
        `unsupported release manifest schema: ${manifest.schema}`
      );
    }
    const target = currentReleaseTarget();
    if (manifest.target !== target) {
      throw new Error(
        `archive target ${manifest.target} does not match verification host ${target}`
      );
    }
    if (options.expectedTarget && manifest.target !== options.expectedTarget) {
      throw new Error(
        `archive target ${manifest.target} does not match expected ${options.expectedTarget}`
      );
    }
    if (manifest.node !== `>=${MINIMUM_NODE_MAJOR}`) {
      throw new Error(`unexpected Node runtime contract: ${manifest.node}`);
    }
    if (
      process.platform === 'linux' &&
      (manifest.nativeRuntime?.family !== 'glibc' ||
        manifest.nativeRuntime?.minimumVersion !== LINUX_GLIBC_MINIMUM)
    ) {
      throw new Error('Linux archive has an invalid glibc runtime contract');
    }

    await assertReleaseAllowlist(releaseRoot, { target });
    const actualEntries = await collectTree(releaseRoot, {
      exclude: [RELEASE_MANIFEST_NAME],
    });
    assertManifestEntries(actualEntries, manifest.files);
    await assertNoInternalSourceMapDirectives(releaseRoot, actualEntries);
    await assertNoReleaseBuildLeaks(releaseRoot, actualEntries);
    await assertRuntimePackageManifests(releaseRoot, actualEntries);

    const deployedPackage = JSON.parse(
      await readFile(join(releaseRoot, 'package.json'), 'utf8')
    );
    if (deployedPackage.version !== manifest.version) {
      throw new Error('deployed CLI version differs from release manifest');
    }

    const extension = process.platform === 'win32' ? '.exe' : '';
    for (const [packageName, binaryName] of [
      ['review-git', `review-git-diff${extension}`],
      ['review-runner', `review-runner${extension}`],
    ]) {
      const packageRoot = findInternalPackageRoot(
        releaseRoot,
        actualEntries,
        packageName
      );
      const binaryPath = join(packageRoot, 'dist', 'bin', binaryName);
      await sha256File(binaryPath);
      await assertStrippedExecutable(binaryPath, binaryName);
    }

    const launcher = join(
      releaseRoot,
      'bin',
      process.platform === 'win32' ? 'review-agent.cmd' : 'review-agent'
    );
    const convexBridgeRoot = findInternalPackageRoot(
      releaseRoot,
      actualEntries,
      'review-convex-bridge'
    );
    const hiddenConvexBridgeRoot = `${convexBridgeRoot}.lazy-load-check`;
    await rename(convexBridgeRoot, hiddenConvexBridgeRoot);
    try {
      const launcherResult = await requireSuccess(launcher, ['--version'], {
        cwd: externalRoot,
        env: sanitizedRuntimeEnv(process.env),
        shell: process.platform === 'win32',
      });
      if (launcherResult.stdout.trim() !== manifest.version) {
        throw new Error(
          `launcher reported ${launcherResult.stdout.trim()}, expected ${manifest.version}`
        );
      }

      const modelResult = await requireSuccess(launcher, ['models', '--json'], {
        cwd: externalRoot,
        env: sanitizedRuntimeEnv(process.env),
        shell: process.platform === 'win32',
      });
      const models = JSON.parse(modelResult.stdout);
      if (!Array.isArray(models) || models.length === 0) {
        throw new Error('packaged CLI model catalog is empty or invalid');
      }
    } finally {
      await rename(hiddenConvexBridgeRoot, convexBridgeRoot);
    }

    if (options.fixtures) {
      await verifyFixtures(launcher, externalRoot);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          schema: 'review-agent.release-verification.v1',
          archive: options.archive,
          sha256: archiveHash,
          manifestSha256: externalManifestHash,
          version: manifest.version,
          target: manifest.target,
          files: manifest.files.length + 1,
          fixtures: options.fixtures
            ? ['success:0', 'threshold-failure:1', 'convex-mirror:0']
            : [],
          status: 'passed',
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.all([
      rm(extractionRoot, { recursive: true, force: true }),
      rm(externalRoot, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
