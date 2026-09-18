// Keeps a hidden scenario pack in a private Hugging Face dataset, so the pack never lives in this repository.
//   node local/pack-hf.ts push --pack <directory> --repo <owner>/<dataset>
//   node local/pack-hf.ts pull --pack <directory> --repo <owner>/<dataset> --revision <commit>
//   node local/pack-hf.ts export --pack <directory> --authors a,b   (the built-in scenarios of examples/ in pack format)
// HF_TOKEN comes from .env.eval; a public dataset is pulled without it. Prints counts and the commit only, never file contents or the token.
import { parseArgs, parseEnv } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadScenario, packScenarios } from './scenarios.ts';

type Entry = { type?: string; path?: string };

process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { pack: { type: 'string' }, repo: { type: 'string' }, revision: { type: 'string' }, authors: { type: 'string' } } });
const [command] = positionals;
const USAGE = 'Use: pack-hf push --pack directory --repo owner/dataset | pack-hf pull --pack directory --repo owner/dataset --revision <40-hex commit> | pack-hf export --pack directory --authors a,b';
if (!values.pack) throw new Error(USAGE);
const pack = resolve(values.pack);
if (command === 'export') {
  // The open scenarios stay in examples/, where the tests and the GPU probe import them; this is their copy in pack format.
  const authors = (values.authors ?? '').split(',').map(author => author.trim()).filter(Boolean);
  if (!authors.length) throw new Error(USAGE);
  const names = ['battle', 'chess', 'dance'];
  for (const name of names) {
    const { seed, turns, checks, facts, traps, frozenPath } = await loadScenario(name);
    mkdirSync(join(pack, name), { recursive: true });
    writeFileSync(join(pack, name, 'scenario.json'), JSON.stringify({ authors, seed, turns, checks, facts, traps }, null, 2));
    copyFileSync(frozenPath, join(pack, name, 'frozen.json'));
    await loadScenario(name, pack);
  }
  console.log(JSON.stringify({ event: 'exported', scenarios: names.length }));
  process.exit(0);
}
if (!/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(values.repo ?? '') || (command !== 'push' && command !== 'pull')
    || (command === 'pull' && !/^[0-9a-f]{40}$/.test(values.revision ?? ''))) throw new Error(USAGE);
let token: string | undefined;
try { token = parseEnv(readFileSync(resolve(import.meta.dirname, '..', '.env.eval'), 'utf8')).HF_TOKEN; } catch { /* reported below */ }
if (!token && command === 'push') throw new Error('HF_TOKEN is not set in .env.eval');
// Without a token only a public dataset answers.
const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
const api = `https://huggingface.co/api/datasets/${values.repo}`;
// Only the status leaves this function: a provider error body may echo what was sent.
const ok = (response: Response, step: string) => { if (!response.ok) throw new Error(`Hugging Face ${step} failed with status ${response.status}`); return response; };

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.name.startsWith('.') ? []
    : entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() && /\.(json|md)$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

if (command === 'push') {
  // A pack that the eval cannot load is not published.
  const scenarios = packScenarios(pack);
  for (const name of scenarios) await loadScenario(name, pack);
  const paths = files(pack);
  const lines = [{ key: 'header', value: { summary: `Pack of ${scenarios.length} scenarios`, description: '' } },
    ...paths.map(path => ({ key: 'file', value: { path: relative(pack, path).split(sep).join('/'), encoding: 'base64', content: readFileSync(path).toString('base64') } }))];
  const response = ok(await fetch(`${api}/commit/main`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-ndjson' },
    body: lines.map(line => JSON.stringify(line)).join('\n') }), 'commit');
  // The reply of the hub is not typed; only the commit is read from it.
  const result = await response.json() as { commitOid?: string };
  console.log(JSON.stringify({ event: 'pushed', repo: values.repo, scenarios: scenarios.length, files: paths.length, revision: result.commitOid }));
} else {
  const listing = await ok(await fetch(`${api}/tree/${values.revision}?recursive=true`, { headers }), 'listing').json() as Entry[];
  const paths = listing.filter(entry => entry.type === 'file' && typeof entry.path === 'string' && /^[\w./-]+\.(json|md)$/.test(entry.path) && !entry.path.includes('..')).map(entry => entry.path!);
  for (const path of paths) {
    const response = ok(await fetch(`https://huggingface.co/datasets/${values.repo}/resolve/${values.revision}/${path}`, { headers }), 'download');
    const target = join(pack, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  const scenarios = packScenarios(pack);
  for (const name of scenarios) await loadScenario(name, pack);
  console.log(JSON.stringify({ event: 'pulled', repo: values.repo, revision: values.revision, scenarios: scenarios.length, files: paths.length }));
}
