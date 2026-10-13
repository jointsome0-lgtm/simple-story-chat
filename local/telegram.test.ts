import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat, multipartBody } from './telegram.ts';
import type { TelegramPayload } from './telegram.ts';

// A Telegram that answers when told to, so a test can hold a request in flight the way the network does.
function pending() {
  const calls: { method: string; text: string; finish: () => void; fail: () => void }[] = [];
  const api = ((method: string, payload: Record<string, unknown>) => new Promise<never>((resolve, reject) => {
    const rich = payload.rich_message as { markdown: string } | undefined;
    calls.push({ method, text: rich?.markdown ?? '', finish: () => resolve(undefined as never),
      fail: () => reject(Object.assign(new Error('rate'), { retryAfter: 30 })) });
  })) as unknown as Parameters<typeof createChat>[0];
  return { api, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a draft does not hold up the scene it is showing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { api, calls } = pending();
  const onText = createChat(api, 1).preview('j7', 'начало: ');
  const sent = () => calls.map(call => call.text);
  // The stream hands over a delta and must get on with reading: awaiting the round-trip here stalled the card.
  assert.equal(onText('раз'), undefined);
  await settle();
  assert.deepEqual(calls.map(call => [call.method, call.text]), [['sendRichMessageDraft', 'начало: раз']]);
  // A delta within 1200 ms of a draft only grows the text: nothing is queued behind the draft in flight.
  onText(' два');
  calls[0]!.finish();
  await settle();
  assert.equal(calls.length, 1, 'the 1200 ms gate held the delta');
  // A draft due while another is in flight waits for it to land, and the drafts it overtook are dropped: the newest
  // text goes once.
  t.mock.timers.tick(1200);
  onText(' три');
  t.mock.timers.tick(1200);
  onText(' четыре');
  onText(' пять');
  await settle();
  assert.deepEqual(sent(), ['начало: раз', 'начало: раз два три'], 'no second request while one is in flight');
  calls[1]!.finish();
  await settle();
  assert.deepEqual(sent().slice(2), ['начало: раз два три четыре пять'], 'the newest text, once');
  // A failure pushes the next draft away by Telegram's retryAfter (30 s here), past its own 5 s, instead of retrying.
  calls[2]!.fail();
  await settle();
  t.mock.timers.tick(10_000);
  onText(' шесть');
  await settle();
  assert.equal(calls.length, 3, 'no retry before retryAfter');
  t.mock.timers.tick(20_000);
  onText(' семь');
  await settle();
  assert.deepEqual(sent().slice(3), ['начало: раз два три четыре пять шесть семь'], 'the next draft after retryAfter');
});

// A picture under a scene: what the chat asks the Bot API for, and how the bytes are packed for it.
test('a picture is sent as a photo under the message it belongs to, and the line above it is removed by id', async () => {
  const calls: { method: string; payload: TelegramPayload | undefined }[] = [];
  const api = (async (method: string, payload?: TelegramPayload) => {
    calls.push({ method, payload });
    return { message_id: calls.length };
  }) as unknown as Parameters<typeof createChat>[0];
  const one = createChat(api, 7);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const html = '<details><summary>S</summary>P</details>';
  const under = (message_id: number) => ({ reply_parameters: { message_id, allow_sending_without_reply: true } });
  const keyboard = { inline_keyboard: [[{ text: 'E', callback_data: 'prompt-edit:3' }]] };
  // A photo and its note resolve to their own message id, by which a deletion of the scene takes them out again.
  const rows: [string, () => Promise<unknown>, string, TelegramPayload][] = [
    ['a photo under its scene', () => one.photo(bytes, 42), 'sendPhoto', { chat_id: 7, photo: bytes, ...under(42) }],
    ['the line above it, removed by id', () => one.remove(11), 'deleteMessage', { chat_id: 7, message_id: 11 }],
    ['a scene whose own message is not known', () => one.photo(bytes, undefined), 'sendPhoto', { chat_id: 7, photo: bytes }],
    ['the prompt under the photo', () => one.note(html, 3), 'sendRichMessage', { chat_id: 7, rich_message: { html }, ...under(3) }],
    // Under a scene's own picture the note carries the button that asks for a variant of it (local/picture.ts).
    ['the prompt with its button', () => one.note(html, 3, keyboard), 'sendRichMessage',
      { chat_id: 7, rich_message: { html }, ...under(3), reply_markup: keyboard }],
  ];
  for (const [label, send, method, payload] of rows) {
    const id = await send();
    assert.deepEqual(calls.at(-1), { method, payload }, label);
    if (method !== 'deleteMessage') assert.equal(id, calls.length, label);
  }
  assert.equal(calls.length, rows.length, 'one call each');
  // The upload: the file is the only part with a name and a type, its bytes copied rather than re-encoded, an object
  // field is JSON as the Bot API reads it back, and a field nobody set adds no part at all.
  const part = (name: string) => `--BOUNDARY\r\nContent-Disposition: form-data; name="${name}"`;
  assert.equal(multipartBody(calls[0]!.payload!, 'BOUNDARY').toString('latin1'), `${part('chat_id')}\r\n\r\n7\r\n`
    + `${part('photo')}; filename="scene.png"\r\nContent-Type: image/png\r\n\r\n${bytes.toString('latin1')}\r\n`
    + `${part('reply_parameters')}\r\n\r\n{"message_id":42,"allow_sending_without_reply":true}\r\n--BOUNDARY--\r\n`);
  assert.ok(!multipartBody({ chat_id: 7, photo: bytes, caption: undefined }, 'B').toString('latin1').includes('caption'));
});

test('messages go a hundred to a call, one by one when a call fails, and no further past a failure of the chat itself', async () => {
  const calls: { method: string; payload: TelegramPayload }[] = [];
  const refused = (code: number | string): never => { throw Object.assign(new Error('synthetic'), { code }); };
  let answer = (method: string, payload: TelegramPayload): unknown => true;
  const api = (async (method: string, payload: TelegramPayload) => {
    calls.push({ method, payload });
    return answer(method, payload);
  }) as unknown as Parameters<typeof createChat>[0];
  const chat = createChat(api, 7);
  const ids = Array.from({ length: 250 }, (_, n) => n + 1);
  assert.equal(await chat.removeAll(ids), 250);
  assert.deepEqual(calls.map(call => [call.method, call.payload.chat_id, (call.payload.message_ids as number[]).length]),
    [['deleteMessages', 7, 100], ['deleteMessages', 7, 100], ['deleteMessages', 7, 50]]);
  assert.deepEqual(calls.flatMap(call => call.payload.message_ids as number[]), ids);

  // A call Telegram refuses: each message is tried alone, and one it will not delete costs only itself.
  calls.length = 0;
  answer = (method, payload) => (method === 'deleteMessages' || payload.message_id === 2 ? refused(400) : true);
  assert.equal(await chat.removeAll([1, 2, 3]), 2);
  assert.deepEqual(calls.map(call => [call.method, call.payload.message_id]),
    [['deleteMessages', undefined], ['deleteMessage', 1], ['deleteMessage', 2], ['deleteMessage', 3]]);

  // The network, the rate limit or a chat closed to the bot would meet every message after it the same way.
  for (const code of ['network', 429, 403]) {
    calls.length = 0;
    answer = () => refused(code);
    assert.equal(await chat.removeAll(ids), 0);
    assert.deepEqual(calls.map(call => call.method), ['deleteMessages', 'deleteMessage'], String(code));
  }
});
