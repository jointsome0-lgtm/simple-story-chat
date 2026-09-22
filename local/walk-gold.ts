// The gold tree of a walk: scenes the council accepted, growing from the seed as a tree, in the bot's own shape of a
// story (every node has a parent). A path from the root to a node is a prefix the model under test continues from;
// every accepted continuation, whoever wrote it, becomes a node. Nothing here runs a model.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Step, Verdict, Check, Contradiction } from './walk-panel.ts';

// The ledger of a node, after the gate: a judge reading a deeper scene pointed back at it (`later`, with whether the
// finding stood after the cross round), the whole-story audit listed something in it (`audit`), or the council read
// it again (`recheck`). A scene every judge agreed to can still be the one at fault when a later scene is flagged
// against it and the finding is refuted, so the ledger keeps both outcomes for a person to read.
export type Review =
  | { kind: 'later'; at: string; by: string; depth: number; writer: string; confirmed: boolean | null; now: string; before: string }
  | { kind: 'audit'; at: string; by: string; issue: 'contradiction' | 'ambiguity'; quote: string; note: string }
  | { kind: 'recheck'; at: string; agreed: boolean; against: string[] };
// A node every judge agreed to is a candidate; it becomes gold by its ledger, with `promote`, and stays a candidate
// otherwise. `seen` counts the deeper scenes judged with the node in their prefix.
export type GoldNode = {
  parent: string | null; depth: number; step: string; input: string; text: string; author: string; attempts: number; reviews?: Review[];
  status?: 'candidate' | 'gold'; seen?: number;
  // Who sat on the council that agreed to the node, how many had listed findings in the first round before taking
  // them back, and whether a person has read it.
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

// A finding names where its earlier quote stands: "сцена 3" is the node at depth 3 of the path being judged, so the
// finding is noted on that node with the cross round's outcome; the seed and a step are not nodes.
export function noteLater(tree: GoldTree, path: string[], found: { by: string; where: string; now: string; before: string; number: number }[], checks: Record<string, Check[]>, depth: number, writer: string, at = new Date().toISOString()): number {
  let noted = 0;
  for (const f of found) {
    const scene = /сцен[аеыу]\s*№?\s*(\d+)/i.exec(f.where);
    const id = scene ? path[Number(scene[1]) - 1] : undefined;
    if (!id || !tree.nodes[id]) continue;
    const cast = Object.values(checks).flat().filter(c => c.turn === depth && c.finding === f.number);
    const confirmed = cast.length ? cast.some(c => c.confirmed) : null;
    (tree.nodes[id].reviews ??= []).push({ kind: 'later', at, by: f.by, depth, writer, confirmed, now: f.now.slice(0, 200), before: f.before.slice(0, 200) });
    noted++;
  }
  return noted;
}

// Every node on the path of a judged scene has been read once more with the scene against it.
export function noteSeen(tree: GoldTree, path: string[]) {
  for (const id of path) if (tree.nodes[id]) tree.nodes[id].seen = (tree.nodes[id].seen ?? 0) + 1;
}

// The rule of promotion: enough rechecks, all agreed; enough deeper scenes judged over the node with no later finding
// that stood; nothing from the audit. Reading by a person is recorded apart and is not part of the rule.
export type Rule = { rechecks: number; exposures: number };
export function promote(tree: GoldTree, rule: Rule): string[] {
  const promoted: string[] = [];
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (node.status === 'gold') continue;
    const reviews = node.reviews ?? [];
    const rechecks = reviews.filter(r => r.kind === 'recheck') as Extract<Review, { kind: 'recheck' }>[];
    const later = reviews.filter(r => r.kind === 'later') as Extract<Review, { kind: 'later' }>[];
    const ok = rechecks.length >= rule.rechecks && rechecks.every(r => r.agreed) && (node.seen ?? 0) >= rule.exposures
      && !later.some(r => r.confirmed !== false) && !reviews.some(r => r.kind === 'audit');
    if (ok) { node.status = 'gold'; promoted.push(id); }
  }
  return promoted;
}

// The ledger's numbers: how many agreed nodes were pointed at later, how many of those findings stood, which judges
// point late, and what the audit and the rechecks said.
export function stats(tree: GoldTree) {
  const nodes = Object.entries(tree.nodes);
  const later = (id: string) => (tree.nodes[id].reviews ?? []).filter(r => r.kind === 'later') as Extract<Review, { kind: 'later' }>[];
  const audit = (id: string) => (tree.nodes[id].reviews ?? []).filter(r => r.kind === 'audit') as Extract<Review, { kind: 'audit' }>[];
  const rechecks = (id: string) => (tree.nodes[id].reviews ?? []).filter(r => r.kind === 'recheck') as Extract<Review, { kind: 'recheck' }>[];
  const byJudge: Record<string, { later: number; confirmed: number; audit: number }> = {};
  for (const [id] of nodes) {
    for (const r of later(id)) { const j = byJudge[r.by] ??= { later: 0, confirmed: 0, audit: 0 }; j.later++; if (r.confirmed) j.confirmed++; }
    for (const r of audit(id)) { const j = byJudge[r.by] ??= { later: 0, confirmed: 0, audit: 0 }; j.audit++; }
  }
  return {
    nodes: nodes.length,
    pointedAtLater: nodes.filter(([id]) => later(id).length).length,
    laterFindings: nodes.reduce((n, [id]) => n + later(id).length, 0),
    laterConfirmed: nodes.reduce((n, [id]) => n + later(id).filter(r => r.confirmed).length, 0),
    laterRefuted: nodes.reduce((n, [id]) => n + later(id).filter(r => r.confirmed === false).length, 0),
    audited: nodes.filter(([id]) => audit(id).length).length,
    auditIssues: nodes.reduce((n, [id]) => n + audit(id).length, 0),
    rechecked: nodes.filter(([id]) => rechecks(id).length).length,
    recheckAgreed: nodes.filter(([id]) => rechecks(id).length && rechecks(id).every(r => r.agreed)).length,
    read: nodes.filter(([, n]) => n.read).length,
    gold: nodes.filter(([, n]) => n.status === 'gold').length,
    byJudge,
    perNode: Object.fromEntries(nodes.map(([id, n]) => [id, { status: n.status ?? 'candidate', seen: n.seen ?? 0, later: later(id).length, confirmed: later(id).filter(r => r.confirmed).length, refuted: later(id).filter(r => r.confirmed === false).length, audit: audit(id).length, rechecks: rechecks(id).length, agreedAgain: rechecks(id).filter(r => r.agreed).length }])),
  };
}

export function addNode(tree: GoldTree, node: GoldNode): string {
  const id = `g${Object.keys(tree.nodes).length + 1}`;
  if (tree.nodes[id]) throw new Error('Gold id taken');
  tree.nodes[id] = node;
  return id;
}

// The gate to gold is the agreement of every judge, not the eval's majority. Without findings a judge agrees by its
// first-round verdict; with findings the second round decides, and a judge agrees when it confirms none of them, its
// own included, which it may take back. A judge with no verdict, or with no checks when there were findings, does not
// agree: nobody is overruled and nobody is presumed.
export function agree(votes: Record<string, Verdict['verdict']>, checksByJudge: Record<string, Check[]>, turn: number, found: number): { agreed: boolean; against: string[] } {
  const against = Object.keys(votes).filter(judge => {
    const checks = (checksByJudge[judge] ?? []).filter(c => c.turn === turn);
    return found ? checks.length !== found || checks.some(c => c.confirmed) : votes[judge] !== 'consistent';
  });
  return { agreed: Object.keys(votes).length > 0 && !against.length, against };
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
    const s = stats(tree).perNode[id];
    const ledger = [s.later ? `позже указывали ${s.later} (устояло ${s.confirmed}, снято ${s.refuted})` : '', s.audit ? `аудит: ${s.audit}` : '', s.rechecks ? `перепроверок ${s.rechecks}, согласны снова ${s.agreedAgain}` : ''].filter(Boolean).join(' · ');
    return `### Сцена ${node.depth} · ${id}${node.parent ? ` (от ${node.parent})` : ''} · ${step}\n\n_${node.status === 'gold' ? 'золото' : 'кандидат'} · ${node.author} · ${gate} · над ним прочитано ${node.seen ?? 0}${ledger ? ` · ${ledger}` : ''} · ${node.read ? 'вычитано' : 'не вычитано'}_\n\n${node.text}\n`;
  };
  const branches = Object.keys(tree.nodes).filter(id => !chain.includes(id)).sort((a, b) => tree.nodes[a].depth - tree.nodes[b].depth || a.localeCompare(b));
  const rejected = tree.rejected.length ? `\n## Отклонённые попытки: ${tree.rejected.length}\n\n${tree.rejected.map(r => `- от ${r.parent ?? 'сида'}, шаг: ${r.step || 'знак продолжать'}, ${r.author}, ${r.at}: ${r.findings.length} находок, из них ${r.findings.map(f => f.kind).join(', ')}`).join('\n')}\n` : '';
  const s = stats(tree);
  const judgeLines = Object.entries(s.byJudge).map(([judge, j]) => `- ${judge}: позже указывал ${j.later} раз (устояло ${j.confirmed}), в аудите ${j.audit}`).join('\n');
  const ledger = `\n## Согласования\n\nУзлов ${s.nodes}, из них золото ${s.gold}, кандидатов ${s.nodes - s.gold}; на ${s.pointedAtLater} позже указывали судьи при чтении более глубоких сцен (${s.laterFindings} находок, устояло ${s.laterConfirmed}, снято ${s.laterRefuted}); аудит всей истории отметил ${s.auditIssues} мест в ${s.audited} узлах; перепроверено ${s.rechecked}, из них согласны снова ${s.recheckAgreed}; вычитано ${s.read}.\n${judgeLines ? `\n${judgeLines}\n` : ''}`;
  return `# ${title} · золотое дерево\n\nУзлов: ${Object.keys(tree.nodes).length}, ствол: ${chain.length} из ${walk.steps.length} шагов, ветвей: ${branches.length}. Сид: sha256 ${tree.seedHash.slice(0, 12)}.\n`
    + `Сцена входит в дерево кандидатом, только когда с ней согласны все судьи: без находок в первом круге или после того, как во втором круге никто не подтвердил ни одной находки, своей в том числе. Золотом кандидат становится по журналу: перепроверки с согласием, более глубокие сцены, прочитанные над ним без устоявших находок, чистый аудит всей истории. «Не вычитано» — человек её ещё не читал.\n\n`
    + `## Сид\n\n${walk.seed}\n\n## Ствол\n\n${chain.map(heading).join('\n') || '_пусто_\n'}\n## Ветви\n\n${branches.map(heading).join('\n') || '_пока нет_\n'}${rejected}${ledger}`;
}
