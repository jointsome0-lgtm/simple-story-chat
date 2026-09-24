import https from 'node:https';

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };
export type Screen = { text: string; reply_markup?: InlineKeyboard; entities?: { type: 'pre'; offset: number; length: number }[] };
export type TelegramPayload = { timeout?: number; [field: string]: unknown };
// Bot API results are not validated; each caller reads only what its method returns.
export type TelegramApi = (method: string, payload?: TelegramPayload) => Promise<unknown>;
export type Chat = ReturnType<typeof createChat>;
// `deleteMessages` takes from 1 to 100 message ids in one call.
const DELETE_BATCH = 100;

export class TelegramError extends Error {
  declare code: number | string;
  declare retryAfter: number | undefined;
  constructor(code: number | string, retryAfter?: number) { super(`telegram_${code}`); this.code = code; this.retryAfter = retryAfter; }
}

// A payload with bytes in it is a file upload, which the Bot API takes as multipart/form-data and not as JSON.
// Only sendPhoto uses it here: the picture of a scene is sent from memory and is never written to this disk, so
// there is no file_id and no URL to send instead. Every other field of the payload travels beside the bytes as a
// form field, numbers and objects as the API reads them back (JSON), which is what `reply_parameters` needs.
export function multipartBody(payload: TelegramPayload, boundary: string): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const bytes = value instanceof Uint8Array;
    // The file name is ours and says nothing: Telegram shows it to nobody and the picture is not a document.
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`
      + (bytes ? '; filename="scene.png"\r\nContent-Type: image/png\r\n\r\n' : '\r\n\r\n');
    parts.push(Buffer.from(head, 'utf8'));
    parts.push(bytes ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : Buffer.from(typeof value === 'object' ? JSON.stringify(value) : String(value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

export function createApi(token: string): TelegramApi {
  return async (method, payload = {}) => {
    const upload = Object.values(payload).some(value => value instanceof Uint8Array);
    const boundary = upload ? `simple-chat-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}` : '';
    const body = upload ? multipartBody(payload, boundary) : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: 'api.telegram.org', family: 4, method: 'POST',
        path: `/bot${token}/${method}`, timeout: (payload.timeout || 0) * 1000 + 15_000,
        headers: { 'Content-Type': upload ? `multipart/form-data; boundary=${boundary}` : 'application/json',
          'Content-Length': Buffer.byteLength(body) },
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
    remove: (messageId: number) => api('deleteMessage', { chat_id: chatId, message_id: messageId }),
    // Messages of this chat, a hundred to a call (`deleteMessages`, which skips any message it cannot find). A call
    // that fails is tried again message by message, so that one message Telegram will not delete (gone already, or
    // past its 48 hours) costs only itself. A failure of any other kind (the network, the rate limit, a chat closed to
    // the bot) would meet every message after it as well, and ends the attempt. Resolves to how many messages went,
    // and never throws: the caller has nothing more to do about the rest.
    async removeAll(messageIds: number[]) {
      let removed = 0;
      for (let at = 0; at < messageIds.length; at += DELETE_BATCH) {
        const batch = messageIds.slice(at, at + DELETE_BATCH);
        try {
          await api('deleteMessages', { chat_id: chatId, message_ids: batch });
          removed += batch.length;
          continue;
        } catch { /* tried one by one below */ }
        for (const messageId of batch) {
          try { await api('deleteMessage', { chat_id: chatId, message_id: messageId }); removed++; }
          catch (error) { if ((error as { code?: unknown }).code !== 400) return removed; }
        }
      }
      return removed;
    },
    // The picture of a scene, uploaded from memory as PNG bytes and hung under the message it belongs to. A text
    // message cannot become a photo by an edit — editMessageMedia needs a message that already carries media — so
    // the status line that stood here is a message of its own, and the caller removes it once this one lands.
    // Resolves to the photo's own message id, by which a deletion of its scene takes it out of the chat again.
    async photo(bytes: Uint8Array, replyTo?: number, caption?: Screen) {
      const sent = await api('sendPhoto', { chat_id: chatId, photo: bytes,
        ...(caption ? { caption: caption.text, ...(caption.reply_markup ? { reply_markup: caption.reply_markup } : {}) } : {}),
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });
      // Bot API results are not validated; the id is read as returned.
      return (sent as { message_id?: number } | undefined)?.message_id;
    },
    // A rich message in HTML hung under another one: the folded prompt under a picture (local/picture.ts
    // `foldedPrompt`). Resolves to its own message id, by which a deletion of its scene takes it out of the chat too.
    async note(html: string, replyTo?: number) {
      const sent = await api('sendRichMessage', { chat_id: chatId, rich_message: { html },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });
      return (sent as { message_id?: number } | undefined)?.message_id;
    },
    async final(text: string, replyMarkup?: InlineKeyboard) {
      return api('sendRichMessage', { chat_id: chatId, rich_message: { markdown: text },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
    },
    // A disappearing status in the draft the scene will stream into (`preview`, same draft id): the scene's text
    // replaces it, and the final message removes the draft. Failures are ignored: it is a hint, never needed.
    async status(jobId: string, text: string) {
      try { await api('sendRichMessageDraft', { chat_id: chatId, draft_id: Number(jobId.slice(1)), rich_message: { markdown: text } }); }
      catch {}
    },
    // The draft travels beside the scene, never in front of it. Awaiting the round-trip inside the stream loop
    // (`local/llama.ts`) stopped the bot from reading the model's output, the socket filled and the slot on the card
    // stood still: a tester's 750-token scene took 45 s where the decoding itself was 19, and the harness never saw
    // it because a synthetic scene is 55 tokens and finishes before the first draft is due. The handler returns at
    // once now; one request is in flight at a time and a draft superseded while another was flying is dropped, since
    // only the newest text is worth showing. The scene's real text arrives as the final message either way.
    preview(jobId: string, prefix = '') {
      let text = prefix;
      let next = 0;
      let sending = false;
      let again = false;
      const flush = async (): Promise<void> => {
        if (sending) { again = true; return; }
        sending = true;
        try {
          await api('sendRichMessageDraft', { chat_id: chatId, draft_id: Number(jobId.slice(1)), rich_message: { markdown: text } });
        } catch (error) { next = Date.now() + ((error as { retryAfter?: number }).retryAfter || 5) * 1000; }
        finally {
          sending = false;
          if (again) { again = false; void flush(); }
        }
      };
      return (delta: string) => {
        text += delta;
        if (Date.now() < next) return;
        next = Date.now() + 1200;
        void flush();
      };
    },
  };
}
