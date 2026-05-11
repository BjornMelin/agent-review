import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemaSet } from '../dist/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputDir = new URL('../generated/json-schema/', import.meta.url);

function toKebabCase(name) {
  return name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const schemas = buildJsonSchemaSet();
const entries = Object.entries(schemas).sort(([left], [right]) =>
  left.localeCompare(right)
);

await rm(outputDir, { force: true, recursive: true });
await mkdir(outputDir, { recursive: true });

const manifest = {
  schemaSetVersion: 1,
  source: 'packages/review-types/src/index.ts',
  generator: 'packages/review-types/scripts/generate-json-schema.mjs',
  schemas: entries.map(([name]) => ({
    name,
    file: `${toKebabCase(name)}.schema.json`,
  })),
};

await writeFile(new URL('manifest.json', outputDir), stableJson(manifest));

for (const [name, schema] of entries) {
  await writeFile(
    new URL(`${toKebabCase(name)}.schema.json`, outputDir),
    stableJson(schema)
  );
}

console.error(
  `wrote ${entries.length} schemas to ${fileURLToPath(outputDir)} from ${scriptDir}`
);
