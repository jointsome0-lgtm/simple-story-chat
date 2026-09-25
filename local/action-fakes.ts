// The fakes the action measurement is rehearsed against before any card (docs/action-experiment.md#the-rentals): a
// simple-serving gateway behind the real adapter, with scripted failures, and a judge that writes made-up answers.
// Pictures come from local/fake-comfy.ts. Nothing here models a card or a model: every word a fake writes is made up
// here, and in the sharp stories it carries the dry run's marker, so that the boundary test has something to find.
import { ACTION_STORIES, MARKER_STORY, SHARP_THEMES } from '../examples/action-set.ts';
import { FACINGS } from './action-text.ts';
import type { Fetch } from './action-text.ts';

// What the fake gateway does to one kind of call of one story: `unparsed` answers something that is not JSON twice,
// `retry` once and then a valid reply, `truncated` a valid reply cut at the limit, `duplicate_roles` a variant whose
// two participants share a role, `empty_sheet` a sheet with nobody on it, `error` a refusal whose body carries the
// marker, which the adapter must read the code of and nothing else.
export type Fault = 'unparsed' | 'retry' | 'truncated' | 'duplicate_roles' | 'empty_sheet' | 'error';
export type CallKind = 'seed' | 'scene' | 'sheet' | 'frame' | 'variant';
export type Faults = Record<string, Partial<Record<CallKind, Fault>>>;

const SHARP_CAST = ['Агата', 'Богдан', 'Вацлав', 'Гелла'];
// The kind of a call, by the instruction it ends with.
export function kindOf(last: string): CallKind {
  if (last.startsWith('Придумай завязку')) return 'seed';
  if (last.includes('Составь лист внешности')) return 'sheet';
  if (last.includes('role — поле каждой записи people')) return 'variant';
  if (last.startsWith('Не продолжай историю. Опиши ПОСЛЕДНЮЮ сцену')) return 'frame';
  return 'scene';
}
// The named people of a seed where the set does not list them: every line that opens with a name and a dash, as the
// marker check's seed introduces its three.
export const castOf = (text: string) => [...text.matchAll(/^([А-ЯЁA-Z][^—\n]{0,40}?) — /gmu)].map(match => match[1].trim());

export type FakeStory = { id: string; title: string; theme?: string; cast?: string[] };
// The set as the fake tells its stories apart: a clean story by its title, with the cast the set gives it; a sharp one
// by its theme, with the four people the fake's own seed names; the marker check's by its title, its cast read from
// the seed, since its first name is drawn when the check runs.
export function fakeStories(): FakeStory[] {
  return [...ACTION_STORIES.map(story => ({ id: story.id, title: story.title, cast: story.cast })),
    ...SHARP_THEMES.map(theme => ({ id: theme.id, title: theme.theme, theme: theme.theme, cast: SHARP_CAST })),
    { id: MARKER_STORY.id, title: MARKER_STORY.title }];
}

type Body = { model: string; messages: { role: string; content: string }[]; max_tokens: number };
export type FakeGateway = { fetch: Fetch; calls: { story: string; kind: CallKind; fault?: Fault }[]; classes: Record<string, number> };

// A gateway of contract 2 as local/serving.ts reads it: the state, the models, the count and the stream with its usage,
// every request with the key. `stories` names each story by its title, which every message after its seed holds, or,
// for a sharp seed, its theme; `sharp` are the ids whose replies carry `marker`.
export function fakeGateway({ key, model = 'gemma-4-31b-heretic-nvfp4', stories = fakeStories(), sharp, marker, faults = {} }: {
  key: string; model?: string; stories?: FakeStory[]; sharp: string[]; marker: string; faults?: Faults;
}): FakeGateway {
  const calls: FakeGateway['calls'] = [];
  const classes: Record<string, number> = {};
  const seen = new Map<string, number>();
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${key}`) return json(401, { error: { code: 'unauthorized' } });
    if (path === '/v1/state') return json(200, { contract: '2', boot_id: 'fake-boot', status: 'ready', model, context_tokens: 65536, drain_generation: 0 });
    if (path === '/v1/models') return json(200, { object: 'list', data: [{ id: model, object: 'model', max_model_len: 65536 }] });
    const body = JSON.parse(String(init.body)) as Body;
    const work = headers.get('x-simple-serving-class') ?? 'none';
    classes[work] = (classes[work] ?? 0) + 1;
    if (path === '/v1/chat/completions/input_tokens') return json(200, { input_tokens: tokens(body.messages) });
    if (path !== '/v1/chat/completions') return json(404, { error: { code: 'not_found' } });
    const last = body.messages.at(-1)?.content ?? '';
    const kind = kindOf(last);
    const everything = body.messages.map(message => message.content).join('\n');
    const story = stories.find(one => kind === 'seed' ? one.theme && last.includes(`«${one.theme}»`) : everything.includes(one.title));
    const id = story?.id ?? 'unknown';
    const attempt = (seen.get(`${id}:${kind}`) ?? 0) + 1;
    seen.set(`${id}:${kind}`, attempt);
    const fault = faults[id]?.[kind];
    calls.push({ story: id, kind, ...(fault ? { fault } : {}) });
    const secret = sharp.includes(id) ? ` ${marker}` : '';
    if (fault === 'error') return json(500, { error: { code: 'internal_error', detail: `the engine failed on${secret}` } });
    const cast = story?.cast ?? castOf(body.messages.find(message => message.role === 'user')?.content ?? '');
    const people = cast.length ? cast : SHARP_CAST;
    let text: string;
    if ((fault === 'unparsed') || (fault === 'retry' && attempt === 1)) text = '{"moment": "the reply ran into newlines';
    else if (kind === 'seed') {
      text = JSON.stringify({ seed: [`Вечерняя история для взрослых. Все участники взрослые.`, `Старый дом у реки, знак${secret} над дверью.`,
        ...SHARP_CAST.map((name, at) => `${name} — ${['высокая', 'коренастый', 'сухощавый', 'полная'][at]}, взрослый человек, тёмные волосы.`),
        'Все четверо собираются в одной комнате.'].join('\n'), action: `Все четверо берутся за руки${secret}.` });
    } else if (kind === 'scene') {
      text = `${people.join(', ')} стоят рядом и держат друг друга за руки, как велит сцена${secret}.`;
    } else if (kind === 'sheet') {
      text = JSON.stringify({ characters: fault === 'empty_sheet' ? [] : people.slice(0, 6).map((name, at) => ({ name,
        look: `An adult of ${['slim', 'broad', 'tall', 'short', 'stocky', 'wiry'][at % 6]} build with ${['dark', 'fair', 'red', 'grey', 'black', 'brown'][at % 6]} hair${secret}`,
        outfit: `wearing a ${['blue', 'green', 'grey', 'brown', 'white', 'black'][at % 6]} tunic` })) });
    } else {
      const variant = kind === 'variant';
      text = JSON.stringify({ moment: `The participants hold each other${secret}`, shot: 'Medium wide shot at three quarters', setting: 'A plain room',
        objects: '', props: '', light: 'Evening light',
        people: people.slice(0, variant ? 6 : 4).map((name, at) => ({ who: name,
          ...(variant ? { role: fault === 'duplicate_roles' && at === 1 ? 'The Participant 1' : `the participant ${at + 1}`, facing: FACINGS[at % FACINGS.length] } : {}),
          look: '', clothes: `wearing a ${['blue', 'green', 'grey', 'brown', 'white', 'black'][at % 6]} tunic`, state: '',
          action: `holds the hand of the participant ${((at + 1) % people.length) + 1}` })) });
    }
    const finish = fault === 'truncated' ? 'length' : 'stop';
    const input = tokens(body.messages), output = Math.max(1, Math.ceil(Buffer.byteLength(text) / 4));
    const chunk = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
    const pieces = text.match(/[\s\S]{1,40}/g) ?? [''];
    const stream = [
      ...pieces.map((piece, at) => chunk({ model, choices: [{ index: 0, delta: { content: piece }, finish_reason: at === pieces.length - 1 ? finish : null }] })),
      chunk({ model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
        prompt_tokens_details: { cached_tokens: kind === 'scene' ? 0 : Math.floor(input / 2) }, simple_serving: { wait_ms: 1, first_token_ms: 4, total_ms: 9 } } }),
      'data: [DONE]\n\n'].join('');
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, calls, classes };
}
