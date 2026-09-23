// One public ruler for token counts: OpenAI's o200k_base through the tiktoken package, the WASM build of the official
// Rust core with the same ranks, so the counts equal the Python package's. It is a dependency of the eval only:
// `npm test` runs without node_modules, so the module is loaded when first asked and its absence is reported as null,
// never as a failure. Counts are metadata; the text never leaves the process.
export const TOKEN_RULER = 'o200k_base';
type Encoder = { encode(text: string, allowed?: string[] | 'all', disallowed?: string[] | 'all'): Uint32Array; free(): void };
let loading: Promise<Encoder | null> | undefined;
export function tokenCounter(): Promise<((text: string) => number) | null> {
  loading ??= import('tiktoken').then(m => m.get_encoding(TOKEN_RULER) as unknown as Encoder).catch(() => null);
  // Special tokens in a story are text, not control: nothing is disallowed, nothing is allowed as special.
  return loading.then(encoder => encoder ? (text: string) => encoder.encode(text, [], []).length : null);
}
