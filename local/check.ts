// Syntax check of the cloud JS deployed by tgcloud; TypeScript sources are checked by tsc.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const files = ['schema.js', ...['lib', 'handlers'].flatMap(directory => readdirSync(new URL(directory, root), { encoding: 'utf8', recursive: true })
  .filter(name => name.endsWith('.js')).map(name => `${directory}/${name}`))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', new URL(file, root).pathname], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
