// A blind comparison of the pictures several checkpoints drew for the same scenes
// (docs/illustrations-plan.md#blind-review). `build` takes run directories of local/image-batch.ts and writes, for
// one rater, either a page a person opens in a browser or a bundle a clean model session reads. Neither names a
// checkpoint: pictures get names that say nothing, the order under the letters is shuffled for every scene and
// differently for every rater, and the key is written beside the output, never inside it. `score` opens the key and
// counts. Only synthetic scenes are drawn here.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

// What this tool reads from a run directory: `index.json` and `prompts.json` of local/image-batch.ts.
type Drawn = { caseId: string; checkpoint: string; seed: number; file: string; arm?: string; width?: number; height?: number };
type Scene = { id: string; scene: string };
export type Entry = Drawn & { run: string };
// One question: the same scene and seed drawn by different checkpoints, in the order the rater sees them.
export type Question = { id: string; caseId: string; seed: number; scene: string; pictures: { letter: string; name: string }[] };
export type Key = { rater: string; questions: { id: string; letters: Record<string, string> }[] };
// `best` is a letter, 'none' (no picture fits the scene) or 'same'. `contradicts` lists letters whose picture shows
// something the scene denies.
export type Answer = { id: string; best: string; contradicts?: string[]; note?: string };
export type Answers = { rater: string; answers: Answer[] };

const LETTERS = 'ABCDEFGH';

// mulberry32: the same seed always deals the same page, so a lost page can be rebuilt against its key.
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], next: () => number) {
  const out = [...items];
  for (let at = out.length - 1; at > 0; at--) {
    const other = Math.floor(next() * (at + 1));
    [out[at], out[other]] = [out[other], out[at]];
  }
  return out;
}

// What competes in a question: a checkpoint, and in an identity run a checkpoint in one arm. The arms of one frame
// share their checkpoint, and keyed by it alone all but the first of them were dropped as repeats.
const contender = (entry: Entry) => entry.arm ? `${entry.checkpoint}#${entry.arm}` : entry.checkpoint;

// A scene drawn by one checkpoint only is no comparison and is left out, and so is one whose pictures were drawn on
// canvases of different sizes: a rater shown a wide picture beside a narrower one has been told which run is which,
// and a frame drawn around a reference of its own size is not the frame drawn without one
// (docs/identity-experiment.md#geometry). `mixed` counts those. A rater's name goes into the seed, so two raters
// never share an order, and into the picture names, so their files cannot be matched by name either.
export function deal(entries: Entry[], scenes: Scene[], rater: string, seed: number) {
  const next = random(seed ^ parseInt(createHash('sha256').update(rater).digest('hex').slice(0, 8), 16));
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const id = `${entry.caseId}#${entry.seed}`;
    const group = groups.get(id) ?? [];
    if (!group.some(other => contender(other) === contender(entry))) group.push(entry);
    groups.set(id, group);
  }
  const questions: (Question & { sources: Entry[] })[] = [];
  let mixed = 0;
  for (const [id, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2 || group.length > LETTERS.length) continue;
    if (new Set(group.map(entry => `${entry.width}x${entry.height}`)).size > 1) { mixed++; continue; }
    const order = shuffled(group.sort((a, b) => contender(a).localeCompare(contender(b))), next);
    questions.push({
      id, caseId: order[0].caseId, seed: order[0].seed, scene: scenes.find(scene => scene.id === order[0].caseId)?.scene ?? '',
      pictures: order.map((entry, at) => ({ letter: LETTERS[at],
        name: createHash('sha256').update(`${rater}|${seed}|${id}|${contender(entry)}`).digest('hex').slice(0, 16) + '.png' })),
      sources: order,
    });
  }
  const dealt = shuffled(questions, next);
  return {
    questions: dealt.map(({ sources, ...question }) => question),
    key: { rater, questions: dealt.map(question => ({ id: question.id,
      letters: Object.fromEntries(question.sources.map((entry, at) => [LETTERS[at], contender(entry)])) })) } satisfies Key,
    files: dealt.flatMap(question => question.sources.map((entry, at) => ({ from: join(entry.run, entry.file), name: question.pictures[at].name }))),
    mixed,
  };
}

// Counts what the raters chose, by checkpoint. With two raters it also says how often they agree, on the questions
// both answered: that number is what tells whether the model rater can stand in for the person later.
export function score(raters: { key: Key; answers: Answers }[]) {
  const chosen = raters.map(({ key, answers }) => {
    const letters = new Map(key.questions.map(question => [question.id, question.letters]));
    const picks = new Map<string, string>();
    const wins: Record<string, number> = {};
    const contradictions: Record<string, number> = {};
    let none = 0, same = 0, answered = 0;
    for (const answer of answers.answers) {
      const map = letters.get(answer.id);
      if (!map) continue;
      for (const checkpoint of Object.values(map)) { wins[checkpoint] ??= 0; contradictions[checkpoint] ??= 0; }
      for (const letter of answer.contradicts ?? []) if (map[letter]) contradictions[map[letter]]++;
      const pick = answer.best === 'none' || answer.best === 'same' ? answer.best : map[answer.best];
      if (!pick) continue;
      answered++;
      picks.set(answer.id, pick);
      if (pick === 'none') none++; else if (pick === 'same') same++; else wins[pick]++;
    }
    return { rater: answers.rater, answered, none, same, wins, contradictions, picks };
  });
  const [first, second] = chosen;
  const shared = second ? [...first.picks.keys()].filter(id => second.picks.has(id)) : [];
  const agreed = shared.filter(id => first.picks.get(id) === second.picks.get(id)).length;
  return {
    raters: chosen.map(({ picks, ...rest }) => rest),
    agreement: second ? { shared: shared.length, agreed, rate: shared.length ? Math.round(agreed / shared.length * 1000) / 1000 : null } : null,
  };
}

// The page holds its data inline and its pictures beside it, so it opens from a file with no server. Answers live in
// the browser's own storage until they are downloaded; nothing leaves the computer.
export function page(rater: string, questions: Question[]) {
  const data = JSON.stringify({ rater, questions }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Слепое сравнение картинок</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #16181d; color: #e6e6e6; }
  header { position: sticky; top: 0; background: #16181d; border-bottom: 1px solid #333; padding: 10px 20px; display: flex; gap: 16px; align-items: center; z-index: 1; }
  main { max-width: 1500px; margin: 0 auto; padding: 20px; }
  .scene { white-space: pre-wrap; background: #1f2229; border-radius: 8px; padding: 14px 18px; max-height: 40vh; overflow: auto; }
  .pictures { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; margin: 16px 0; }
  figure { margin: 0; background: #1f2229; border-radius: 8px; padding: 10px; border: 2px solid transparent; }
  figure.best { border-color: #5aa469; }
  figure img { width: 100%; border-radius: 4px; cursor: zoom-in; display: block; }
  figcaption { display: flex; gap: 14px; align-items: center; padding-top: 8px; font-weight: 600; }
  figcaption label { font-weight: 400; }
  button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid #555; background: #2a2e37; color: inherit; cursor: pointer; }
  button.on { background: #35507a; border-color: #6b93cf; }
  button:disabled { opacity: .4; cursor: default; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  textarea { width: 100%; box-sizing: border-box; min-height: 56px; background: #1f2229; color: inherit; border: 1px solid #444; border-radius: 6px; padding: 8px; font: inherit; }
  #zoom { position: fixed; inset: 0; background: #000d; display: none; align-items: center; justify-content: center; z-index: 2; cursor: zoom-out; }
  #zoom img { max-width: 98vw; max-height: 98vh; }
</style></head><body>
<header><strong id="where"></strong><span id="done"></span><span style="flex:1"></span>
  <button id="prev">← Назад</button><button id="next">Дальше →</button><button id="save">Скачать ответы</button></header>
<main>
  <p>Сначала прочитай сцену, потом выбери картинку, которая лучше к ней подходит. Какая модель что нарисовала, страница не знает.</p>
  <div class="scene" id="scene"></div>
  <div class="pictures" id="pictures"></div>
  <div class="row" id="choices"></div>
  <p><textarea id="note" placeholder="Заметка, если есть что сказать (необязательно)"></textarea></p>
</main>
<div id="zoom"><img alt=""></div>
<script>
const DATA = ${data};
const STORE = 'blind-review:' + DATA.rater + ':' + DATA.questions.map(q => q.id).join(',').length + ':' + DATA.questions[0]?.pictures[0]?.name;
const answers = JSON.parse(localStorage.getItem(STORE) || '{}');
let at = Math.max(0, DATA.questions.findIndex(q => !answers[q.id]?.best));
const $ = id => document.getElementById(id);
const keep = () => localStorage.setItem(STORE, JSON.stringify(answers));
function show() {
  const q = DATA.questions[at], a = answers[q.id] ??= { best: '', contradicts: [], note: '' };
  $('where').textContent = 'Сцена ' + (at + 1) + ' из ' + DATA.questions.length;
  $('done').textContent = 'отвечено: ' + DATA.questions.filter(x => answers[x.id]?.best).length;
  $('scene').textContent = q.scene; $('scene').scrollTop = 0;
  $('pictures').replaceChildren(...q.pictures.map(p => {
    const figure = document.createElement('figure'); if (a.best === p.letter) figure.className = 'best';
    const img = document.createElement('img'); img.src = 'img/' + p.name; img.alt = p.letter;
    img.onclick = () => { $('zoom').firstChild.src = img.src; $('zoom').style.display = 'flex'; };
    const caption = document.createElement('figcaption'); caption.append(p.letter);
    const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox';
    box.checked = a.contradicts.includes(p.letter);
    box.onchange = () => { a.contradicts = box.checked ? [...a.contradicts, p.letter] : a.contradicts.filter(l => l !== p.letter); keep(); };
    label.append(box, ' противоречит сцене'); caption.append(label); figure.append(img, caption); return figure;
  }));
  const options = [...q.pictures.map(p => [p.letter, 'Лучше ' + p.letter]), ['same', 'Одинаково'], ['none', 'Ни одна не годится']];
  $('choices').replaceChildren(...options.map(([value, text]) => {
    const button = document.createElement('button'); button.textContent = text; if (a.best === value) button.className = 'on';
    button.onclick = () => { a.best = value; keep(); show(); }; return button;
  }));
  $('note').value = a.note || ''; $('note').oninput = () => { a.note = $('note').value; keep(); };
  $('prev').disabled = at === 0; $('next').disabled = at === DATA.questions.length - 1;
}
$('prev').onclick = () => { at--; show(); }; $('next').onclick = () => { at++; show(); };
$('zoom').onclick = () => { $('zoom').style.display = 'none'; };
document.onkeydown = event => {
  if (event.target === $('note')) return;
  if (event.key === 'ArrowRight' && at < DATA.questions.length - 1) { at++; show(); }
  if (event.key === 'ArrowLeft' && at > 0) { at--; show(); }
  if (event.key === 'Escape') $('zoom').style.display = 'none';
};
$('save').onclick = () => {
  const out = { rater: DATA.rater, answers: DATA.questions.filter(q => answers[q.id]?.best).map(q => ({ id: q.id, ...answers[q.id] })) };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  link.download = 'answers-' + DATA.rater + '.json'; link.click();
};
show();
</script></body></html>
`;
}

// The same questions for a clean model session: it answers in the page's own format, so one `score` reads both.
export function task(count: number) {
  return `Ты сравниваешь иллюстрации к сценам интерактивной истории. Весь материал синтетический; читай и смотри всё. Песочница только для чтения.

В \`questions.json\` ${count} вопросов. В каждом: \`scene\` — русский текст сцены, \`pictures\` — картинки к ней под буквами (файлы в \`img/\`). Картинки одного вопроса нарисованы разными моделями по одному и тому же описанию; какая буква какая модель, неизвестно и от вопроса к вопросу меняется.

На каждый вопрос: прочитай сцену, посмотри картинки, реши, какая лучше подходит именно к этой сцене — читатель только что прочитал текст и видит картинку под ним. Противоречие сцене (не та рука ранена, открыта дверь, которую держат закрытой, предмет не у того человека, сцена смягчена или подменена: убрана кровь, изменён сюжет) весит больше, чем красота. Пропуск детали — не противоречие.

Ответ — ТОЛЬКО JSON, последним сообщением, без пояснений вокруг:
{"rater": "astra", "answers": [{"id": "<id вопроса>", "best": "<буква | same | none>", "contradicts": ["<буквы картинок, которые противоречат сцене>"], "note": "<одна фраза: главная причина выбора>"}]}
\`none\` — ни одна картинка не годится как иллюстрация этой сцены. \`same\` — разницы нет. Ответь на все вопросы.
`;
}

function build(values: { run: string; out: string; rater: string; seed: string; only?: string; exclude?: string; bundle: boolean }) {
  const runs = values.run.split(',').map(run => resolve(run));
  const scenes = new Map<string, Scene>();
  const entries: Entry[] = [];
  for (const run of runs) {
    for (const scene of JSON.parse(readFileSync(join(run, 'prompts.json'), 'utf8')) as Scene[]) scenes.set(scene.id, scene);
    for (const picture of (JSON.parse(readFileSync(join(run, 'index.json'), 'utf8')).pictures ?? []) as Drawn[]) entries.push({ ...picture, run });
  }
  const only = values.only?.split(','), exclude = values.exclude?.split(',') ?? [];
  const wanted = entries.filter(entry => (!only || only.includes(entry.caseId)) && !exclude.includes(entry.caseId));
  const dealt = deal(wanted, [...scenes.values()], values.rater, Number(values.seed));
  if (!dealt.questions.length) {
    throw new Error(dealt.mixed ? `Every scene drawn twice was drawn on two canvases (${dealt.mixed}), and those are no comparison` : 'No scene was drawn by two checkpoints');
  }
  const out = resolve(values.out);
  mkdirSync(join(out, 'img'), { recursive: true, mode: 0o700 });
  for (const file of dealt.files) copyFileSync(file.from, join(out, 'img', file.name));
  if (values.bundle) {
    writeFileSync(join(out, 'questions.json'), JSON.stringify(dealt.questions, null, 2), { mode: 0o600 });
    writeFileSync(join(out, 'TASK.md'), task(dealt.questions.length), { mode: 0o600 });
  } else writeFileSync(join(out, 'review.html'), page(values.rater, dealt.questions), { mode: 0o600 });
  // Beside the output, not in it: whoever is handed the directory is handed no key.
  const keyPath = join(dirname(out), `${basename(out)}.key.json`);
  writeFileSync(keyPath, JSON.stringify(dealt.key, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'blind_review_built', rater: values.rater, questions: dealt.questions.length, pictures: dealt.files.length,
    leftOutForCanvas: dealt.mixed, open: values.bundle ? join(out, 'TASK.md') : join(out, 'review.html'), key: keyPath }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'build') {
    const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, out: { type: 'string' }, rater: { type: 'string', default: 'owner' },
      seed: { type: 'string', default: '1' }, only: { type: 'string' }, exclude: { type: 'string' }, bundle: { type: 'boolean', default: false } } });
    if (!values.run || !values.out) throw new Error('Use: blind-review.ts build --run <run>[,<run>] --out <directory> [--rater owner] [--bundle] [--exclude <caseId,…>]');
    build(values as Parameters<typeof build>[0]);
  } else if (command === 'score') {
    // --rater <answers.json>:<key.json>, once or twice.
    const { values } = parseArgs({ args: rest, options: { rater: { type: 'string', multiple: true } } });
    const raters = (values.rater ?? []).map(pair => {
      const [answers, key] = pair.split(':');
      return { answers: JSON.parse(readFileSync(answers, 'utf8')) as Answers, key: JSON.parse(readFileSync(key, 'utf8')) as Key };
    });
    if (!raters.length || raters.length > 2) throw new Error('Use: blind-review.ts score --rater <answers.json>:<key.json> [--rater …]');
    console.log(JSON.stringify(score(raters), null, 2));
  } else throw new Error('Use: blind-review.ts build|score');
}
