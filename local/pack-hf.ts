// Keeps a hidden scenario pack in a private Hugging Face dataset, so the pack never lives in this repository.
//   node local/pack-hf.ts push --pack <directory> --repo <owner>/<dataset>
//   node local/pack-hf.ts pull --pack <directory> --repo <owner>/<dataset> --revision <commit>
//   node local/pack-hf.ts export --pack <directory> --authors a,b   (the built-in scenarios of examples/ in pack format)
// HF_TOKEN comes from .env.eval; a public dataset is pulled without it. Prints counts and the commit only, never file contents or the token.
// A pack holds JSON and Markdown, and images (png, svg) for the README; the hub keeps images in LFS, and push does the same.
import { parseArgs, parseEnv } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadScenario, packScenarios, packWalks, loadWalk } from './scenarios.ts';
import { loadGold } from './walk-gold.ts';

// A pack holds replay scenarios (scenario.json) and walks (walk.json, with a gold tree beside it when one has been
// grown); every one of them must load, and a gold tree must match its walk's seed, before the pack is published or
// after it is pulled. Returns the counts only.
async function checkPack(directory: string) {
  const walks = packWalks(directory);
  const scenarios = packScenarios(directory).filter(name => !walks.includes(name));
  for (const name of scenarios) await loadScenario(name, directory);
  for (const name of walks) { const walk = await loadWalk(name, directory); loadGold(join(resolve(directory), name, 'gold.json'), name, walk.seed); }
  return { scenarios: scenarios.length, walks: walks.length };
}

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
    : entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() && /\.(json|md|png|svg)$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

if (command === 'push') {
  // A pack that the eval cannot load is not published.
  const counts = await checkPack(pack);
  const paths = files(pack);
  const rel = (path: string) => relative(pack, path).split(sep).join('/');
  // The hub says which files its .gitattributes keeps in LFS (images, by default): those go up as blobs first and are
  // committed by hash; the rest travel in the commit itself.
  const modes = await ok(await fetch(`${api}/preupload/main`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ files: paths.map(path => ({ path: rel(path), sample: readFileSync(path).subarray(0, 512).toString('base64'), size: statSync(path).size })) }) }), 'preupload')
    .json() as { files?: { path?: string; uploadMode?: string }[] };
  const lfs = new Set((modes.files ?? []).filter(file => file.uploadMode === 'lfs').map(file => file.path));
  const lines: { key: string; value: object }[] = [{ key: 'header', value: { summary: `Pack of ${counts.scenarios} scenarios and ${counts.walks} walks`, description: '' } }];
  for (const path of paths) {
    const content = readFileSync(path);
    if (!lfs.has(rel(path))) { lines.push({ key: 'file', value: { path: rel(path), encoding: 'base64', content: content.toString('base64') } }); continue; }
    const oid = createHash('sha256').update(content).digest('hex');
    const batch = await ok(await fetch(`https://huggingface.co/datasets/${values.repo}.git/info/lfs/objects/batch`, { method: 'POST',
      headers: { ...headers, accept: 'application/vnd.git-lfs+json', 'content-type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], hash_algo: 'sha_256', ref: { name: 'refs/heads/main' }, objects: [{ oid, size: content.length }] }) }), 'lfs batch')
      .json() as { objects?: { actions?: { upload?: { href?: string; header?: Record<string, string> } } }[] };
    // No upload action means the hub already holds this blob.
    const upload = batch.objects?.[0]?.actions?.upload;
    if (upload?.href) ok(await fetch(upload.href, { method: 'PUT', headers: upload.header ?? {}, body: content }), 'lfs upload');
    lines.push({ key: 'lfsFile', value: { path: rel(path), algo: 'sha256', oid, size: content.length } });
  }
  const response = ok(await fetch(`${api}/commit/main`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-ndjson' },
    body: lines.map(line => JSON.stringify(line)).join('\n') }), 'commit');
  // The reply of the hub is not typed; only the commit is read from it.
  const result = await response.json() as { commitOid?: string };
  console.log(JSON.stringify({ event: 'pushed', repo: values.repo, ...counts, files: paths.length, lfs: lfs.size, revision: result.commitOid }));
} else {
  const listing = await ok(await fetch(`${api}/tree/${values.revision}?recursive=true`, { headers }), 'listing').json() as Entry[];
  const paths = listing.filter(entry => entry.type === 'file' && typeof entry.path === 'string' && /^[\w./-]+\.(json|md|png|svg)$/.test(entry.path) && !entry.path.includes('..')).map(entry => entry.path!);
  for (const path of paths) {
    const response = ok(await fetch(`https://huggingface.co/datasets/${values.repo}/resolve/${values.revision}/${path}`, { headers }), 'download');
    const target = join(pack, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  const counts = await checkPack(pack);
  console.log(JSON.stringify({ event: 'pulled', repo: values.repo, revision: values.revision, ...counts, files: paths.length }));
}
