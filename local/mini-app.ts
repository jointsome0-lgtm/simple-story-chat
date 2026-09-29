// The Mini App (docs/telegram-ui.md#mini-app): a page inside Telegram where a reader it serves looks through their
// stories, a story's characters and one person's card with their picture, and changes nothing. The bot serves it on
// loopback beside its polling (local/main.ts), and the owner forwards an HTTPS address of their choice to that port
// (docs/setup.md#mini-app). Whoever knows the address gets the page; everything about a library is answered only to the
// reader whose launch data Telegram signed for this bot, from their own library, through a connection that cannot
// write it.
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Library, Story } from '../lib/library.ts';
import type { Log } from './model-error.ts';
import { personAt, personTag } from './picture.ts';
import { readReference } from './picture-references.ts';
import { imageFormat } from './reference.ts';
import { Store, fileErrorCode } from './store.ts';
import { REGISTERED, shownLang, texts } from './text.ts';
import { characterCard, charactersOf, storyName } from './ui.ts';
import type { RenderDetails } from './ui.ts';

// Launch data is taken for an hour after Telegram signed it, and up to five minutes before by this computer's clock:
// long enough to look through a story, and short for a copy of it, which a tunnel that ends TLS sees in clear, to be
// of use.
export const INIT_DATA_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 300;
const INIT_DATA_CHARS = 8192;
// A picture is read only up to this size. The bot keeps none above 10 MB (local/reference.ts), and a drawn portrait's
// metadata, which the reader strips, adds little to that.
const PICTURE_BYTES = 16 * 1024 * 1024;
// The server shares the bot's process and its one thread, and a reader's launch data, or a copy of it, may ask for an
// hour (docs/setup.md#mini-app). So it takes at most 20 requests a second in all after a burst of 60, and a reader's
// requests to the API at most two a second after a burst of 40, which leaves room to tap through a story's people and
// their pictures quickly; it holds at most 64 MB of answers their clients have not taken yet, and gives each answer a
// minute. Past that it answers 429. It parses no library over 64 MB, far past any the bot, which parses a reader's
// library at each of their messages, would serve at a usable speed.
const ALL_REQUESTS = { burst: 60, perSecond: 20 };
const READER_REQUESTS = { burst: 40, perSecond: 2 };
const SENDING_BYTES = 64 * 1024 * 1024;
const ANSWER_MS = 60000;
const LIBRARY_BYTES = 64 * 1024 * 1024;

// The key Telegram signs a Mini App's launch data with for this bot: HMAC-SHA-256 of the bot token under "WebAppData"
// (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). The server holds this key alone,
// which checks launch data and cannot call the Bot API.
export const initDataKey = (token: string) => createHmac('sha256', 'WebAppData').update(token).digest();

// The reader's Telegram ID from the launch data of an opened Mini App (`Telegram.WebApp.initData`), or why it is refused.
// Telegram's check: every field but `hash`, `signature` among them, decoded once, as `key=value` lines sorted by key, is
// signed with HMAC-SHA-256 under the key. A field given twice is refused, since the two could be read two ways.
export function initDataUser(initData: string, key: Buffer, now = Date.now()): { user: string } | { refusal: 'malformed' | 'forged' | 'expired' } {
  if (initData.length > INIT_DATA_CHARS) return { refusal: 'malformed' };
  const fields = [...new URLSearchParams(initData)];
  const field = (name: string) => fields.find(([one]) => one === name)?.[1];
  const hash = field('hash') ?? '';
  if (new Set(fields.map(([name]) => name)).size !== fields.length || !/^[0-9a-f]{64}$/.test(hash)) return { refusal: 'malformed' };
  const checked = fields.filter(([name]) => name !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`).join('\n');
  if (!timingSafeEqual(createHmac('sha256', key).update(checked).digest(), Buffer.from(hash, 'hex'))) return { refusal: 'forged' };
  const date = field('auth_date') ?? '';
  const age = now / 1000 - Number(date);
  if (!/^\d{1,12}$/.test(date) || age > INIT_DATA_SECONDS || age < -CLOCK_SKEW_SECONDS) return { refusal: 'expired' };
  let user: { id?: unknown } | null;
  try { user = JSON.parse(field('user') ?? ''); } catch { return { refusal: 'malformed' }; }
  const id = user?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? { user: String(id) } : { refusal: 'malformed' };
}

type Answer = { status: number; type: string; body: string | Uint8Array; headers?: Record<string, string> };
const json = (status: number, value: unknown): Answer => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value) });
// A missing item and anything the reader may not see here, another reader's included, answer alike. Launch data that is
// missing, forged or over an hour old answers 401 instead, which says only that, so that the page can ask to reopen it.
const MISSING = json(404, { error: 'not_found' });
const UNSIGNED = { ...json(401, { error: 'unauthorized' }), headers: { 'www-authenticate': 'tma' } };
// Nothing is cached anywhere, and the page runs Telegram's script and its own alone, reaches only this address, and is
// framed by Telegram Web alone (its other clients open it in a window of their own).
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin' };
const PAGE_POLICY = "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' blob:; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org";
const BUSY = { ...json(429, { error: 'busy' }), headers: { 'retry-after': '1' } };
const size = (answer: Answer) => typeof answer.body === 'string' ? Buffer.byteLength(answer.body) : answer.body.byteLength;
// The story IDs the library gives (lib/library.ts `id`), a place on a story's sheet and the tag of the name at it
// (local/picture.ts `personAt`).
const ID = { story: /^h\d{1,9}$/, index: /^\d{1,3}$/, tag: /^[0-9a-f]{8}$/ };

// Whether one more request fits a budget of `burst` requests that refills at `perSecond`.
function budget({ burst, perSecond }: { burst: number; perSecond: number }) {
  let left = burst;
  let at = Date.now();
  return () => {
    const now = Date.now();
    left = Math.min(burst, left + (now - at) / 1000 * perSecond);
    at = now;
    if (left < 1) return false;
    left -= 1;
    return true;
  };
}

// The page, its script and its style, read once at start. The page carries its own few lines in every language, for
// what it says before an answer or in place of one.
function staticFiles(): Record<string, Answer> {
  const read = (name: string) => readFileSync(new URL(`./mini-app/${name}`, import.meta.url), 'utf8');
  const lines = Object.fromEntries(REGISTERED.map(lang => {
    const t = texts(lang);
    return [lang, { notFound: t.miniApp.notFound, expired: t.miniApp.expired, failed: t.miniApp.failed, outside: t.miniApp.outside,
      refresh: t.buttons.refresh }];
  }));
  const page = read('index.html').replace('__LINES__', () => JSON.stringify(lines).replace(/</g, '\\u003c'));
  return { '/': { status: 200, type: 'text/html; charset=utf-8', body: page, headers: { 'content-security-policy': PAGE_POLICY } },
    '/app.js': { status: 200, type: 'text/javascript; charset=utf-8', body: read('app.js') },
    '/app.css': { status: 200, type: 'text/css; charset=utf-8', body: read('app.css') } };
}

// The reader's stories, the one being played first and then the newest, each named and counted as the chat's list of
// a seed's stories has it.
function storiesView(state: Library) {
  const t = texts(state.language);
  const current = (story: Story) => story.id === state.active?.storyId;
  const stories = Object.values(state.stories).filter(story => ID.story.test(story?.id))
    .sort((a, b) => Number(current(b)) - Number(current(a)) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  return { lang: shownLang(state.language), title: t.miniApp.stories, none: t.miniApp.noStories, stories: stories.map(story => {
    const people = charactersOf(state, story).length;
    return { id: story.id, name: storyName(state, story), note: [t.count.branches(Object.keys(story.branches ?? {}).length),
      t.count.scenes(Object.keys(story.nodes ?? {}).length), people ? t.miniApp.people(people) : null,
      current(story) ? t.common.current : null].filter(Boolean).join(' · ') };
  }) };
}

// A story's characters as the chat's list has them (local/ui.ts `charactersOf`).
function charactersView(state: Library, story: Story) {
  const c = texts(state.language).characters;
  return { lang: shownLang(state.language), title: c.title(storyName(state, story)), none: c.none,
    people: charactersOf(state, story).map(one => ({ index: one.index, tag: personTag(one.name), name: one.name, look: one.summary, pov: one.viewer })) };
}

// A person's card: the chat card's fields, each with its title and the lines under it (local/ui.ts `characterCard`),
// and the size of the picture its portrait's line speaks of. The lines about changing the card, and the one pointing at
// the button that switches whose eyes the frames see through, stay in the chat, which has those buttons.
function cardView(state: Library, story: Story, found: NonNullable<ReturnType<typeof personAt>>, details: RenderDetails) {
  const c = texts(state.language).characters;
  const card = characterCard(state, story, found, details);
  const size = card.picture && [card.picture.width, card.picture.height].every(side => Number.isSafeInteger(side) && side > 0)
    ? { width: card.picture.width, height: card.picture.height } : null;
  const blocks: { heading?: string; text?: string; notes: (string | null)[] }[] = [
    ...card.described ? [{ heading: card.descriptionTitle, text: card.described, notes: [card.descriptionSize] }] : [],
    ...card.changes ? [{ heading: c.changes, text: card.changes, notes: [] }] : [],
    ...card.along ? [{ notes: [card.along] }] : [],
    { heading: c.look, text: card.person.look, notes: [card.lookSize, card.whose] },
    card.clothes ? { heading: card.clothesTitle, text: card.clothes, notes: [card.clothesSize] } : { notes: [c.noClothes] },
    ...card.portrait ? [{ notes: [card.portrait, card.source, card.frames] }] : [],
    ...card.viewer && card.pov ? [{ notes: [card.pov] }] : [],
  ];
  return { lang: shownLang(state.language), title: c.cardTitle(card.person.name, storyName(state, story)), name: card.person.name,
    picture: card.picture?.file ? size ?? {} : null, blocks: blocks.map(block => ({ ...block, notes: block.notes.filter(note => note !== null) })) };
}

export type MiniAppOptions = {
  dbPath: string; port: number; key: Buffer; users: Set<string>; ownerId?: string;
  // What a reader's card says of pictures, as their chat card does (local/bot.ts `pictureInfo`).
  details: (userId: string) => RenderDetails;
  log: Log;
};

export async function serveMiniApp({ dbPath, port, key, users, ownerId = '', details, log }: MiniAppOptions) {
  const files = staticFiles();
  // Its own connection, opened read-only: nothing here can write a library.
  const store = new Store(dbPath, { readOnly: true });
  // A row of the log goes at most once a minute for each event, code and actor, since anybody who knows the address can
  // cause a refusal, and a reader's launch data, or a copy of it, can ask again and again for an hour.
  const loggedAt = new Map<string, number>();
  const note = (event: string, code: string, userId?: string) => {
    const actor = userId === undefined ? undefined : userId === ownerId ? 'owner' : 'other';
    const at = Date.now();
    const row = `${event} ${code} ${actor}`;
    if ((loggedAt.get(row) ?? -Infinity) + 60000 > at) return;
    loggedAt.set(row, at);
    log(event, code, actor && { actor });
  };

  const allRequests = budget(ALL_REQUESTS);
  const readerRequests = new Map<string, () => boolean>();
  let sending = 0;

  const answer = (request: IncomingMessage): Answer => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'GET') return MISSING;
    if (Object.hasOwn(files, path)) return files[path];
    if (!path.startsWith('/api/')) return MISSING;
    const header = request.headersDistinct.authorization;
    if (header?.length !== 1 || !header[0].startsWith('tma ')) { note('mini_app_refused', 'no_init_data'); return UNSIGNED; }
    const checked = initDataUser(header[0].slice(4), key);
    if ('refusal' in checked) { note('mini_app_refused', checked.refusal); return UNSIGNED; }
    // The reader is the one the signed data names, and nothing in the address names a reader.
    const userId = checked.user;
    const missing = (code: string) => { note('mini_app_refused', code, userId); return MISSING; };
    const served = (kind: string, reply: Answer) => { note('mini_app_served', kind, userId); return reply; };
    if (!users.has(userId)) return missing('not_listed');
    if (!readerRequests.has(userId)) readerRequests.set(userId, budget(READER_REQUESTS));
    if (!readerRequests.get(userId)!()) { note('mini_app_refused', 'busy', userId); return BUSY; }
    // An address of no route here is refused before the library is read.
    const [, , route, storyId, people, index, tag, picture, ...rest] = path.split('/');
    if (route !== 'stories' || rest.length || storyId !== undefined && (!ID.story.test(storyId) || people !== 'people'
      || index !== undefined && (!ID.index.test(index) || !ID.tag.test(tag ?? '') || picture !== undefined && picture !== 'picture'))) {
      return missing('missing');
    }
    if (store.size(userId) > LIBRARY_BYTES) return missing('library_too_large');
    const state = store.read(userId);
    if (storyId === undefined) return served('stories', json(200, storiesView(state)));
    const story = Object.hasOwn(state.stories, storyId) ? state.stories[storyId] : undefined;
    if (!story) return missing('missing');
    if (index === undefined) return served('characters', json(200, charactersView(state, story)));
    const found = personAt(story, index, tag);
    if (!found) return missing('missing');
    if (picture === undefined) return served('card', json(200, cardView(state, story, found, details(userId))));
    // The file the reader's own library names for the person, the one the card's portrait line speaks of, from the
    // reader's own directory: a plain file of a size the bot keeps, read by the bot's own reader of references, which
    // takes nothing but a random name there (local/picture-references.ts `readReference`). Only the bot writes that
    // directory (local/store.ts), and whoever can write it can read the database beside it as well.
    const file = characterCard(state, story, found, { ...details(userId), textTokens: undefined }).picture?.file;
    if (!file || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(file)) return missing('missing');
    const stat = lstatSync(join(store.portraits(userId), file), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > PICTURE_BYTES) return missing('picture_unavailable');
    const { bytes } = readReference(store, userId, file);
    return served('picture', { status: 200, type: `image/${imageFormat(bytes)}`, body: bytes });
  };

  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 5000 }, (request, response) => {
    let reply: Answer;
    if (!allRequests() || sending >= SENDING_BYTES) { note('mini_app_refused', 'busy'); reply = BUSY; }
    // A library or a file that cannot be read answers as a missing item, and stops nothing else.
    else try { reply = answer(request); } catch (error) { note('mini_app_failed', fileErrorCode(error)); reply = MISSING; }
    // An answer that would take those not yet taken past their bound goes as a refusal instead.
    if (reply !== BUSY && sending + size(reply) > SENDING_BYTES) { note('mini_app_refused', 'busy'); reply = BUSY; }
    const bytes = size(reply);
    sending += bytes;
    const deadline = setTimeout(() => response.destroy(), ANSWER_MS).unref();
    response.once('close', () => { sending -= bytes; clearTimeout(deadline); });
    response.writeHead(reply.status, { ...HEADERS, 'content-type': reply.type, ...reply.headers });
    response.end(reply.body);
  });
  server.maxConnections = 32;
  try {
    await new Promise<void>((listening, failed) => {
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.off('error', failed); listening(); });
    });
  } catch (error) { store.close(); throw error; }
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      server.closeAllConnections();
      await new Promise(closed => server.close(closed));
      store.close();
    },
  };
}
