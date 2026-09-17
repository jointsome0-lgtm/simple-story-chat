import { UserError } from 'lib/library';

export const LIMITS = { context: 65536, input: 57344, output: 4096, summary: 2048, margin: 256, keepTurns: 4 };

export function validateConfig(value) {
  if (!value || !Number.isSafeInteger(value.ownerId) || value.ownerId <= 0) throw new Error('ownerId must be a positive Telegram user ID');
  if (typeof value.baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(value.baseUrl) || /[?#@]/.test(value.baseUrl)) throw new Error('baseUrl must be an HTTP(S) origin/path without credentials, query or fragment');
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('model is required');
  if (typeof value.apiKey !== 'string') throw new Error('apiKey must be a string');
  // Credentials travel over TLS; loopback HTTP is useful for a local GPU/tunnel.
  if (!value.baseUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(value.baseUrl)) {
    throw new Error('Use HTTPS for a remote inference server');
  }
  return { ownerId: value.ownerId, baseUrl: value.baseUrl.replace(/\/$/, ''), model: value.model, apiKey: value.apiKey };
}

// SSE delimiters are ASCII. Buffer raw UTF-8 until a complete event arrives,
// then decode once; a multi-byte character may straddle any network chunk.
export async function* sse(body) {
  let buffer = '';
  let binary;
  for await (const chunk of body) {
    const isBinary = typeof chunk !== 'string';
    if (binary !== undefined && binary !== isBinary) throw new Error('Mixed stream chunk types');
    binary = isBinary;
    if (isBinary) {
      for (let i = 0; i < chunk.length; i += 4096) buffer += String.fromCharCode(...chunk.slice(i, i + 4096));
    } else buffer += chunk;
    if (buffer.length > 2_000_000) throw new Error('Oversized stream event');
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      let event = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (binary) event = decodeURIComponent(event.replace(/[\s\S]/g, char => '%' + char.charCodeAt(0).toString(16).padStart(2, '0')));
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  if (buffer.trim()) throw new Error('Incomplete stream event');
}

export function createModel(fetch, config) {
  const headers = { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) };
  async function post(path, body) {
    const response = await fetch(config.baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new UserError(`Сервер модели вернул HTTP ${response.status}. Проверь endpoint и доступность GPU; запрос автоматически не повторялся.`);
    return response;
  }
  return {
    async count(messages) {
      const template = await (await post('/apply-template', { messages })).json();
      if (typeof template.prompt !== 'string') throw new Error('Missing model chat template');
      const result = await (await post('/tokenize', { content: template.prompt, add_special: false, parse_special: true })).json();
      if (!Array.isArray(result.tokens)) throw new Error('Missing exact tokenizer');
      return result.tokens.length;
    },
    async complete(messages, { summary = false, onText = async () => {} } = {}) {
      const response = await post('/v1/chat/completions', {
        model: config.model, messages, stream: true,
        max_tokens: summary ? LIMITS.summary : LIMITS.output,
        temperature: summary ? 0.1 : 0.8,
        cache_prompt: true,
      });
      let text = '';
      let finish = null;
      let done = false;
      for await (const event of sse(response.body)) {
        if (event === '[DONE]') { done = true; break; }
        const data = JSON.parse(event);
        if (data.error) throw new Error('Inference stream error');
        const choice = data.choices?.[0];
        if (typeof choice?.delta?.content === 'string') {
          text += choice.delta.content;
          if (text.length > 1_000_000) throw new Error('Oversized completion');
          await onText(text);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
      if (!done || !['stop', 'length'].includes(finish) || !text.trim()) throw new Error('Inference stream did not finish');
      if (summary && finish !== 'stop') throw new UserError('Память не поместилась в ответ модели. Сжатие не записано.');
      return { text: text.trim(), truncated: finish === 'length' };
    },
  };
}
