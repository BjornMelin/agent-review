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
