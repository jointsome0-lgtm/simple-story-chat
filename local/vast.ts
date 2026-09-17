import type { GpuConfig } from './config.ts';
import { ModelError } from './model-error.ts';

// Instance status as reported by Vast; the controller only compares these values.
export type RemoteState = { actual: unknown; intended: unknown };

// Fixed origin and instance: the Telegram user never supplies an API path or ID.
export function createVast({ instanceId, apiKey }: Pick<GpuConfig, 'instanceId' | 'apiKey'>,
  { fetch: fetcher = globalThis.fetch }: { fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  if (!/^[1-9]\d*$/.test(String(instanceId)) || !apiKey || /[\r\n]/.test(apiKey)) throw new ModelError('gpu_config');
  const url = `https://console.vast.ai/api/v0/instances/${instanceId}/`;
  async function request(state?: string): Promise<RemoteState | undefined> {
    const phase = state ? 'gpu_write' : 'gpu_read';
    const timer = AbortSignal.timeout(10000);
    try {
      const response = await fetcher(url, { method: state ? 'PUT' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(state ? { body: JSON.stringify({ state }) } : {}), signal: timer });
      if (!response.ok) { await response.body?.cancel(); throw new ModelError('gpu_api_failed', { phase, httpStatus: response.status }); }
      let text = '';
      // A missing body is not iterable and fails as gpu_api_failed.
      for await (const chunk of response.body!) {
        text += Buffer.from(chunk).toString('utf8');
        if (text.length > 200000) throw new ModelError('gpu_api_failed');
      }
      // Vast JSON is not validated: only these fields are read, and the instance id is compared first.
      const result: { success?: unknown; instances?: { id?: unknown; actual_status?: unknown; intended_status?: unknown } | null } = JSON.parse(text);
      if (state) {
        if (result.success !== true) throw new ModelError('gpu_api_failed');
        return;
      }
      const instance = result.instances;
      if (String(instance?.id) !== String(instanceId)) throw new ModelError('gpu_instance_mismatch');
      // Discard the remaining response, which can include instance credentials.
      // A missing instance has no matching id, so it never reaches this point.
      return { actual: instance!.actual_status, intended: instance!.intended_status };
    } catch (error) {
      throw new ModelError(timer.aborted ? 'gpu_api_timeout' : error instanceof ModelError ? error.code : 'gpu_api_failed',
        { phase, httpStatus: (error as { httpStatus?: unknown } | null | undefined)?.httpStatus });
    }
  }
  // A read without a state always returns the instance state or throws.
  return { read: () => request() as Promise<RemoteState>, setState: (state: string) => {
    if (!['running', 'stopped'].includes(state)) throw new ModelError('gpu_config');
    return request(state);
  } };
}
