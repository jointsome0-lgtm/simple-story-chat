import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ModelConfig } from './config.ts';
import { requestBudget } from './context.ts';
import { ModelError } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest } from './model.ts';

export { ModelError } from './model-error.ts';

// Only the fields this provider reads; tests pass a partial configuration.
export type ClaudeConfig = Pick<ModelConfig, 'model' | 'contextTokens'> & Partial<Pick<ModelConfig, 'timeoutMs'>> & { dbPath: string };
// The part of child_process.spawn the provider uses, so tests can pass a fake.
export type Launch = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] })
  => ChildProcessByStdio<Writable, Readable, Readable>;
// CLI JSON lines are not validated in advance. Fields the provider checks are unknown; a line
// or nested value that is not an object where one is read fails with a TypeError (provider_failed).
type CliUsage = { input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown; output_tokens?: unknown } | null | undefined;
type CliMessage = { id?: unknown; usage?: CliUsage; stop_reason?: unknown } | null | undefined;
type CliEvent = {
  type?: unknown; subtype?: unknown; parent_tool_use_id?: unknown; model?: unknown; tools?: unknown; mcp_servers?: unknown[] | null;
  event?: { type?: unknown; message?: CliMessage; usage?: CliUsage; delta?: { type?: unknown; text?: unknown; stop_reason?: unknown } | null } | null;
  message?: CliMessage;
  // Fields of the terminal result event.
  is_error?: unknown; result?: unknown; num_turns?: unknown; usage?: CliUsage;
};

const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function inputTokens(usage: CliUsage) {
  if (tokenCount(usage?.input_tokens) === null) return null;
  const parts = [usage!.input_tokens, usage!.cache_creation_input_tokens ?? 0, usage!.cache_read_input_tokens ?? 0];
  // Every part has just been checked to be a count.
  return parts.some(n => tokenCount(n) === null) ? null : (parts as number[]).reduce((a, b) => a + b, 0);
}

function usageTracker() {
  const ids = new Set<unknown>();
  let id: unknown;
  let starts = 0;
  let input: number | null = null;
  let output: number | null = null;
  const begin = (message: CliMessage) => {
    id = message?.id;
    if (id) ids.add(id);
    input = inputTokens(message?.usage);
    output = null;
  };
  return {
    observe(event: CliEvent) {
      if (event.parent_tool_use_id) return;
      if (event.type === 'stream_event' && event.event?.type === 'message_start') {
        starts++;
        begin(event.event.message);
      } else if (event.type === 'assistant' && event.message) {
        if (event.message.id && event.message.id !== id) begin(event.message);
        else if (input === null) input = inputTokens(event.message.usage);
        // Assistant output_tokens is the message_start placeholder, not the final count.
      } else if (event.type === 'stream_event' && event.event?.type === 'message_delta') {
        const usage = event.event.usage;
        input = inputTokens(usage) ?? input;
        output = tokenCount(usage?.output_tokens) ?? output; // cumulative; do not add deltas
      }
    },
    input() { return input; },
    finish(result: CliEvent) {
      // Result usage can total several steps. Only use it as a fallback when a
      // single response is established; never label a call total as window size.
      if (starts <= 1 && ids.size <= 1 && (ids.size === 1 || result.num_turns === 1)) {
        input ??= inputTokens(result.usage);
        output ??= tokenCount(result.usage?.output_tokens);
      }
      if (input === null && output === null) return null;
      return { inputTokens: input, outputTokens: output,
        totalTokens: input !== null && output !== null ? input + output : null };
    },
  };
}

export function createClaude(config: ClaudeConfig, { launch = spawn }: { launch?: Launch } = {}) {
  return {
    async generate(request: ModelRequest, { onText = async () => {}, signal, inputLimitTokens }: GenerateControls = {}): Promise<GenerationResult> {
      const { input, inputBytes, inputTokens: estimatedInput, limitTokens } = requestBudget(request, config.contextTokens);
      const inputLimit = Math.min(limitTokens, inputLimitTokens ?? limitTokens);
      if (estimatedInput > inputLimit) throw new ModelError('context_limit');
      const parent = dirname(config.dbPath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const cwd = mkdtempSync(join(parent, '.model-'));
      const args = ['-p', '--model', config.model, '--safe-mode', '--restricted', '--tools', '',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
        '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--debug-file', '/dev/null', '--system-prompt', request.system];
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens),
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
      for (const key of Object.keys(env)) {
        if (key.startsWith('SIMPLE_CHAT_') || key === 'TELEGRAM_BOT_TOKEN' || key === 'ANTHROPIC_API_KEY') delete env[key];
      }
      let child: ReturnType<Launch> | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      const stop = () => {
        child?.kill('SIGTERM');
        forceKill ??= setTimeout(() => child?.kill('SIGKILL'), 2000);
        forceKill.unref();
      };
      try {
        if (signal?.aborted) throw new ModelError('cancelled');
        child = launch('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        // The executor runs at once, while `child` is the process just launched.
        const closed = new Promise<number | null>(resolve => {
          child!.once('error', () => resolve(-1));
          child!.once('close', code => resolve(code));
        });
        // Neither stderr nor raw stream events are written to logs.
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        signal?.addEventListener('abort', stop, { once: true });
        timeout = setTimeout(() => { timedOut = true; stop(); }, config.timeoutMs ?? 180_000);
        let initialized = false;
        let result: CliEvent | undefined;
        const usage = usageTracker();
        let stopReason: unknown;
        let streamText = '';
        for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          let event: CliEvent;
          try { event = JSON.parse(line); } catch { throw new ModelError('invalid_stream'); }
          usage.observe(event);
          const measuredInput = usage.input();
          if (measuredInput !== null && measuredInput > inputLimit) throw new ModelError('context_limit');
          // With no usage yet, a large prompt cannot safely expose a preview.
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta'
              && measuredInput === null && inputBytes > inputLimit) {
            throw new ModelError('usage_unavailable');
          }
          if (event.type === 'system' && event.subtype === 'init') {
            if (!Array.isArray(event.tools) || event.tools.length || event.mcp_servers?.length) throw new ModelError('unexpected_tools');
            if (event.model !== config.model) throw new ModelError('unexpected_model');
            initialized = true;
          }
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
            if (!initialized) throw new ModelError('invalid_stream');
            // Text deltas carry string text; its type is not checked.
            const delta = event.event.delta.text as string;
            streamText += delta;
            if (streamText.length > 100_000) throw new ModelError('output_limit');
            await onText(delta);
          }
          if (event.type === 'stream_event' && event.event?.type === 'message_delta') {
            stopReason = event.event.delta?.stop_reason ?? stopReason;
          }
          if (event.type === 'assistant') stopReason = event.message?.stop_reason ?? stopReason;
          if (event.type === 'result') result = event;
        }
        const exitCode = await closed;
        if (signal?.aborted) throw new ModelError('cancelled');
        if (!initialized || exitCode !== 0 || !result || result.is_error || result.subtype !== 'success') throw new ModelError('provider_failed');
        // Some CLI versions put only one text block in result.result. The text
        // stream contains the complete answer; result still confirms success.
        const text = streamText || result.result;
        if (typeof text !== 'string' || !text.trim()) throw new ModelError('empty_response');
        const measured = usage.finish(result);
        // A negative limit has already failed the estimate check above, so a missing count never exceeds it.
        if ((measured?.inputTokens ?? 0) > inputLimit) throw new ModelError('context_limit');
        if (measured?.inputTokens == null && inputBytes > inputLimit) throw new ModelError('usage_unavailable');
        return { text, finishReason: stopReason === 'max_tokens' ? 'length' : 'stop', usage: measured,
          streamResultMismatch: !!streamText && typeof result.result === 'string' && streamText !== result.result };
      } catch (error) {
        stop();
        if (signal?.aborted) throw new ModelError('cancelled');
        if (timedOut) throw new ModelError('timeout');
        throw error instanceof ModelError ? error : new ModelError('provider_failed');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', stop);
        // The CLI has no filesystem tools; remove our empty working directory.
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
