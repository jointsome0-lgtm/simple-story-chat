import { ModelError } from './model-error.mjs';

// Fixed origin and instance: the Telegram user never supplies an API path or ID.
export function createVast({ instanceId, apiKey }, { fetch: fetcher = globalThis.fetch } = {}) {
  if (!/^[1-9]\d*$/.test(String(instanceId)) || !apiKey || /[\r\n]/.test(apiKey)) throw new ModelError('gpu_config');
  const url = `https://console.vast.ai/api/v0/instances/${instanceId}/`;
  async function request(state) {
    const phase = state ? 'gpu_write' : 'gpu_read';
    const timer = AbortSignal.timeout(10000);
    try {
      const response = await fetcher(url, { method: state ? 'PUT' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(state ? { body: JSON.stringify({ state }) } : {}), signal: timer });
      if (!response.ok) { await response.body?.cancel(); throw new ModelError('gpu_api_failed', { phase, httpStatus: response.status }); }
      let text = '';
      for await (const chunk of response.body) {
        text += Buffer.from(chunk).toString('utf8');
        if (text.length > 200000) throw new ModelError('gpu_api_failed');
      }
      const result = JSON.parse(text);
      if (state) {
        if (result.success !== true) throw new ModelError('gpu_api_failed');
        return;
      }
      const instance = result.instances;
      if (String(instance?.id) !== String(instanceId)) throw new ModelError('gpu_instance_mismatch');
      // Discard the remaining response, which can include instance credentials.
      return { actual: instance.actual_status, intended: instance.intended_status };
    } catch (error) {
      throw new ModelError(timer.aborted ? 'gpu_api_timeout' : error instanceof ModelError ? error.code : 'gpu_api_failed',
        { phase, httpStatus: error?.httpStatus });
    }
  }
  return { read: () => request(), setState: state => {
    if (!['running', 'stopped'].includes(state)) throw new ModelError('gpu_config');
    return request(state);
  } };
}
