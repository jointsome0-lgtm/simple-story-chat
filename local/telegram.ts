import https from 'node:https';

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };
export type Screen = { text: string; reply_markup?: InlineKeyboard; entities?: { type: 'pre'; offset: number; length: number }[] };
export type TelegramPayload = { timeout?: number; [field: string]: unknown };
// Bot API results are not validated; each caller reads only what its method returns.
export type TelegramApi = (method: string, payload?: TelegramPayload) => Promise<unknown>;
export type Chat = ReturnType<typeof createChat>;

export class TelegramError extends Error {
  declare code: number | string;
  declare retryAfter: number | undefined;
  constructor(code: number | string, retryAfter?: number) { super(`telegram_${code}`); this.code = code; this.retryAfter = retryAfter; }
}

export function createApi(token: string): TelegramApi {
  return async (method, payload = {}) => {
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: 'api.telegram.org', family: 4, method: 'POST',
        path: `/bot${token}/${method}`, timeout: (payload.timeout || 0) * 1000 + 15_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          data += chunk;
          if (data.length > 2_000_000) request.destroy();
        });
        response.on('error', () => reject(new TelegramError('network')));
        response.on('end', () => {
          let value: { ok?: unknown; result?: unknown; error_code?: unknown; parameters?: { retry_after?: number } };
          try { value = JSON.parse(data); } catch { reject(new TelegramError('invalid_response')); return; }
          if (!value.ok) reject(new TelegramError(Number(value.error_code) || 'rejected', value.parameters?.retry_after));
          else resolve(value.result);
        });
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => reject(new TelegramError('network')));
      request.end(body);
    });
  };
}

export function createChat(api: TelegramApi, chatId: number | string) {
  return {
    send: (screen: Screen) => api('sendMessage', { chat_id: chatId, ...screen }),
    edit: (messageId: number, screen: Screen) => api('editMessageText', { chat_id: chatId, message_id: messageId, ...screen }),
    async final(text: string, replyMarkup?: InlineKeyboard) {
      return api('sendRichMessage', { chat_id: chatId, rich_message: { markdown: text },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
    },
    preview(jobId: string, prefix = '') {
      let text = prefix;
      let next = 0;
      return async (delta: string) => {
        text += delta;
        if (Date.now() < next) return;
        next = Date.now() + 1200;
        try {
          await api('sendRichMessageDraft', { chat_id: chatId, draft_id: Number(jobId.slice(1)), rich_message: { markdown: text } });
        } catch (error) { next = Date.now() + ((error as { retryAfter?: number }).retryAfter || 5) * 1000; }
      };
    },
  };
}
