// A branch of a story as a text file for its reader: the scenes of its line in order, each under the move that led to it,
// as the reader wrote it. A move the reader handed to the narrator has no words of theirs to show. The seed stays out: a
// file is the story as it was read. Pure text: no model, no picture, nothing but the reader's own library.
import { history } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import { narratorsMove } from './context.ts';
import { texts } from './text.ts';

export function storyFile(state: Library, storyId: string, branchId: string) {
  const t = texts(state.language);
  const story = state.stories[storyId];
  const branch = story.branches[branchId];
  const scenes = history(story, branch.head);
  const parts = scenes.map((node, index) => [`${t.labels.scene(index + 1)}`,
    ...narratorsMove(state, storyId, node) ? [] : [node.input.split('\n').map(line => `> ${line}`).join('\n')], node.text].join('\n\n'));
  // Letters, digits and spaces alone, for any system the file lands on and any client that shows its name.
  const safe = (value: string) => value.replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { name: `${[safe(story.title), safe(branch.name)].filter(Boolean).join(' - ') || 'story'}.txt`,
    text: `${[`${story.title}\n${branch.name}`, ...parts].join('\n\n\n')}\n`, caption: `📖 ${story.title} · 🌿 ${branch.name}`.slice(0, 1000), scenes: scenes.length };
}
