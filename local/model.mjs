import { createClaude } from './claude.mjs';
import { createLlama } from './llama.mjs';

export function createModel(config) {
  if (config.provider === 'claude-code') return createClaude(config);
  if (config.provider === 'llama-cpp') return createLlama(config);
  throw new Error('Unsupported model provider');
}
