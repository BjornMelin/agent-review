import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  assertManifestEntries,
  assertNoInternalSourceMapDirectives,
  assertNoReleaseBuildLeaks,
  assertReleaseAllowlist,
  collectTree,
  removePackageManagerMetadata,
  resolveReleaseTarget,
} from './cli-release-utils.mjs';

const INTERNAL_FILES = {
  'review-convex-bridge': ['dist/index.d.ts', 'dist/index.js'],
  'review-core': ['dist/index.d.ts', 'dist/index.js'],
  'review-git': [
    'dist/bin/review-git-diff',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/rust-diff-index.d.ts',
    'dist/rust-diff-index.js',
  ],
  'review-prompts': ['dist/index.d.ts', 'dist/index.js'],
  'review-provider-codex': ['dist/index.d.ts', 'dist/index.js'],
  'review-provider-openai': ['dist/index.d.ts', 'dist/index.js'],
  'review-provider-registry': ['dist/index.d.ts', 'dist/index.js'],
  'review-reporters': ['dist/index.d.ts', 'dist/index.js'],
  'review-runner': [
    'dist/bin/review-runner',
    'dist/index.d.ts',
    'dist/index.js',
  ],
  'review-types': ['dist/index.d.ts', 'dist/index.js'],
};

async function writeFixtureFile(root, path, contents = 'fixture\n') {
  const absolutePath = join(root, ...path.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf8');
}

async function writeReleaseFixture(root) {
  for (const [path, contents] of [
    ['LICENSE', 'MIT\n'],
    ['README.md', '# Release\n'],
    ['package.json', '{"version":"0.1.0"}\n'],
    ['bin/review-agent', '#!/bin/sh\n'],
    ['bin/review-agent.cmd', '@echo off\r\n'],
    ['dist/index.d.ts', 'export {};\n'],
    ['dist/index.js', 'export {};\n'],
    ['dist/service-client.d.ts', 'export {};\n'],
    ['dist/service-client.js', 'export {};\n'],
  ]) {
    await writeFixtureFile(root, path, contents);
  }
  for (const [packageName, files] of Object.entries(INTERNAL_FILES)) {
    await writeFixtureFile(
      root,
      `node_modules/@review-agent/${packageName}/package.json`,
      `{"name":"@review-agent/${packageName}"}\n`
    );
    for (const file of files) {
      await writeFixtureFile(
        root,
        `node_modules/@review-agent/${packageName}/${file}`
      );
    }
  }
}

test('maps every supported native host to its release target', () => {
  assert.equal(
    resolveReleaseTarget({
      arch: 'x64',
      glibcVersionRuntime: '2.39',
      platform: 'linux',
    }),
    'linux-x64-gnu'
  );
  assert.equal(
    resolveReleaseTarget({
      arch: 'arm64',
      glibcVersionRuntime: '2.39',
      platform: 'linux',
    }),
    'linux-arm64-gnu'
  );
  assert.equal(
    resolveReleaseTarget({ arch: 'x64', platform: 'darwin' }),
    'macos-x64'
  );
  assert.equal(
    resolveReleaseTarget({ arch: 'arm64', platform: 'darwin' }),
    'macos-arm64'
  );
  assert.equal(
    resolveReleaseTarget({ arch: 'x64', platform: 'win32' }),
    'windows-x64'
  );
});

test('rejects musl and unknown native targets', () => {
  assert.throws(
    () =>
      resolveReleaseTarget({
        arch: 'x64',
        glibcVersionRuntime: undefined,
        platform: 'linux',
      }),
    /require glibc/
  );
  assert.throws(
    () =>
      resolveReleaseTarget({
        arch: 'x64',
        glibcVersionRuntime: '2.38',
        platform: 'linux',
      }),
    /require GLIBC_2\.39 or newer/
  );
  assert.throws(
    () => resolveReleaseTarget({ arch: 'arm64', platform: 'win32' }),
    /unsupported release host/
  );
});

test('rejects absolute and relative release symlinks that escape the archive root', async () => {
  for (const linkTarget of ['ABSOLUTE', '../outside']) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-links-'));
    const releaseRoot = join(temporaryRoot, 'release');
    const outsideRoot = join(temporaryRoot, 'outside');
    try {
      await Promise.all([
        mkdir(releaseRoot, { recursive: true }),
        mkdir(outsideRoot, { recursive: true }),
      ]);
      await symlink(
        linkTarget === 'ABSOLUTE' ? outsideRoot : linkTarget,
        join(releaseRoot, 'escape'),
        'dir'
      );

      await assert.rejects(() => collectTree(releaseRoot), /escaping symlink/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test('rejects an opposite-platform native helper', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-native-'));
  try {
    await writeReleaseFixture(temporaryRoot);
    await writeFixtureFile(
      temporaryRoot,
      'node_modules/@review-agent/review-git/dist/bin/review-git-diff.exe'
    );

    await assert.rejects(
      () =>
        assertReleaseAllowlist(temporaryRoot, {
          beforeManifest: true,
          target: 'linux-x64-gnu',
        }),
      /non-runtime internal artifact/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects package-manager workspace metadata in a release', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-metadata-'));
  try {
    await writeReleaseFixture(temporaryRoot);
    await Promise.all([
      writeFixtureFile(temporaryRoot, 'pnpm-lock.yaml'),
      writeFixtureFile(temporaryRoot, 'pnpm-workspace.yaml'),
    ]);

    await assert.rejects(
      () =>
        assertReleaseAllowlist(temporaryRoot, {
          beforeManifest: true,
          target: 'linux-x64-gnu',
        }),
      /unexpected=\[pnpm-lock\.yaml, pnpm-workspace\.yaml\]/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('removes package-manager metadata and nested shims at every depth', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-cleanup-'));
  try {
    await Promise.all([
      writeFixtureFile(temporaryRoot, 'pnpm-lock.yaml'),
      writeFixtureFile(temporaryRoot, 'node_modules/.modules.yaml'),
      writeFixtureFile(
        temporaryRoot,
        'node_modules/esbuild/node_modules/.bin/esbuild.CMD'
      ),
      writeFixtureFile(temporaryRoot, 'node_modules/esbuild/index.js'),
    ]);

    await removePackageManagerMetadata(temporaryRoot);

    const paths = (await collectTree(temporaryRoot)).map((entry) => entry.path);
    assert.deepEqual(paths, ['node_modules/esbuild/index.js']);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects pnpm deployment metadata and runtime shims', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-pnpm-'));
  try {
    await writeReleaseFixture(temporaryRoot);
    await Promise.all([
      writeFixtureFile(temporaryRoot, 'node_modules/.bin/convex'),
      writeFixtureFile(temporaryRoot, 'node_modules/.modules.yaml'),
      writeFixtureFile(temporaryRoot, 'node_modules/.pnpm/lock.yaml'),
      writeFixtureFile(
        temporaryRoot,
        'node_modules/.pnpm-workspace-state-v1.json'
      ),
    ]);

    await assert.rejects(
      () =>
        assertReleaseAllowlist(temporaryRoot, {
          beforeManifest: true,
          target: 'linux-x64-gnu',
        }),
      /package-manager metadata or shims/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects build paths in text artifacts', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-leak-'));
  try {
    await writeReleaseFixture(temporaryRoot);
    await writeFixtureFile(
      temporaryRoot,
      'dist/index.js',
      'export const sourceRoot = "/private/build/agent-review";\n'
    );
    const entries = await collectTree(temporaryRoot);

    await assert.rejects(
      () =>
        assertNoReleaseBuildLeaks(temporaryRoot, entries, {
          forbiddenTextRoots: ['/private/build/agent-review'],
        }),
      /text artifact leaks a build path/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects workspace and file specs in runtime package manifests', async () => {
  for (const dependency of ['workspace:^', 'file:../review-types']) {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'review-agent-manifest-')
    );
    try {
      await writeReleaseFixture(temporaryRoot);
      await writeFixtureFile(
        temporaryRoot,
        'node_modules/@review-agent/review-types/package.json',
        `${JSON.stringify({
          name: '@review-agent/review-types',
          dependencies: { zod: dependency },
        })}\n`
      );
      const entries = await collectTree(temporaryRoot);

      await assert.rejects(
        () => assertNoReleaseBuildLeaks(temporaryRoot, entries),
        /workspace or file dependency/
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test('rejects release manifest content drift', () => {
  assert.throws(
    () =>
      assertManifestEntries(
        [{ path: 'dist/index.js', sha256: 'actual', size: 1, type: 'file' }],
        [{ path: 'dist/index.js', sha256: 'expected', size: 1, type: 'file' }]
      ),
    /release manifest mismatch/
  );
});

test('rejects dangling internal source map directives', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'review-agent-maps-'));
  try {
    await writeReleaseFixture(temporaryRoot);
    await writeFixtureFile(
      temporaryRoot,
      'dist/index.js',
      'export {};\n//# sourceMappingURL=index.js.map\n'
    );
    const entries = await collectTree(temporaryRoot);

    await assert.rejects(
      () => assertNoInternalSourceMapDirectives(temporaryRoot, entries),
      /dangling source map reference/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
