import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

// A button under a message: an action the bot answers, or one that opens the Mini App (local/mini-app.ts), which
// Telegram shows only in a private chat with the bot.
export type InlineButton = { text: string; callback_data: string; web_app?: undefined }
  | { text: string; web_app: { url: string }; callback_data?: undefined };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };
export type Screen = { text: string; reply_markup?: InlineKeyboard; entities?: { type: 'pre'; offset: number; length: number }[] };
export type TelegramPayload = { timeout?: number; [field: string]: unknown };
// Bot API results are not validated; each caller reads only what its method returns.
// `signal` ends the call and its request once it aborts, as a stop or a deadline does (local/seed-file.ts).
export type TelegramApi = (method: string, payload?: TelegramPayload, options?: { signal?: AbortSignal }) => Promise<unknown>;
export type Chat = ReturnType<typeof createChat>;
// What a message the bot sends for the moment is for (docs/telegram-ui.md#passing-messages): a `screen`, a menu, a list
// or a wait, which the next screen opened by one of its buttons replaces; a `notice`, a refusal, an error or a
// confirmation, which goes with the reader's next update; a `status` line, which its sender removes or turns into a
// notice. `wait` names the wait a screen shows (local/bot.ts `waitOf`), so that it goes once the wait is over.
export type Passing = 'screen' | 'notice' | 'status';
type Passed = { kind: Passing; wait?: string };
// What the bot remembers of one private chat across its updates, in memory alone: its passing messages by id, and the
// message that carries the newest scene keyboard with the story and branch of its scene (`final`). A restart forgets
// it, and what it held then stays in the chat as any message does. Only `show` adds to `passed`, so a scene, a photo
// or a note never enters it (`tidy`, `put`).
// The keyboard a scene goes out with (`final`). A keyboard of the moment (`passing`), the one a scene shown again while
// the next is written gets, leaves the keyboard of the scene before it as it is. `current` says, once the scene is out,
// whether it is still of the story and branch the reader is on, and `branch` names that story and branch.
export type SceneButtons = { reply_markup?: InlineKeyboard; passing?: boolean; current?: () => boolean; branch?: string };
export type ChatMemory = { passed: Map<number, Passed>; buttons?: number; holder?: string };
export const chatMemory = (): ChatMemory => ({ passed: new Map() });
// The passing messages remembered per chat, the oldest forgotten first: a button pressed on one later sends anew.
const PASSED_MAX = 200;
// `deleteMessages` takes from 1 to 100 message ids in one call.
const DELETE_BATCH = 100;
// The pauses before a photo's second and third upload (`photo`).
const PHOTO_RETRY_MS = [2000, 5000];

export class TelegramError extends Error {
  declare code: number | string;
  declare retryAfter: number | undefined;
  // An edit refused because the message shows that very text and keyboard already (`put`). Telegram says so only in
  // its description, which is read for this alone and never kept, logged or shown.
  declare notModified: boolean;
  constructor(code: number | string, retryAfter?: number, notModified = false) {
    super(`telegram_${code}`); this.code = code; this.retryAfter = retryAfter; this.notModified = notModified;
  }
}

// A payload with bytes in it is a file upload, which the Bot API takes as multipart/form-data and not as JSON.
// sendPhoto uses it: the picture of a scene is sent from memory and is never written to this disk, so there is no
// file_id and no URL to send instead. So does sendDocument, for a branch as a text file (`document`), whose name goes in
// `file_name` and not as a field of its own. Every other field of the payload travels beside the bytes as a
// form field, numbers and objects as the API reads them back (JSON), which is what `reply_parameters` needs.
export function multipartBody({ file_name: fileName, ...payload }: TelegramPayload, boundary: string): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const bytes = value instanceof Uint8Array;
    // A picture's file name is ours and says nothing: Telegram shows it to nobody and the picture is not a document.
    // A document's is shown; a character that could end the header goes.
    const file = name === 'document' ? `; filename="${String(fileName).replace(/["\\\r\n]/g, '')}"\r\nContent-Type: text/plain; charset=utf-8`
      : '; filename="scene.png"\r\nContent-Type: image/png';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`
      + (bytes ? `${file}\r\n\r\n` : '\r\n\r\n');
    parts.push(Buffer.from(head, 'utf8'));
    parts.push(bytes ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : Buffer.from(typeof value === 'object' ? JSON.stringify(value) : String(value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

export function createApi(token: string): TelegramApi {
  return async (method, payload = {}, options = {}) => {
    const upload = Object.values(payload).some(value => value instanceof Uint8Array);
    const boundary = upload ? `simple-chat-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}` : '';
    const body = upload ? multipartBody(payload, boundary) : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: 'api.telegram.org', family: 4, method: 'POST',
        path: `/bot${token}/${method}`, timeout: (payload.timeout || 0) * 1000 + 15_000, ...options.signal ? { signal: options.signal } : {},
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
          let value: { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: number } };
          try { value = JSON.parse(data); } catch { reject(new TelegramError('invalid_response')); return; }
          if (!value.ok) reject(new TelegramError(Number(value.error_code) || 'rejected', value.parameters?.retry_after,
            typeof value.description === 'string' && /message is not modified/i.test(value.description)));
          else resolve(value.result);
        });
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => reject(new TelegramError('network')));
      request.end(body);
    });
  };
}

export function createChat(api: TelegramApi, chatId: number | string, memory: ChatMemory = chatMemory()) {
  const { passed } = memory;
  // Messages of this chat, a hundred to a call (`deleteMessages`, which skips any message it cannot find). A call
  // that fails is tried again message by message, so that one message Telegram will not delete (gone already, or
  // past its 48 hours) costs only itself. A failure of any other kind (the network, the rate limit, a chat closed to
  // the bot) would meet every message after it as well, and ends the attempt. Resolves to how many messages went and
  // the ids still in the chat for all it knows (that failure's and the ones after it), and never throws: the caller has
  // nothing more to do about the rest.
  async function removeEach(messageIds: number[]) {
    let removed = 0;
    for (let at = 0; at < messageIds.length; at += DELETE_BATCH) {
      const batch = messageIds.slice(at, at + DELETE_BATCH);
      try {
        await api('deleteMessages', { chat_id: chatId, message_ids: batch });
        removed += batch.length;
        continue;
      } catch { /* tried one by one below */ }
      for (const [n, messageId] of batch.entries()) {
        try { await api('deleteMessage', { chat_id: chatId, message_id: messageId }); removed++; }
        catch (error) { if ((error as { code?: unknown }).code !== 400) return { removed, left: messageIds.slice(at + n) }; }
      }
    }
    return { removed, left: [] };
  }
  const removeAll = async (messageIds: number[]) => (await removeEach(messageIds)).removed;
  // A passing message (`Passing`), remembered under the id it resolves to; one Telegram gave no id for is not.
  async function show(screen: Screen, kind: Passing, wait?: string) {
    const sent = await api('sendMessage', { chat_id: chatId, ...screen }) as { message_id?: unknown } | null | undefined;
    const id = sent?.message_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return undefined;
    passed.set(id, { kind, wait });
    if (passed.size > PASSED_MAX) passed.delete(passed.keys().next().value!);
    return id;
  }
  return {
    // A message that stays: nothing here deletes it or writes over it on its own (`tidy`, `put`).
    send: (screen: Screen) => api('sendMessage', { chat_id: chatId, ...screen }),
    edit: (messageId: number, screen: Screen) => api('editMessageText', { chat_id: chatId, message_id: messageId, ...screen }),
    async remove(messageId: number) {
      const result = await api('deleteMessage', { chat_id: chatId, message_id: messageId });
      passed.delete(messageId);
      return result;
    },
    removeAll,
    show,
    // A screen in the place of the passing message `messageId`, the one whose button was pressed, or a message of its
    // own when that is none: a scene, a photo or a note is never written over. The edit is always asked for, also of a
    // screen that looks the same, since only Telegram knows whether the message is still there: one that shows the very
    // same screen already (`notModified`) is that screen, and one Telegram will not edit otherwise (deleted by the
    // reader) becomes a notice while the screen goes anew. Resolves to the screen's message id and whether it took the
    // pressed message's place.
    async put(messageId: number | undefined, screen: Screen, kind: Passing, wait?: string) {
      const one = messageId === undefined ? undefined : passed.get(messageId);
      if (messageId !== undefined && one && one.kind !== 'status') {
        let edited = true;
        try { await api('editMessageText', { chat_id: chatId, message_id: messageId, ...screen }); }
        catch (error) {
          if ((error as { code?: unknown }).code !== 400) throw error;
          edited = (error as { notModified?: unknown }).notModified === true;
        }
        Object.assign(one, edited ? { kind, wait } : { kind: 'notice', wait: undefined });
        if (edited) return { id: messageId, replaced: true };
      }
      return { id: await show(screen, kind, wait), replaced: false };
    },
    // A passing message that stays from now on, as any message does: a status line that has become a card.
    keep(messageId: number) { passed.delete(messageId); },
    // Whether a screen may take the place of `messageId` (`put`).
    replaceable(messageId: number | undefined) {
      const one = messageId === undefined ? undefined : passed.get(messageId);
      return !!one && one.kind !== 'status';
    },
    // A passing message of another kind from now on: a status line that has said its last word is a notice.
    mark(messageId: number, kind: Passing) {
      const one = passed.get(messageId);
      if (one) one.kind = kind;
    },
    // The passing messages of one kind, and the screens that show a wait, oldest first.
    passing(kind: Passing) { return [...passed].filter(([, one]) => one.kind === kind).map(([id]) => id); },
    waits() { return [...passed].flatMap(([id, one]) => one.wait === undefined ? [] : [{ id, wait: one.wait }]); },
    // Deletes passing messages and nothing else: an id `show` did not remember, a scene's, a photo's, a note's or one
    // sent before the bot started, stays in the chat whatever the caller asks. Never throws. The ids are let go at
    // once, before Telegram is asked, so that nothing writes over a message on its way out (`put`) or counts it as
    // still there; one that went or that Telegram has no more (400) stays let go, and one a rate limit, a closed chat
    // or the network kept is remembered again as it was, for the next `tidy` to try. Resolves to how many went.
    async tidy(messageIds: number[]) {
      const taken = new Map<number, Passed>();
      for (const messageId of messageIds) {
        const one = passed.get(messageId);
        if (one) { taken.set(messageId, one); passed.delete(messageId); }
      }
      if (!taken.size) return 0;
      const { removed, left } = await removeEach([...taken.keys()]);
      for (const messageId of left) if (!passed.has(messageId)) passed.set(messageId, taken.get(messageId)!);
      return removed;
    },
    // The picture of a scene, uploaded from memory as PNG bytes and hung under the message it belongs to. A text
    // message cannot become a photo by an edit — editMessageMedia needs a message that already carries media — so
    // the status line that stood here is a message of its own, and the caller removes it once this one lands.
    // Resolves to the photo's own message id, by which a deletion of its scene takes it out of the chat again.
    // An upload that got no answer (`network`: the connection dropped or went silent) is sent again 2 s after the
    // failure and once more 5 s after a second one, since the picture is drawn already and the drops seen so far
    // lasted seconds. No answer does not mean the photo did not arrive, so in rare cases a retry shows the reader the
    // same photo twice, which is better than a lost picture. Any other failure throws at once, and so does a third
    // upload without an answer.
    async photo(bytes: Uint8Array, replyTo?: number, caption?: Screen, keepFile?: (fileId: string) => void) {
      const payload = { chat_id: chatId, photo: bytes,
        ...(caption ? { caption: caption.text, ...(caption.reply_markup ? { reply_markup: caption.reply_markup } : {}) } : {}),
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) };
      for (let attempt = 0; ; attempt++) {
        try {
          const sent = await api('sendPhoto', payload) as { message_id?: number; photo?: { file_id?: unknown }[] } | undefined;
          // Bot API results are not validated; the ids are read as returned. The last size is the largest.
          const fileId = sent?.photo?.at(-1)?.file_id;
          if (typeof fileId === 'string') keepFile?.(fileId);
          return sent?.message_id;
        } catch (error) {
          const noAnswer = error instanceof TelegramError && error.code === 'network';
          if (!noAnswer || attempt === PHOTO_RETRY_MS.length) throw error;
          await delay(PHOTO_RETRY_MS[attempt]);
        }
      }
    },
    // A file the reader asked for, a message that stays. `fileName` is shown with it.
    async document(bytes: Uint8Array, fileName: string, caption: string) {
      await api('sendDocument', { chat_id: chatId, document: bytes, file_name: fileName, caption });
    },
    // A rich message in HTML hung under another one: the folded prompt under a picture (local/picture.ts
    // `foldedPrompt`). Resolves to its own message id, by which a deletion of its scene takes it out of the chat too.
    async note(html: string, replyTo?: number, replyMarkup?: InlineKeyboard) {
      const sent = await api('sendRichMessage', { chat_id: chatId, rich_message: { html },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
      return (sent as { message_id?: number } | undefined)?.message_id;
    },
    // A scene, the newest of the story or one shown again. Only the newest scene keyboard stays: the one before it loses
    // its buttons, which act on the branch being played and not on the scene above them, so that «Продолжить» under
    // an older scene does not seem to continue from there. Only the keyboard goes, the text stays, and a keyboard
    // Telegram will not remove (one past a restart is not known) stays as it was. Each scene goes out at once, with
    // the keyboard `keyboard` builds right before it, and the newest by message id, which Telegram gives a chat's
    // messages in the order it takes them, holds the buttons: a scene answered after a newer one took them over loses
    // its own, and so does one whose story or branch the reader has left while it was on its way. A scene that goes out
    // with a keyboard of the moment takes nothing over and is never stripped: the scene before it keeps its own, as the
    // next scene may never come.
    async final(text: string, keyboard: () => SceneButtons = () => ({})) {
      const { reply_markup: replyMarkup, passing, current, branch } = keyboard();
      const sent = await api('sendRichMessage', { chat_id: chatId, rich_message: { markdown: text },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
      const id = (sent as { message_id?: unknown } | null | undefined)?.message_id;
      if (replyMarkup && !passing && typeof id === 'number') {
        const strip = (messageId: number) => void api('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId }).catch(() => {});
        const newest = memory.buttons;
        // Ids are compared only within one story and branch: a current scene takes the buttons from a scene of another
        // one whatever their ids.
        if (current && !current()) strip(id);
        else if (newest === undefined || id > newest || memory.holder !== branch) {
          memory.buttons = id;
          memory.holder = branch;
          if (newest !== undefined && newest !== id) strip(newest);
        } else if (id < newest) strip(id);
      }
      return sent;
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
