// The boundary of the action measurement's sealed stories (docs/action-experiment.md#sealed): a made-up word goes in
// where a sharp story's text would, and afterwards nothing the harness wrote outside `sealed/`, nothing in the
// temporary directory it ran with, and nothing it printed may hold that word. The word is searched for as UTF-8 and
// in the \u-escaped form JSON and ComfyUI's text chunks write it in. Only counts and the harness's own relative paths
// are reported; the word itself never is.
import { randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Every form the word can take in a file or a stream the harness writes: as it is, and each non-ASCII letter as
// \uXXXX in lower and in upper case hexadecimal.
export function markerForms(word: string): Buffer[] {
  const escaped = (upper: boolean) => word.replace(/[\u0080-￿]/g, char => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
  return [...new Set([word, escaped(false), escaped(true)])].map(form => Buffer.from(form, 'utf8'));
}

// Every file under `dir` but those `skip` names, and which of them hold one of `needles`, in their bytes or in their
// name or a directory's. A hit's path may hold the word itself: it is counted, never printed.
export function searchTree(dir: string, needles: Buffer[], skip: (path: string) => boolean = () => false) {
  const found = { files: 0, bytes: 0, hits: [] as string[] };
  const holds = (bytes: Buffer) => needles.some(needle => bytes.includes(needle));
  const walk = (at: string) => {
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (skip(path)) continue;
      const named = holds(Buffer.from(entry.name, 'utf8'));
      if (entry.isDirectory()) {
        if (named) found.hits.push(relative(dir, path));
        walk(path);
      } else if (entry.isFile()) {
        const bytes = readFileSync(path);
        found.files++;
        found.bytes += bytes.length;
        if (named || holds(bytes)) found.hits.push(relative(dir, path));
      }
    }
  };
  walk(dir);
  return found;
}

// What the harness printed while `capture` held: every write to stdout and stderr, still passed on as it was.
export function capture() {
  const chunks: string[] = [];
  const streams = [process.stdout, process.stderr];
  const originals = streams.map(stream => stream.write.bind(stream));
  streams.forEach((stream, at) => {
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (originals[at] as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  });
  return {
    text: () => chunks.join(''),
    stop() { streams.forEach((stream, at) => { stream.write = originals[at] as typeof stream.write; }); },
  };
}

// The boundary test: the run's root without its `sealed/`, the temporary directory, and the output. One hit anywhere
// fails it.
export function searchBoundary({ root, tempDir, word, output }: { root: string; tempDir: string; word: string; output: string }) {
  const needles = markerForms(word);
  const sealed = join(root, 'sealed');
  const files = searchTree(root, needles, path => path === sealed || path === tempDir);
  const temp = searchTree(tempDir, needles);
  const printed = needles.some(needle => Buffer.from(output, 'utf8').includes(needle));
  return { pass: !files.hits.length && !temp.hits.length && !printed, files: files.files, bytes: files.bytes + temp.bytes,
    tempFiles: temp.files, hits: { files: files.hits, temp: temp.hits.length, output: printed } };
}

// A name nobody wrote: Cyrillic syllables drawn at random, capitalised, that the files outside `sealed/` do not hold
// already. The marker check puts it into a synthetic seed, so a hit can only be the harness's leak.
const CONSONANTS = [...'бвгджзклмнпрстфхцчш'];
const VOWELS = [...'аеиоуыэюя'];
export function madeUpName(absentFrom: (word: string) => boolean = () => true): string {
  for (let tries = 0; tries < 100; tries++) {
    const syllables = Array.from({ length: 4 }, () => CONSONANTS[randomInt(CONSONANTS.length)] + VOWELS[randomInt(VOWELS.length)]).join('');
    const name = syllables[0].toUpperCase() + syllables.slice(1) + CONSONANTS[randomInt(CONSONANTS.length)];
    if (absentFrom(name)) return name;
  }
  throw new Error('No made-up name was absent from the run directory in a hundred tries');
}
