// Emits lib/library.js from lib/library.ts with the pinned tsc, without post-processing.
// With --check, emits into a temporary directory and requires the committed file to match byte for byte.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER = '// Shared story domain. lib/library.js is emitted from lib/library.ts by `npm run cloud:lib`; edit only the TypeScript file.';
const check = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node local/cloud-lib.ts [--check]');
const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'lib', 'library.js');
const outDir = mkdtempSync(join(tmpdir(), 'simple-chat-cloud-lib-'));
try {
  const result = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', join(root, 'tsconfig.cloud.json'), '--outDir', outDir], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('tsc failed to emit lib/library.js');
  const emitted = readFileSync(join(outDir, 'library.js'));
  const text = emitted.toString('utf8');
  // tgcloud resolves modules by bare name; the shared domain must stay self-contained.
  if (text.split('\n')[0] !== HEADER) throw new Error('lib/library.ts must start with the generated-file header');
  if (/^\s*import\b|^\s*export\b[^;]*\bfrom\s*['"]|\bimport\s*\(|\brequire\s*\(/m.test(text)) throw new Error('lib/library.ts must not import other modules');
  if (!check) writeFileSync(target, emitted);
  else if (!emitted.equals(readFileSync(target))) {
    console.error('lib/library.js is out of date; run npm run cloud:lib');
    process.exitCode = 1;
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
