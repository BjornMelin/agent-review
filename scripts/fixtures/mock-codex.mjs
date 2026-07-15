#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [mode, ...args] = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('mock-codex 0.1.0\n');
  process.exit(0);
}

const outputIndex = args.findIndex(
  (value) => value === '-o' || value === '--output-last-message'
);
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (!outputPath) {
  console.error('mock codex did not receive a last-message output path');
  process.exit(2);
}

if (mode !== 'success' && mode !== 'threshold-failure') {
  console.error(`unknown mock codex mode: ${mode ?? '<missing>'}`);
  process.exit(2);
}

const findings =
  mode === 'threshold-failure'
    ? [
        {
          title: 'Deterministic P1 fixture',
          body: 'The release smoke fixture intentionally crosses the P1 threshold.',
          priority: 1,
          confidence_score: 0.99,
          code_location: {
            absolute_file_path: resolve(process.cwd(), 'fixture.ts'),
            line_range: { start: 1, end: 1 },
          },
        },
      ]
    : [];

await writeFile(
  outputPath,
  `${JSON.stringify({
    findings,
    overall_correctness:
      findings.length === 0 ? 'patch is correct' : 'patch is incorrect',
    overall_explanation: `deterministic ${mode} fixture`,
    overall_confidence_score: 0.99,
  })}\n`,
  'utf8'
);
