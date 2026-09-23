// The look of a reader's pictures. The style is only ever the last sentence of the prompt (local/illustrate.ts
// `assemblePrompt`): the describing model never sees one, because step 1 of docs/illustrations-plan.md measured it
// picking a different style every time. The bot's own line — `SIMPLE_CHAT_IMAGE_STYLE`, or `STYLE` without it — is
// the standard one. A reader picks a preset or one of the styles of their own library, which holds at most
// OWN_STYLES_MAX of them; the choice and the library are kept as `pictureStyle` and `pictureStyles`
// (lib/library.ts). A button carries a style as its key: a preset's name, `standard`, or the id of an own style.
import type { Library, OwnStyle } from '../lib/library.ts';
import { STYLE } from './illustrate.ts';
import type { ErrorDetails } from './model-error.ts';

// What a picture's log row may say about its style: a word from a closed set, never the reader's own words.
export type StyleChoice = NonNullable<ErrorDetails['pictureStyle']>;
export type Preset = Exclude<StyleChoice, 'standard' | 'custom'>;

// The presets, in the order of the picker. Every line keeps what the owner judged the pictures by first — adult
// proportions and natural faces, since the big heads of the first run were the complaint — and asks for no
// lettering, which the image model fills with nonsense. `semi` is the line the owner approved on 2026-09-23,
// `novel` the one the six steps were measured with, `film` the photographic line tried the same evening.
export const PRESETS: Record<Preset, string> = {
  semi: 'Semi-realistic digital painting with cinematic lighting: realistic human anatomy and head-to-body proportions, natural faces with age-appropriate lines, painterly brushwork with soft visible strokes, rich but slightly muted colors, subtle painted texture instead of photographic detail. Clear silhouettes. No captions, logos or watermarks.',
  novel: STYLE,
  film: 'Photorealistic cinematic film still shot on 35mm, natural lens perspective. Real human anatomy and proportions: normal head-to-body ratio, natural skin texture, adult faces with age-appropriate lines. Realistic practical lighting, subtle film grain, shallow depth of field. No captions, logos or watermarks.',
  graphic: 'Graphic novel illustration with confident ink outlines, dramatic chiaroscuro shading and a limited muted palette with one accent color. Realistic adult anatomy and head-to-body proportions, natural faces with age-appropriate lines. Clear silhouettes. No captions, speech bubbles, logos or watermarks.',
  watercolor: 'Watercolor illustration with soft translucent washes, a loose pencil underdrawing and visible paper grain, gentle muted colors. Realistic adult anatomy and head-to-body proportions, natural faces with age-appropriate lines. Clear silhouettes. No captions, logos or watermarks.',
};
export const PRESET_KEYS = Object.keys(PRESETS) as Preset[];

// A reader's own style is a line of at most OWN_STYLE_CHARS characters under a name of at most OWN_NAME_CHARS, and a
// library keeps at most OWN_STYLES_MAX of them: a style is a sentence or two, the scene is carried by the description
// in front of it, and the picker stays one screen of buttons.
export const OWN_STYLE_CHARS = 400;
export const OWN_NAME_CHARS = 40;
export const OWN_STYLES_MAX = 10;
// Follows a reader's own line, which takes the place of everything a preset keeps: the people stay adults with
// natural proportions, and the picture stays free of lettering. Each of its sentences is added only when the line
// does not say it already, as a line copied from a preset's card does.
export const OWN_STYLE_TAIL = 'Adults with natural adult proportions and faces. No captions, logos or watermarks.';
const TAIL_PARTS = OWN_STYLE_TAIL.split(/(?<=\.) /);
// The id of an own style, as `id(state, 'y')` makes it (lib/library.ts).
export const OWN_STYLE_ID = /^y\d+$/;

// The preset a line is, if it is one. The bot's own line often is — `STYLE` is `novel`, and an owner may set a
// preset's line in `SIMPLE_CHAT_IMAGE_STYLE` — and then the picker has no standard button of its own, because the
// two buttons would draw the same picture.
export function presetOf(line: string | undefined): Preset | undefined {
  return PRESET_KEYS.find(key => PRESETS[key] === line);
}

// Every style of the picker, in its order: the bot's own line when it is not a preset, the presets, then the reader's
// own. A sample of all styles draws them in this order too (local/bot.ts).
export function pickerKeys(state: Partial<Library>, standard?: string): string[] {
  return [...(presetOf(standard) ? [] : ['standard']), ...PRESET_KEYS, ...ownStyles(state).map(style => style.id)];
}

// The reader's own styles, in the order they were made. Stored values are not trusted: an entry under a key that is
// not an id, or without a name or a line, is left out.
export function ownStyles(state: Partial<Library>): OwnStyle[] {
  const kept: unknown = state.pictureStyles;
  if (!kept || typeof kept !== 'object') return [];
  return Object.entries(kept as Record<string, Partial<OwnStyle> | null>).flatMap(([key, style]) =>
    OWN_STYLE_ID.test(key) && typeof style?.name === 'string' && style.name.trim() && typeof style.line === 'string' && style.line.trim()
      ? [{ id: key, name: style.name, line: style.line }] : []);
}

export function ownStyle(state: Partial<Library>, key: string): OwnStyle | undefined {
  return OWN_STYLE_ID.test(key) ? ownStyles(state).find(style => style.id === key) : undefined;
}

// Which style a library asks for, as the key its button carries: one of the reader's own, a preset, or else the
// standard one — the preset the bot's own line `standard` is, when it is one.
export function styleKey(state: Partial<Library>, standard?: string): string {
  const key = state.pictureStyle;
  if (typeof key === 'string' && (Object.hasOwn(PRESETS, key) || ownStyle(state, key))) return key;
  return presetOf(standard) ?? 'standard';
}

// A key as a word of the log (local/model-error.ts): every style of the reader's own is `custom`.
export function choiceOf(key: string): StyleChoice {
  return key === 'standard' || Object.hasOwn(PRESETS, key) ? key as StyleChoice : 'custom';
}

// Which style a library asks for, as a word of the log.
export function styleChoice(state: Partial<Library>, standard?: string): StyleChoice {
  return choiceOf(styleKey(state, standard));
}

// One line of what a reader sent, as it is kept: control and format characters become spaces, and a run of spaces
// one space.
function flat(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

// The whole line a key stands for, as it ends a prompt, or null for a key this library has no style under.
// `standard` is the bot's own line. A reader's own line is cut to the limit it was accepted under — a longer one
// came from somewhere other than the bot — and followed by the sentences of OWN_STYLE_TAIL it does not have.
export function lineOf(state: Partial<Library>, key: string, standard: string): string | null {
  if (key === 'standard') return standard;
  if (Object.hasOwn(PRESETS, key)) return PRESETS[key as Preset];
  const own = ownStyle(state, key);
  if (!own) return null;
  const line = [...flat(own.line)].slice(0, OWN_STYLE_CHARS).join('').trim();
  const missing = TAIL_PARTS.filter(part => !line.includes(part));
  return missing.length ? `${/[.!?]$/.test(line) ? line : line + '.'} ${missing.join(' ')}` : line;
}

// The last sentence of this reader's next prompt.
export function styleLine(state: Partial<Library>, standard: string): string {
  return lineOf(state, styleKey(state, standard), standard) ?? standard;
}

// What a reader sent as a style. With two lines or more the first is its name and the rest is the line; with one,
// there is no name and the caller makes one (`styleName`). The sentences the bot adds itself are taken off the end,
// so that the whole prompt copied from a card fits the limit again: `lineOf` puts them back. Null when no line is
// left.
export function ownStyleInput(text: string): { name: string | null; line: string } | null {
  const lines = text.split(/\r\n|[\n\r\u0085\u2028\u2029]/u).map(flat).filter(Boolean);
  if (!lines.length) return null;
  const [name, rest] = lines.length === 1 ? [null, lines] : [lines[0], lines.slice(1)];
  let line = rest.join(' ');
  for (let cut = true; cut;) {
    cut = false;
    for (const part of TAIL_PARTS) if (line.endsWith(part)) { line = line.slice(0, -part.length).trim(); cut = true; }
  }
  return line ? { name, line } : null;
}

// A name of at most OWN_NAME_CHARS characters: the reader's own, or the start of the line when they gave none, cut
// at a word where one is near.
export function styleName(text: string): string {
  const chars = [...flat(text)];
  if (chars.length <= OWN_NAME_CHARS) return chars.join('');
  const cut = chars.slice(0, OWN_NAME_CHARS - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= OWN_NAME_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
