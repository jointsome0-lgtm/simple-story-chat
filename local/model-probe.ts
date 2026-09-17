// Explicitly invoked network probe. No Telegram, story DB, private seeds or logs.
import { performance } from 'node:perf_hooks';
import { loadModelConfig } from './config.ts';
import { createLlama } from './llama.ts';
import { errorCode } from './model-error.ts';
import type { GenerationResult, ModelRequest } from './model.ts';

// Probe failures are Error objects; ModelError and Node errors add a string code.
type Failure = Error & { code?: string };

const report = (value: object) => console.log(JSON.stringify(value));
const system = 'Это синтетический тест рассказчика. Пиши кратко по-русски. Начинай ответ с даты 2026-08-02 20:00 на отдельной строке. Не выводи рассуждения или служебные теги.';
const seed = 'СИД: Смотритель маяка Павел передал ключ от склада Вере 2 августа в 20:00. Илья этого не видел. На маяке спокойно.';
const initial: ModelRequest = { system, messages: [{ role: 'user', content: seed },
  { role: 'user', content: 'Продолжи сцену одним коротким абзацем.' }], maxOutputTokens: 192 };

try {
  if (process.argv.slice(2).some(arg => arg !== '--long')) throw new Error('invalid_arguments');
  const config = loadModelConfig();
  if (config.provider !== 'llama-cpp') throw new Error('gpu_config_required');
  const provider = createLlama(config);
  report({ event: 'server_ready', ...await provider.check() });
  const formatFailures: string[] = [];

  async function run(label: string, request: ModelRequest) {
    const started = performance.now();
    let firstTextMs = null;
    let fragments = 0;
    const result = await provider.generate(request, { onText: async () => {
      fragments++;
      firstTextMs ??= Math.round(performance.now() - started);
    } });
    const dateHeader = /^2026-08-02 20:00\s/.test(result.text);
    const hasServiceTags = /<\/?think>|<\|(?:channel|im_start|im_end)|\[start_header_id\]/i.test(result.text);
    report({ event: 'generation_checked', label, finishReason: result.finishReason,
      elapsedMs: Math.round(performance.now() - started), firstTextMs, fragments,
      dateHeader, hasServiceTags, ...result.usage });
    if (hasServiceTags || !dateHeader) formatFailures.push(label);
    // llama.cpp results always include usage with a reasoning count.
    if (result.usage!.reasoningCharacters! > 0) throw new Error('thinking_not_disabled');
    return result;
  }

  function checkCache(previous: GenerationResult, next: GenerationResult) {
    // Allow a small template boundary difference; require the actual prefix.
    // llama.cpp results always include usage with a measured input count; a cached count it did not report (null) is compared as 0.
    const required = Math.max(1, previous.usage!.inputTokens! - 32);
    if (!((next.usage!.cachedInputTokens ?? 0) >= required)) throw new Error('prefix_cache_not_reused');
    report({ event: 'prefix_cache_passed', required, cachedInputTokens: next.usage!.cachedInputTokens });
  }

  const first = await run('first_scene', initial);
  const second: ModelRequest = { ...initial, messages: [...initial.messages, { role: 'assistant', content: first.text },
    { role: 'user', content: 'Продолжи одним коротким абзацем, учитывая, у кого сейчас ключ.' }] };
  checkCache(first, await run('warm_prefix', second));

  const boundary = { ...initial };
  const inputTokens = await provider.countInput(boundary);
  let rejected = false;
  try { await provider.generate(boundary, { inputLimitTokens: inputTokens - 1 }); }
  catch (error) { if (errorCode(error) !== 'context_limit') throw error; rejected = true; }
  if (!rejected) throw new Error('context_guard_failed');
  report({ event: 'context_guard_passed', inputTokens });

  const cancel = new AbortController();
  try {
    await provider.generate({ ...initial, maxOutputTokens: 4096 }, { signal: cancel.signal,
      onText: async () => { cancel.abort(); } });
    throw new Error('cancel_failed');
  } catch (error) { if (errorCode(error) !== 'cancelled') throw error; }
  report({ event: 'cancel_received' });
  // Confirm follow-up service and report latency; prompt completion alone does
  // not prove the server stopped computing immediately on disconnect.
  await run('after_cancel', { ...initial });

  const structured = await provider.generate({
    system: 'Синтетическая проверка ограничения формата ответа.',
    messages: [{ role: 'user', content: 'Ответь только обычным словом, без JSON и фигурных скобок.' }],
    maxOutputTokens: 192,
    outputSchema: { type: 'object', properties: { schema_check: { const: 'ok' } },
      required: ['schema_check'], additionalProperties: false },
  });
  // Any JSON value: a field of a primitive reads as undefined, and null fails with a TypeError.
  let schemaResult: { schema_check?: unknown };
  try { schemaResult = JSON.parse(structured.text); } catch { throw new Error('structured_output_failed'); }
  if (structured.finishReason !== 'stop' || schemaResult.schema_check !== 'ok' || Object.keys(schemaResult).length !== 1) {
    throw new Error('structured_output_failed');
  }
  report({ event: 'structured_output_passed', ...structured.usage });

  if (process.argv.includes('--long')) {
    const target = Math.min(60000, config.contextTokens - 1024);
    let repeats = 1000;
    // Both are set by the first loop iteration.
    let longRequest!: ModelRequest;
    let measured!: number;
    for (let attempt = 0; attempt < 8; attempt++) {
      longRequest = { ...initial, maxOutputTokens: 128, messages: [{ role: 'user', content:
        seed + '\n' + 'В архиве маяка записано: ветер, волны, обычный день.\n'.repeat(repeats)
        + '\nПродолжи историю одним предложением. У кого ключ?' }] };
      measured = await provider.countInput(longRequest);
      if (measured >= target * 0.97 && measured <= target) break;
      repeats = Math.max(1, Math.floor(repeats * target * 0.99 / measured));
    }
    if (!(measured >= target * 0.97 && measured <= target)) throw new Error('long_prompt_size_failed');
    report({ event: 'long_prompt_prepared', inputTokens: measured });
    const longResult = await run('long_context', longRequest);
    const warmLong: ModelRequest = { ...longRequest, messages: [...longRequest.messages,
      { role: 'assistant', content: longResult.text },
      { role: 'user', content: 'Продолжи ещё одним предложением.' }] };
    checkCache(longResult, await run('long_warm_prefix', warmLong));
  }
  if (formatFailures.length) {
    report({ event: 'narrative_format_failures', labels: formatFailures });
    throw new Error('narrative_format_failed');
  }
  report({ event: 'probe_passed', longContextChecked: process.argv.includes('--long') });
} catch (error) {
  const failure = error as Failure;
  const code = failure.code || failure.message;
  report({ event: 'probe_failed', code: /^[a-z_]{1,50}$/.test(code || '') ? code : 'configuration_or_provider_error' });
  process.exitCode = 1;
}
