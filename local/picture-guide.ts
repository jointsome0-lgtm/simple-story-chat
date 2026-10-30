// The recipe of a story seen through a person's eyes, the owner's «поставить при режиме на пов B + guide + cfg=2 +
// step=33» of 2026-10-30: the lean frame (local/picture-lean.ts), its prompt as `guided` rewrites it, CFG 2 and 33
// steps with the negative left empty, the stand's arm `qwen-guide-cfg2-steps33`. It is measured on Qwen-Image alone, so
// another graph draws the lean frame by its own settings and its prompt as it stands (local/picture.ts `guides`).
import { matchSheet } from './illustrate.ts';
import type { LeanDescription } from './picture-lean.ts';

export const POV_RECIPE = 'pov-guide-v1', POV_CFG = 2, POV_STEPS = 33;

// The prompt as the system prompts of Qwen-Image 2.1's prompt enhancers on Hugging Face ask a prompt to be written
// (read on 2026-10-29), in four changes and no other. Each image is named by the tag the text encoder puts before it,
// `<image1>` where the bot writes "image 1". An age is a stage of life, never a number: "a young woman of eighteen" is a
// young adult woman, and one who "looks about twenty-seven" looks to be in her late twenties. By the owner's «Наверное
// да» of 2026-10-30 so is an age below eighteen, though only after a person's noun, or after "looks" where the age ends
// its clause, since "about fifteen" is as often metres as years: a little girl of seven is a little girl, a boy of
// fifteen a teenage boy, and one who looks about ten looks like a child. The shot, the first sentence after the reference
// rule, comes again last as the composition. And a person the answer gives no face in a shot from behind has it turned
// away from the camera, as the guide asks a face turned away to be said. A prompt with references but without the
// rule's last words, with an age of eighteen or more in number words left after "of", "aged", "about", "around" or
// "roughly" ("aged twenty-seven"), or with a younger one left after "aged" ("aged fourteen") is not rewritten, and the
// stand skipped such a frame: the bot does not draw it either (local/picture.ts `drawFrame`).
const RULE_END = 'never from the images. ';
const UNITS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const YEARS = `(eighteen|nineteen|(?:${TENS.join('|')})(?:[- ](?:${UNITS.join('|')}))?)`;
// Below eighteen: a child's ages and a teenager's, with "and a half" and "years old" taken in, never the first word of
// "one hundred", "two million" or "nine months".
const KIDS = [...UNITS, 'ten', 'eleven', 'twelve'];
const TEENS = ['thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen'];
const YOUNG = `(${[...KIDS, ...TEENS].join('|')})\\b(?![- ](?:hundred|thousand|million|billion|trillion|months?|weeks?|days?)\\b)(?: and a half)?(?:[- ]years?(?:[- ]old)?)?`;
const yearsOf = (words: string) => {
  const [ten, unit] = words.toLowerCase().split(/[- ]/);
  return KIDS.includes(ten) ? KIDS.indexOf(ten) + 1 : TEENS.includes(ten) ? TEENS.indexOf(ten) + 13 : ten === 'eighteen' ? 18
    : ten === 'nineteen' ? 19 : (TENS.indexOf(ten) + 2) * 10 + (unit ? UNITS.indexOf(unit) + 1 : 0);
};
const ownOf = (noun = '') => /^(?:woman|girl|lady)$/i.test(noun) ? 'her' : /^(?:man|boy)$/i.test(noun) ? 'his' : 'their';
// "a teenage girl", "a little boy": an age below eighteen as the words for the person it is of.
const youngOf = (years: number, noun: string) =>
  (years < 13 ? { her: 'little girl', his: 'little boy', their: 'child' } : { her: 'teenage girl', his: 'teenage boy', their: 'teenager' })[ownOf(noun)];
// "her late twenties": the decade of an age and where in it.
const decadeOf = (years: number, noun?: string) =>
  `${ownOf(noun)} ${years % 10 < 4 ? 'early ' : years % 10 < 7 ? 'mid-' : 'late '}${TENS[Math.floor(years / 10) - 2].replace(/y$/, 'ies')}`;
// The last word for a person in the sentence before `at`, which an age said after it is of.
const nounBefore = (text: string, at: number) => [...text.slice(text.lastIndexOf('. ', at) + 1, at).matchAll(/\b(woman|girl|lady|man|boy)\b/gi)].at(-1)?.[1];
const BEHIND = /\bfrom behind\b|\bfrom the back\b|\b(?:back|rear) view\b|\bbehind (?:him|her|them)\b|\bbacks? (?:is |are )?(?:turned )?to(?:ward)? the camera\b|\bover[- ](?:the|his|her|their|\S+'s)[- ]shoulder\b/i;
// `bound` are the portraits `prompt` was assembled with, none for a prompt without. The viewer of a frame through their
// eyes is already out of `description.people` (local/picture-lean.ts `leanSeen`).
export function guided(description: LeanDescription, prompt: string, bound: { name: string }[]): { prompt: string } | { code: 'rule_not_found' | 'age_left' } {
  if (bound.length && !prompt.includes(RULE_END)) return { code: 'rule_not_found' };
  const aged = prompt
    // The words before the noun that the age would repeat go with it: "a little girl of seven" is one little girl.
    .replace(new RegExp(`\\b(?:(?:young|little|small|teenage)\\s+)?(woman|man|girl|boy|lady|person|child|kid) of ${YOUNG}`, 'gi'),
      (_, noun: string, words: string) => youngOf(yearsOf(words), noun))
    .replace(new RegExp(`\\blooks (?:about |around |roughly )?${YOUNG}(?=\\s*(?:[,.;:!?)]|$))`, 'gi'),
      (_, words: string) => yearsOf(words) < 13 ? 'looks like a child' : 'looks like a teenager')
    .replace(new RegExp(`\\b(young\\s+)?(woman|man|girl|boy|person) of ${YEARS}\\b`, 'gi'), (_, young: string | undefined, noun: string, words: string) => {
      const years = yearsOf(words);
      return years < 20 ? `young adult ${noun}` : `${young ?? ''}${noun} in ${decadeOf(years, noun)}`;
    })
    .replace(new RegExp(`\\blooks (?:about |around |roughly )?${YEARS}\\b`, 'gi'), (_, words: string, at: number, whole: string) => {
      const years = yearsOf(words);
      return years < 20 ? 'looks like a young adult' : `looks to be in ${decadeOf(years, nounBefore(whole, at))}`;
    });
  if (new RegExp(`\\b(?:of|aged|about|around|roughly) ${YEARS}\\b|\\baged ${YOUNG}`, 'i').test(aged)) return { code: 'age_left' };
  const body = bound.length ? aged.slice(aged.indexOf(RULE_END) + RULE_END.length) : aged;
  const shot = body.split('. ')[0].trim().replace(/\.$/, '');
  const names = bound.map(one => one.name);
  const turned = !BEHIND.test(description.ownShot ?? description.shot ?? '') ? [] : description.people
    .filter(one => !one.face.trim() && !one.onScreen && !one.blurred)
    .map(one => names.indexOf(matchSheet(one.who, names) ?? ''))
    .map(slot => slot >= 0 ? `The person from image ${slot + 1}` : 'The person seen from behind');
  const said = [...new Set(turned)].map(label => `${label} has their face turned away from the camera. `).join('');
  return { prompt: `${aged.trimEnd()} ${said}Composition: ${shot.charAt(0).toLowerCase()}${shot.slice(1)}.`.replace(/\bfrom image (\d)\b/g, 'from <image$1>') };
}
