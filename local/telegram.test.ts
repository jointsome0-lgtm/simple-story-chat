import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat, multipartBody } from './telegram.ts';
import type { TelegramPayload } from './telegram.ts';

// A Telegram that answers when told to, so a test can hold a request in flight the way the network does.
function pending() {
  const calls: { method: string; text: string; finish: () => void }[] = [];
  const api = ((method: string, payload: Record<string, unknown>) => new Promise<never>(resolve => {
    const rich = payload.rich_message as { markdown: string } | undefined;
    calls.push({ method, text: rich?.markdown ?? '', finish: () => resolve(undefined as never) });
  })) as unknown as Parameters<typeof createChat>[0];
  return { api, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a draft does not hold up the scene it is showing', async () => {
  const { api, calls } = pending();
  const onText = createChat(api, 1).preview('j7');
  // The stream hands over a delta and must get on with reading: awaiting the round-trip here stalled the card.
  const returned = onText('раз');
  assert.equal(returned, undefined);
  await settle();
  assert.deepEqual(calls.map(call => call.text), ['раз']);
  assert.equal(calls[0]!.method, 'sendRichMessageDraft');
});

test('a draft overtaken while another is in flight is dropped, and the newest text is sent once', async () => {
  const { api, calls } = pending();
  const onText = createChat(api, 1).preview('j7');
  onText('раз');
  await settle();
  assert.equal(calls.length, 1);
  // Deltas keep arriving while the first request is still flying. The 1200 ms gate lets none of them through, so
  // nothing is queued behind it; what matters is that the text kept growing and no request was lost.
  onText(' два');
  onText(' три');
  await settle();
  assert.equal(calls.length, 1, 'no second request while the first is in flight');
  calls[0]!.finish();
  await settle();
  assert.equal(calls.length, 1, 'nothing was queued, because the gate refused the later deltas');
});

test('a failure pushes the next draft away instead of retrying at once', async () => {
  const failures: string[] = [];
  const reject = (method: string) => { failures.push(method); return Promise.reject(Object.assign(new Error('rate'), { retryAfter: 30 })); };
  const api = reject as unknown as Parameters<typeof createChat>[0];
  const onText = createChat(api, 1).preview('j7', 'начало: ');
  onText('раз');
  await settle();
  assert.deepEqual(failures, ['sendRichMessageDraft']);
  // The retryAfter from Telegram holds the next attempt back; the handler still returns without throwing.
  onText(' два');
  await settle();
  assert.equal(failures.length, 1);
});

// A picture under a scene: what the chat asks the Bot API for, and how the bytes are packed for it.
test('a picture is sent as a photo under the message it belongs to, and the line above it is removed by id', async () => {
  const calls: { method: string; payload: TelegramPayload | undefined }[] = [];
  const api = (async (method: string, payload?: TelegramPayload) => {
    calls.push({ method, payload });
    return { message_id: calls.length };
  }) as unknown as Parameters<typeof createChat>[0];
  const one = createChat(api, 7);
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  await one.photo(bytes, 42);
  await one.remove(11);
  assert.deepEqual(calls.map(call => call.method), ['sendPhoto', 'deleteMessage']);
  assert.deepEqual(calls[0]!.payload, { chat_id: 7, photo: bytes, reply_parameters: { message_id: 42, allow_sending_without_reply: true } });
  assert.deepEqual(calls[1]!.payload, { chat_id: 7, message_id: 11 });
  // A scene whose own message is not known still gets its picture, just not as a reply to it.
  await one.photo(bytes, undefined);
  assert.deepEqual(calls[2]!.payload, { chat_id: 7, photo: bytes });
});

test('an upload carries the bytes and every other field beside them, as the Bot API reads them', () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const body = multipartBody({ chat_id: 7, photo: bytes, reply_parameters: { message_id: 42 } }, 'BOUNDARY');
  const text = body.toString('latin1');
  assert.ok(text.startsWith('--BOUNDARY\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n7\r\n'));
  // The file part is the only one with a name and a type, and the bytes are copied, not re-encoded.
  assert.ok(text.includes('Content-Disposition: form-data; name="photo"; filename="scene.png"\r\nContent-Type: image/png\r\n\r\n'));
  assert.ok(body.includes(bytes), 'the picture travels byte for byte');
  // An object field is JSON, which is how reply_parameters and reply_markup are sent beside a file.
  assert.ok(text.includes('name="reply_parameters"\r\n\r\n{"message_id":42}\r\n'));
  assert.ok(text.endsWith('--BOUNDARY--\r\n'));
  // A field nobody set adds no part at all.
  assert.ok(!multipartBody({ chat_id: 7, photo: bytes, caption: undefined }, 'B').toString('latin1').includes('caption'));
});
