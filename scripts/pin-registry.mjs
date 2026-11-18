import { readFile, writeFile } from 'node:fs/promises';
import { financeTools } from '../connectors/finance.mjs';
import { digest } from '../lib/shared.mjs';

const write = process.argv.includes('--write');
const path = new URL('../registry/connectors/finance.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
let changed = false;
for (const entry of manifest.tools) {
  const definition = financeTools.find(tool => tool.name === entry.name);
  if (!definition) throw new Error(`Approved tool is missing: ${entry.name}`);
  const expected = digest(definition);
  if (entry.pin !== expected) {
    changed = true;
    console.log(`${write ? 'Pinning reviewed definition' : 'DRIFT'}: ${entry.name}`);
    entry.pin = expected;
  }
}
if (write) await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
else if (changed) process.exitCode = 1;
else console.log('All approved Finance tool definitions match their pins.');
