// Telegram status for one compaction job: a single message edited in place as the stage changes.
// Plain text only (no parse_mode). Shows real stage and elapsed time; never a percentage, ETA,
// memory text, fact preview, raw error or an unrecognised stage/reason value.

import type { InlineButton, Screen } from './telegram.ts';
import { texts } from './text.ts';
import type { Messages } from './text.ts';

// Stages and counters reported by generation.ts, plus `automatic` from the bot and `elapsedMs` from progress.ts.
// Fields are optional because the renderer also accepts partial or unexpected statuses.
export type CompactionStatus = {
  stage?: 'queued' | 'extracting' | 'validating' | 'saving' | 'done' | 'failed' | 'cancelled';
  automatic?: boolean; elapsedMs?: number; scenes?: number; keptScenes?: number;
  outputCharacters?: number; repairScenes?: number; facts?: number; reason?: string | number;
  // Calls ahead in the model queue while queued.
  ahead?: number;
};

const STEPS = ['queued', 'extracting', 'validating', 'saving'] as const;
type Step = typeof STEPS[number];
const isStep = (stage: unknown): stage is Step => (STEPS as readonly unknown[]).includes(stage);

// `lang` is the interface language stored in the user's library (text.ts decides what a missing one means).
export function renderCompaction(progress: CompactionStatus | null | undefined, lang?: unknown): Screen {
  const t = texts(lang);
  try {
    return view(t, progress && typeof progress === 'object' ? progress : {});
  } catch {
    return payload([t.compact.title, t.compact.failure], [[btn(t.buttons.context, 'view:context')]]);
  }
}

function view(t: Messages, p: CompactionStatus) {
  const c = t.compact;
  const b = t.buttons;
  const automatic = p.automatic === true;
  const elapsed = duration(t, p.elapsedMs);
  const scenes = whole(p.scenes);
  const kept = whole(p.keptScenes);
  const retry = c.retry(automatic ? '/continue' : '/compact');

  if (isStep(p.stage)) {
    const lines = [
      automatic ? c.titleAutomatic : c.title,
      c.now[p.stage],
      steps(t, p.stage),
      elapsed ? c.elapsed(elapsed) : null,
    ];
    const ahead = whole(p.ahead);
    if (p.stage === 'queued' && ahead != null && ahead > 0) lines.push(t.wait.ahead(ahead));
    if (scenes != null) lines.push(c.scope(scenes, kept));
    const repair = whole(p.repairScenes) ?? 0;
    if (repair > 0) lines.push(c.repair(repair));
    const chars = whole(p.outputCharacters);
    if (chars != null && chars > 0 && p.stage !== 'queued') lines.push(repair > 0 ? c.extraJson(chars) : c.memoryJson(chars));
    lines.push('', c.live);
    return payload(lines, [
      [btn(automatic ? c.cancelAutomatic : b.cancelCompaction, 'cancel')],
      [btn(b.context, 'view:context'), btn(b.model, 'view:model')],
    ]);
  }

  if (p.stage === 'done') {
    const facts = whole(p.facts);
    const repaired = whole(p.repairScenes) ?? 0;
    const lines = [
      c.done(elapsed),
      scenes != null && facts != null ? c.summary(scenes, facts) : scenes != null ? c.summaryScenes(scenes) : facts != null ? c.summaryFacts(facts) : null,
      repaired > 0 ? c.repaired(repaired) : null,
      c.kept(kept),
    ];
    if (automatic) lines.push('', c.continues);
    return payload(lines, [[btn(b.context, 'view:context'), btn(b.menu, 'view:home')]]);
  }

  if (p.stage === 'failed') {
    const reason = p.reason !== undefined && Object.hasOwn(c.reasons, p.reason) ? c.reasons[p.reason as keyof typeof c.reasons] : null;
    return payload([c.failed(elapsed), reason ? c.reason(reason) : null, c.safe, retry],
      [[btn(b.context, 'view:context'), btn(b.model, 'view:model')]]);
  }

  if (p.stage === 'cancelled') {
    return payload([c.cancelled(elapsed), c.safe, retry], [[btn(b.context, 'view:context'), btn(b.menu, 'view:home')]]);
  }

  // Unrecognised or missing stage: say nothing about progress and offer no cancel.
  return payload([c.title, c.unknown], [[btn(b.context, 'view:context'), btn(b.menu, 'view:home')]]);
}

function steps(t: Messages, stage: Step) {
  const current = STEPS.indexOf(stage);
  return STEPS.map((step, i) => `${i < current ? '✅' : i === current ? '⏳' : '▫️'} ${t.compact.steps[step]}`).join(' → ');
}

function duration(t: Messages, ms: unknown) {
  if (!known(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return t.duration.seconds(s);
  const m = Math.floor(s / 60);
  if (m < 60) return t.duration.minutes(m, String(s % 60).padStart(2, '0'));
  return t.duration.hours(Math.floor(m / 60), String(m % 60).padStart(2, '0'));
}

function known(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function whole(value: unknown) {
  return known(value) && value >= 0 ? Math.round(value) : null;
}

function btn(text: string, data: string): InlineButton {
  return { text, callback_data: data };
}

function payload(lines: (string | null)[], rows: (InlineButton | null)[][]): Screen {
  const text = lines.filter(line => line != null).join('\n').trim();
  return { text, reply_markup: { inline_keyboard: rows.map(row => row.filter(button => !!button)).filter(row => row.length) } };
}
