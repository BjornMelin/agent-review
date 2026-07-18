import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const output = JSON.stringify({
  patch: '',
  chunks: [],
  changedLineIndex: [],
});
const request = {
  cwd: '/repo',
  target: { type: 'uncommittedChanges' as const },
  provider: 'codexDelegate' as const,
  executionMode: 'localTrusted' as const,
  outputFormats: ['json' as const],
};

let fixtureDirectory: string;
let helperImport: string;

async function loadHelper(stdoutLimit: number, stderrLimit: number) {
  vi.stubEnv('NODE_OPTIONS', `--import=${helperImport}`);
  vi.stubEnv('REVIEW_AGENT_DIFF_INDEX_BIN', process.execPath);
  vi.stubEnv('REVIEW_AGENT_DIFF_INDEX_MAX_STDOUT_BYTES', String(stdoutLimit));
  vi.stubEnv('REVIEW_AGENT_DIFF_INDEX_MAX_STDERR_BYTES', String(stderrLimit));
  vi.resetModules();
  return import('./rust-diff-index.js');
}

describe('Rust diff-index output limits', () => {
  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'review-git-output-'));
    const scriptPath = join(fixtureDirectory, 'helper.mjs');
    await writeFile(
      scriptPath,
      'import { writeSync } from "node:fs";\n' +
        'writeSync(2, process.env.REVIEW_GIT_TEST_STDERR ?? "");\n' +
        `writeSync(1, ${JSON.stringify(output)});\n` +
        'process.exit(0);\n'
    );
    helperImport = pathToFileURL(scriptPath).href;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it('accepts stdout and stderr exactly at their byte caps', async () => {
    vi.stubEnv('REVIEW_GIT_TEST_STDERR', 'éé');
    const stdoutLimit = Buffer.byteLength(output);
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    const helper = await loadHelper(stdoutLimit, 4);

    await expect(
      helper.indexDiffForReviewRequest(request, '')
    ).resolves.toEqual({
      patch: '',
      chunks: [],
      changedLineIndex: new Map(),
    });
    expect(byteLength).toHaveBeenCalledTimes(2);
  });

  it('rejects stdout that exceeds its byte cap', async () => {
    const helper = await loadHelper(Buffer.byteLength(output) - 1, 1);

    await expect(helper.indexDiffForReviewRequest(request, '')).rejects.toThrow(
      `exceeded stdout limit ${Buffer.byteLength(output) - 1} bytes`
    );
  });

  it('rejects multibyte stderr that exceeds its byte cap', async () => {
    vi.stubEnv('REVIEW_GIT_TEST_STDERR', 'éé');
    const helper = await loadHelper(Buffer.byteLength(output), 3);

    await expect(helper.indexDiffForReviewRequest(request, '')).rejects.toThrow(
      'exceeded stderr limit 3 bytes'
    );
  });
});
