// Shared story domain. lib/library.js is emitted from lib/library.ts by `npm run cloud:lib`; edit only the TypeScript file.
const LABELS = { firstBranch: 'Начало', seedCheckpoint: 'Сид', forkBranch: from => `От ${from}`, forkCheckpoint: 'Точка развилки', afterCompaction: 'После сжатия' };
// `key` names the message for a caller that shows it in another language; the message itself stays Russian.
export class UserError extends Error {
    constructor(message, key) { super(message); this.key = key; }
}
export function emptyLibrary() {
    return { version: 1, seq: 0, seeds: {}, stories: {}, active: null, job: null, ui: null, seen: [] };
}
export function setLanguage(state, language) {
    state.language = language;
}
export function id(state, prefix) {
    state.seq += 1;
    return prefix + state.seq;
}
export function validTime(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
    if (!match)
        return false;
    const [, y, m, d, h, min] = match.map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && h < 24 && min < 60;
}
export function addSeed(state, text) {
    const [title, startTime, ...body] = text.trim().split('\n');
    if (!title || title.length > 100 || !validTime(startTime?.trim() ?? '') || !body.join('\n').trim()) {
        throw new UserError('Нужны название (до 100 знаков), дата в формате 2026-08-02 20:00 и описание мира, каждое с новой строки.', 'seedFormat');
    }
    const seed = { id: id(state, 's'), title, startTime: startTime.trim(), text: body.join('\n').trim() };
    state.seeds[seed.id] = seed;
    return seed;
}
export function newStory(state, seedId, labels = LABELS) {
    const seed = state.seeds[seedId];
    if (!seed)
        throw new UserError('Сид уже удалён.', 'seedGone');
    const story = { id: id(state, 'h'), seedId, title: seed.title, branches: {}, checkpoints: {}, nodes: {}, memories: {} };
    const branch = { id: id(state, 'b'), name: labels.firstBranch, head: null, memory: null };
    story.branches[branch.id] = branch;
    state.stories[story.id] = story;
    state.active = { storyId: story.id, branchId: branch.id };
    saveCheckpoint(state, story, branch, labels.seedCheckpoint, 'start');
    return { story, branch };
}
export function active(state) {
    const story = state.stories[state.active?.storyId];
    const branch = story?.branches[state.active?.branchId];
    if (!branch)
        throw new UserError('Выбери ветку истории через /seeds.', 'pickBranch');
    return { story, branch, seed: state.seeds[story.seedId] };
}
export function saveCheckpoint(state, story, branch, label = 'Пауза', kind = 'manual') {
    const cp = { id: id(state, 'c'), branchId: branch.id, label: label.slice(0, 100), kind, head: branch.head, memory: branch.memory };
    story.checkpoints[cp.id] = cp;
    return cp;
}
export function fork(state, storyId, checkpointId, labels = LABELS) {
    const story = state.stories[storyId];
    const cp = story?.checkpoints[checkpointId];
    if (!cp)
        throw new UserError('Чекпоинт уже удалён.', 'checkpointGone');
    const branch = { id: id(state, 'b'), name: labels.forkBranch(cp.label), head: cp.head, memory: cp.memory };
    story.branches[branch.id] = branch;
    state.active = { storyId, branchId: branch.id };
    saveCheckpoint(state, story, branch, labels.forkCheckpoint, 'fork');
    return branch;
}
export function history(story, head) {
    const nodes = [];
    while (head) {
        const node = story.nodes[head];
        if (!node)
            throw new Error('Broken history reference');
        nodes.push(node);
        head = node.parent;
    }
    return nodes.reverse();
}
export function memoryChain(story, memory) {
    const versions = [];
    while (memory) {
        const version = story.memories[memory];
        if (!version)
            throw new Error('Broken memory reference');
        versions.push(version);
        memory = version.parent;
    }
    return versions.reverse();
}
export function context(story, branch) {
    const all = history(story, branch.head);
    const memories = memoryChain(story, branch.memory);
    const cutoff = memories.at(-1)?.cutoff;
    const index = cutoff ? all.findIndex(n => n.id === cutoff) : -1;
    if (cutoff && index < 0)
        throw new Error('Memory belongs to another timeline');
    return { memories, recent: all.slice(index + 1) };
}
export function beginJob(state, input, now) {
    if (state.job)
        throw new UserError('Продолжение уже готовится. /cancel отменит его, если запрос завис.', 'jobRunning');
    const { story, branch } = active(state);
    const job = { id: id(state, 'j'), storyId: story.id, branchId: branch.id, head: branch.head, memory: branch.memory, input, started: now };
    state.job = job;
    return job;
}
export function jobTarget(state, jobId) {
    const job = state.job;
    if (job?.id !== jobId)
        return null;
    const story = state.stories[job.storyId];
    const branch = story?.branches[job.branchId];
    if (!branch || branch.head !== job.head || branch.memory !== job.memory)
        return null;
    return { job, story, branch, seed: state.seeds[story.seedId] };
}
export function commitMemory(state, jobId, covered, delta, label = LABELS.afterCompaction) {
    const target = jobTarget(state, jobId);
    if (!target)
        return false;
    const { story, branch, job } = target;
    const recent = context(story, branch).recent;
    if (!covered.length || covered.some((n, i) => recent[i]?.id !== n))
        throw new Error('Invalid compaction range');
    const memory = { id: id(state, 'm'), parent: branch.memory, cutoff: covered.at(-1), covered, delta };
    story.memories[memory.id] = memory;
    branch.memory = memory.id;
    job.memory = memory.id;
    saveCheckpoint(state, story, branch, label, 'compaction');
    return true;
}
export function commitTurn(state, jobId, text, truncated = false) {
    const target = jobTarget(state, jobId);
    if (!target)
        return null;
    const { story, branch, job } = target;
    const time = text.split('\n')[0].trim();
    if (!validTime(time))
        throw new UserError('Модель не указала корректные дату и время. Ответ не записан; отправь продолжение ещё раз.', 'sceneTime');
    const node = { id: id(state, 'n'), parent: branch.head, input: job.input, text, time, truncated, delivery: 'pending' };
    story.nodes[node.id] = node;
    branch.head = node.id;
    state.job = null;
    return { storyId: story.id, branchId: branch.id, nodeId: node.id };
}
function collect(story) {
    const nodeIds = new Set();
    const memoryIds = new Set();
    for (const ref of [...Object.values(story.branches), ...Object.values(story.checkpoints)]) {
        for (const node of history(story, ref.head))
            nodeIds.add(node.id);
        for (const memory of memoryChain(story, ref.memory))
            memoryIds.add(memory.id);
    }
    for (const key of Object.keys(story.nodes))
        if (!nodeIds.has(key))
            delete story.nodes[key];
    for (const key of Object.keys(story.memories))
        if (!memoryIds.has(key))
            delete story.memories[key];
}
export function deleteBranch(state, storyId, branchId) {
    const story = state.stories[storyId];
    if (!story?.branches[branchId])
        throw new UserError('Ветка уже удалена.', 'branchGone');
    delete story.branches[branchId];
    for (const cp of Object.values(story.checkpoints))
        if (cp.branchId === branchId)
            delete story.checkpoints[cp.id];
    collect(story);
    if (!Object.keys(story.branches).length)
        delete state.stories[storyId];
    if (state.active?.storyId === storyId && state.active.branchId === branchId)
        state.active = null;
    if (state.job?.storyId === storyId && state.job.branchId === branchId)
        state.job = null;
    state.ui = null;
}
export function deleteSeed(state, seedId) {
    if (!state.seeds[seedId])
        throw new UserError('Сид уже удалён.', 'seedGone');
    for (const story of Object.values(state.stories)) {
        if (story.seedId !== seedId)
            continue;
        if (state.active?.storyId === story.id)
            state.active = null;
        if (state.job?.storyId === story.id)
            state.job = null;
        delete state.stories[story.id];
    }
    delete state.seeds[seedId];
    state.ui = null;
}
// Telegram lets a bot delete a message of its own for 48 hours after sending it and never later (Bot API
// `deleteMessage`). A record older than that can no longer be used, so every write of the list drops it.
export const MESSAGE_DELETABLE_MS = 48 * 60 * 60 * 1000;
// A backstop: the library is read and written whole on every update, and the 48 hours alone do not bound the list.
// A thousand pictures is some five hours of the picture card drawing without a pause.
export const SENT_PICTURES_MAX = 1000;
// Records a picture the moment it is sent, beside the others that may still be deleted, newest last.
export function recordPicture(state, picture) {
    const deletable = (state.sentPictures ?? []).filter(one => picture.at - one.at < MESSAGE_DELETABLE_MS);
    state.sentPictures = [...deletable, picture].slice(-SENT_PICTURES_MAX);
}
// After a deletion: forgets the pictures whose story or scene is gone and returns their messages, for the caller to
// delete from the chat. A record too old to be deleted is dropped and not returned.
export function forgetLostPictures(state, now) {
    if (!state.sentPictures)
        return [];
    const lost = [];
    state.sentPictures = state.sentPictures.filter(picture => {
        if (now - picture.at >= MESSAGE_DELETABLE_MS)
            return false;
        if (state.stories[picture.storyId]?.nodes[picture.nodeId])
            return true;
        lost.push(picture.messageId);
        return false;
    });
    return lost;
}
