import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelConfig } from './config.ts';
import type { Launch } from './claude.ts';
import { requestBudget } from './context.ts';
import { ModelError } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest } from './model.ts';

// Only the fields this provider reads; tests pass a partial configuration.
export type CodexConfig = Pick<ModelConfig, 'model' | 'contextTokens'> & Partial<Pick<ModelConfig, 'timeoutMs'>> & { dbPath: string };
// `codex exec --json` lines are not validated in advance; every field the provider reads is unknown.
type CliEvent = {
  type?: unknown;
  item?: { type?: unknown; text?: unknown } | null;
  usage?: { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown } | null;
};

// Codex is an agent with a shell. The narrator needs none of it: everything that can act is switched off, the sandbox
// is read-only and the working directory is empty. An item of any other kind than these fails the request.
const FEATURES_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'memories', 'browser_use', 'computer_use',
  'image_generation', 'view_image', 'skill_search', 'tool_suggest', 'sleep_tool', 'hooks', 'goals'];
// `error` items are the CLI's own warnings (unknown model metadata), not a failure; the turn's end decides that.
const PASSIVE_ITEMS = ['agent_message', 'reasoning', 'error'];
const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createCodex(config: CodexConfig, { launch = spawn }: { launch?: Launch } = {}) {
  return {
    async generate(request: ModelRequest, { onText = async () => {}, signal, inputLimitTokens }: GenerateControls = {}): Promise<GenerationResult> {
      const { input, inputBytes, inputTokens: estimatedInput, limitTokens } = requestBudget(request, config.contextTokens);
      const inputLimit = Math.min(limitTokens, inputLimitTokens ?? limitTokens);
      if (estimatedInput > inputLimit) throw new ModelError('context_limit');
      const parent = dirname(config.dbPath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // The instructions and the schema go through files next to the working directory, never through arguments,
      // which other local users can read in the process list.
      const home = mkdtempSync(join(parent, '.model-'));
      const cwd = join(home, 'empty');
      mkdirSync(cwd, { mode: 0o700 });
      const instructions = join(home, 'instructions.md');
      writeFileSync(instructions, request.system, { mode: 0o600 });
      const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--color', 'never', '--model', config.model,
        '-c', `model_instructions_file=${JSON.stringify(instructions)}`, '-c', 'web_search="disabled"',
        ...FEATURES_OFF.flatMap(feature => ['--disable', feature])];
      if (request.outputSchema) {
        const schema = join(home, 'schema.json');
        writeFileSync(schema, JSON.stringify(request.outputSchema), { mode: 0o600 });
        args.push('--output-schema', schema);
      }
      args.push('-');
      const env: NodeJS.ProcessEnv = { ...process.env };
      // The CLI signs in through its own CODEX_HOME. An API key in the environment would bill another account.
      for (const key of Object.keys(env)) {
        if (key.startsWith('SIMPLE_CHAT_') || key === 'TELEGRAM_BOT_TOKEN' || key === 'OPENAI_API_KEY' || key === 'CODEX_API_KEY') delete env[key];
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
        child = launch('codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        const closed = new Promise<number | null>(resolve => {
          child!.once('error', () => resolve(-1));
          child!.once('close', code => resolve(code));
        });
        // Neither stderr nor raw events are written to logs: a CLI error may quote the request.
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        signal?.addEventListener('abort', stop, { once: true });
        timeout = setTimeout(() => { timedOut = true; stop(); }, config.timeoutMs ?? 180_000);
        let started = false;
        let completed: CliEvent | undefined;
        let failed = false;
        let text = '';
        for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          let event: CliEvent;
          try { event = JSON.parse(line); } catch { throw new ModelError('invalid_stream'); }
          if (event.type === 'thread.started') started = true;
          if (event.type === 'turn.failed') failed = true;
          if (event.type === 'turn.completed') completed = event;
          if (typeof event.type === 'string' && event.type.startsWith('item.')) {
            if (!started) throw new ModelError('invalid_stream');
            if (!PASSIVE_ITEMS.includes(event.item?.type as string)) throw new ModelError('unexpected_tools');
            // The CLI reports a message whole, not by tokens; the last one is the answer.
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
            if (text.length > 100_000) throw new ModelError('output_limit');
          }
        }
        const exitCode = await closed;
        if (signal?.aborted) throw new ModelError('cancelled');
        if (!started || failed || exitCode !== 0 || !completed) throw new ModelError('provider_failed');
        if (!text.trim()) throw new ModelError('empty_response');
        // input_tokens already includes the cached part.
        const inputTokens = tokenCount(completed.usage?.input_tokens);
        const outputTokens = tokenCount(completed.usage?.output_tokens);
        if ((inputTokens ?? 0) > inputLimit) throw new ModelError('context_limit');
        if (inputTokens === null && inputBytes > inputLimit) throw new ModelError('usage_unavailable');
        await onText(text);
        return { text, finishReason: 'stop', usage: inputTokens === null && outputTokens === null ? null
          : { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null } };
      } catch (error) {
        stop();
        if (signal?.aborted) throw new ModelError('cancelled');
        if (timedOut) throw new ModelError('timeout');
        throw error instanceof ModelError ? error : new ModelError('provider_failed');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', stop);
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
