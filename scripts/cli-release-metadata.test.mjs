import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function readRepoFile(path) {
  return await readFile(join(repoRoot, path), 'utf8');
}

function requirePins(contents, expressions, label) {
  return expressions.map((expression) => {
    const match = contents.match(expression);
    assert.ok(match, `${label} is missing its copy-ready CLI release pin`);
    return match[1];
  });
}

test('copy-ready install commands pin the canonical CLI package version', async () => {
  const [packageText, readme, distributionDocs, actionsExample] =
    await Promise.all([
      readRepoFile('apps/review-cli/package.json'),
      readRepoFile('README.md'),
      readRepoFile('docs/release/cli-distribution.md'),
      readRepoFile('examples/github-actions/review-agent.yml'),
    ]);
  const packageMetadata = JSON.parse(packageText);
  const expectedTag = `v${packageMetadata.version}`;
  const pins = [
    ...requirePins(readme, [/^version=(v\d+\.\d+\.\d+)$/m], 'README.md'),
    ...requirePins(
      distributionDocs,
      [/^version=(v\d+\.\d+\.\d+)$/m, /^\$Version = "(v\d+\.\d+\.\d+)"$/m],
      'docs/release/cli-distribution.md'
    ),
    ...requirePins(
      actionsExample,
      [/^\s*REVIEW_AGENT_VERSION: (v\d+\.\d+\.\d+)$/m],
      'examples/github-actions/review-agent.yml'
    ),
  ];

  assert.deepEqual(
    pins,
    Array.from({ length: pins.length }, () => expectedTag),
    `release pins must all equal ${expectedTag}`
  );
});

test('canonical CLI version has operator-authored release notes', async () => {
  const packageMetadata = JSON.parse(
    await readRepoFile('apps/review-cli/package.json')
  );
  const tag = `v${packageMetadata.version}`;
  const [notes, workflow] = await Promise.all([
    readRepoFile(`docs/release/notes/${tag}.md`),
    readRepoFile('.github/workflows/release-cli.yml'),
  ]);

  assert.match(notes, /\{\{SOURCE_SHA\}\}/);
  assert.match(
    notes,
    new RegExp(`/blob/${tag}/docs/release/cli-distribution\\.md`)
  );
  assert.match(workflow, /docs\/release\/notes\/\$\{tag\}\.md/);
  assert.match(workflow, /test "\$GITHUB_REF_NAME" = "v\$\{package_version\}"/);
  assert.match(workflow, /git cat-file -t "\$GITHUB_REF"/);
  assert.match(workflow, /verify_release_metadata/);
  assert.match(workflow, /sed "s\/\{\{SOURCE_SHA\}\}\/\$\{GITHUB_SHA\}\/g"/);
  assert.match(workflow, /releases\/generate-notes/);
  assert.match(workflow, /--notes-file "\$expected_body_file"/);
  assert.match(workflow, /"\$actual_body" != "\$expected_body"/);
});
