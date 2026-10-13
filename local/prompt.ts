import { context, validTime } from '../lib/library.ts';
import type { Library, MemoryVersion, Point } from '../lib/library.ts';
import type { ChatMessage, ModelRequest } from './model.ts';
import { seedNarration } from './story-text.ts';
import type { Narration } from './story-text.ts';

export type StoryPoint = Point & { storyId: string };

// The story's language comes from its seed, not from the interface language of the user (text.ts): the narrator and
// the memory speak the language the story is written in.
export function storyNarration(state: Library, storyId: string): Narration {
  const story = state.stories[storyId];
  return seedNarration(state.seeds[story.seedId]);
}

// JSON remains the stored source of truth. Rendering never asks a model to
// retell it, reorder events or infer a new state; source IDs remain traceable.
function memoryText(n: Narration, memory: MemoryVersion, index: number) {
  return n.increment(index + 1, memory.covered.join(', ')) + '\n'
    + memory.delta.facts.map(fact => {
      const label = n.factLabels[fact.kind as keyof Narration['factLabels']] ?? fact.kind ?? n.otherFact;
      const time = fact.at ? `[${fact.at}] ` : '';
      const source = fact.source?.length ? n.sources(fact.source.join(', ')) : '';
      return `${time}${label}: ${fact.text}${source}`;
    }).join('\n');
}

export function contextParts(state: Library, point: StoryPoint): {
  seed: ChatMessage[]; memory: ChatMessage[]; tail: ChatMessage[]; memoryCount: number; sceneCount: number;
} {
  const story = state.stories[point.storyId];
  const seed = state.seeds[story.seedId];
  const n = seedNarration(seed);
  const { memories, recent } = context(story, point);
  return {
    seed: [{ role: 'user', content: n.seed(seed.title, seed.startTime, seed.text) }],
    memory: memories.length ? [{ role: 'user', content: n.memoryHeader + '\n' + memories.map((memory, index) => memoryText(n, memory, index)).join('\n\n') }] : [],
    tail: recent.flatMap(node => [{ role: 'user', content: node.input }, { role: 'assistant', content: node.text }]),
    memoryCount: memories.length, sceneCount: recent.length,
  };
}

// The narrator's rule stands after the author's message, not in the system prompt. Measured on the GPU model
// (docs/knowledge/improve-runs.md#narrator-rule-2026-09-19): in SYSTEM, before thousands of tokens of story, it
// changed nothing, and at the end of the request the narrator stopped accepting a false claim about the past. Being
// last, it also leaves the cached prefix of the request untouched.
export function makeRequest(state: Library, job: StoryPoint & { input: string }, maxOutputTokens: number): ModelRequest {
  const parts = contextParts(state, job);
  const story = state.stories[job.storyId];
  const n = storyNarration(state, job.storyId);
  // A null head (no scenes yet) is never a node id, so the seed start time is used.
  const referenceTime = story.nodes[job.head as string]?.time ?? state.seeds[story.seedId].startTime;
  const messages: ChatMessage[] = [
    ...parts.seed, ...parts.memory, ...parts.tail,
    { role: 'user', content: `${n.lastMessage(referenceTime, job.input)}\n\n${n.narratorRule}` },
  ];
  return { system: n.system, messages, maxOutputTokens };
}

export function normalizeScene(text: string, fallbackTime: string) {
  let value = text.trim();
  const lines = value.split('\n');
  const first = lines[0].replace(/^[#*\s]+|[*\s]+$/g, '');
  if (validTime(first)) { lines[0] = first; value = lines.join('\n'); }
  else value = `${fallbackTime}\n\n${value}`;
  if (!text.trim()) throw new Error('Empty model response');
  return value;
}
