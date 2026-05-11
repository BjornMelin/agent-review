import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const binaryName =
  process.platform === 'win32' ? 'review-git-diff.exe' : 'review-git-diff';
const packagedBinary = join(packageRoot, 'dist', 'bin', binaryName);

await import('./build-rust-helper.mjs');
await access(packagedBinary);
