// The gold tree of a walk: scenes the council accepted, growing from the seed as a tree, in the bot's own shape of a
// story (every node has a parent). A path from the root to a node is a prefix the model under test continues from;
// every accepted continuation, whoever wrote it, becomes a node. Nothing here runs a model.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Step, Verdict, CouncilRow, Contradiction } from './walk-panel.ts';

export type GoldNode = {
  parent: string | null; depth: number; step: string; input: string; text: string; author: string; attempts: number;
  // Who sat on the council that accepted the node, how many dissented in the first round, and whether a person has read it.
  approved: { at: string; judges: string[]; dissent: number }; read: boolean;
};
export type Rejected = { parent: string | null; step: string; text: string; author: string; at: string; findings: (Contradiction & { by: string })[] };
export type GoldTree = { scenario: string; seedHash: string; nodes: Record<string, GoldNode>; rejected: Rejected[] };
// One continuation to write: from a parent (null is the seed), with a step; a repair rewrites a rejected text without its findings.
export type Task = { parent: string | null; step: string; repair?: { text: string; findings: Contradiction[] } };

export const seedHash = (seed: string) => createHash('sha256').update(seed).digest('hex');
export const emptyGold = (scenario: string, seed: string): GoldTree => ({ scenario, seedHash: seedHash(seed), nodes: {}, rejected: [] });

export function loadGold(path: string, scenario: string, seed: string): GoldTree {
  if (!existsSync(path)) return emptyGold(scenario, seed);
  const tree = JSON.parse(readFileSync(path, 'utf8')) as GoldTree;
  // A tree grown from another seed, or from this seed before it was edited, is not this scenario's gold.
  if (tree.scenario !== scenario || tree.seedHash !== seedHash(seed)) throw new Error('Gold tree does not match the seed');
  return tree;
}
export const saveGold = (path: string, tree: GoldTree) => writeFileSync(path, JSON.stringify(tree, null, 2));

// The nodes from the root down to `id`, as the steps of a history for a judge.
export function pathOf(tree: GoldTree, id: string | null): (Step & { id: string })[] {
  const chain: (Step & { id: string })[] = [];
  for (let current = id; current; current = tree.nodes[current].parent) {
    const node = tree.nodes[current];
    if (!node) throw new Error('Unknown gold node');
    chain.unshift({ id: current, turn: node.depth, kind: node.step ? 'intervention' : 'continue', input: node.input, text: node.text });
  }
  return chain;
}

// The trunk: the one chain that follows the walk's steps from the seed, as far as it has been grown.
export function trunk(tree: GoldTree, steps: string[]): string[] {
  const chain: string[] = [];
  for (let parent: string | null = null, depth = 1; depth <= steps.length; depth++) {
    const id = Object.keys(tree.nodes).find(key => tree.nodes[key].parent === parent && tree.nodes[key].step === steps[depth - 1]);
    if (!id) break;
    chain.push(id); parent = id;
  }
  return chain;
}

export function addNode(tree: GoldTree, node: GoldNode): string {
  const id = `g${Object.keys(tree.nodes).length + 1}`;
  if (tree.nodes[id]) throw new Error('Gold id taken');
  tree.nodes[id] = node;
  return id;
}

// The gate to gold is stricter than the eval's majority: at most one dissenter in the first round, and after the
// council's second round nothing confirmed and nothing disputed. A disputed finding means "no" for gold.
export function gate(votes: Record<string, Verdict['verdict']>, row: Pick<CouncilRow, 'confirmed' | 'disputed'>): boolean {
  const cast = Object.values(votes).filter(v => v !== 'error');
  const dissent = cast.filter(v => v === 'inconsistent').length;
  return cast.length >= 2 && dissent <= 1 && row.confirmed === 0 && row.disputed === 0;
}

// The tasks of a per-step eval: from every trunk node (and the seed), the trunk's next step. A model is compared with
// another on the same prefixes, and its accepted scenes join the tree as branches.
export function trunkTasks(tree: GoldTree, steps: string[]): Task[] {
  const chain = trunk(tree, steps);
  return steps.slice(0, chain.length + 1).map((step, depth) => ({ parent: depth ? chain[depth - 1] : null, step }));
}

// Where a walk's gold lives: next to the built-in walk as `<name>.gold.json`, in a pack as `<name>/gold.json`; the
// human-readable rendering beside it as `.md`.
export const goldPaths = (root: string, name: string, pack?: string) => pack
  ? { tree: join(pack, name, 'gold.json'), story: join(pack, name, 'gold.md') }
  : { tree: join(root, 'examples', 'walk', `${name}.gold.json`), story: join(root, 'examples', 'walk', `${name}.gold.md`) };

// The tree as a story a person can read and check: the trunk in order, then every branch under its parent. A node
// nobody has read is marked so, because the council is made of models and this is the gold.
export function renderGold(tree: GoldTree, walk: { seed: string; steps: string[] }): string {
  const [title] = walk.seed.split('\n');
  const chain = trunk(tree, walk.steps);
  const heading = (id: string) => {
    const node = tree.nodes[id];
    const step = node.step ? `вмешательство: ${node.step}` : 'знак продолжать';
    const gate = `судей ${node.approved.judges.length}, против ${node.approved.dissent}, попытка ${node.attempts}`;
    return `### Сцена ${node.depth} · ${id}${node.parent ? ` (от ${node.parent})` : ''} · ${step}\n\n_${node.author} · ${gate} · ${node.read ? 'вычитано' : 'не вычитано'}_\n\n${node.text}\n`;
  };
  const branches = Object.keys(tree.nodes).filter(id => !chain.includes(id)).sort((a, b) => tree.nodes[a].depth - tree.nodes[b].depth || a.localeCompare(b));
  const rejected = tree.rejected.length ? `\n## Отклонённые попытки: ${tree.rejected.length}\n\n${tree.rejected.map(r => `- от ${r.parent ?? 'сида'}, шаг: ${r.step || 'знак продолжать'}, ${r.author}, ${r.at}: ${r.findings.length} находок, из них ${r.findings.map(f => f.kind).join(', ')}`).join('\n')}\n` : '';
  return `# ${title} · золотое дерево\n\nУзлов: ${Object.keys(tree.nodes).length}, ствол: ${chain.length} из ${walk.steps.length} шагов, ветвей: ${branches.length}. Сид: sha256 ${tree.seedHash.slice(0, 12)}.\n`
    + `Сцену принимает совет судей (не больше одного против в первом круге, ничего подтверждённого и спорного во втором); «не вычитано» — человек её ещё не читал.\n\n`
    + `## Сид\n\n${walk.seed}\n\n## Ствол\n\n${chain.map(heading).join('\n') || '_пусто_\n'}\n## Ветви\n\n${branches.map(heading).join('\n') || '_пока нет_\n'}${rejected}`;
}
