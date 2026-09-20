import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat } from './telegram.ts';

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
