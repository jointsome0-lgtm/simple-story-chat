import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
for (const file of readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', new URL(file, import.meta.url).pathname], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
