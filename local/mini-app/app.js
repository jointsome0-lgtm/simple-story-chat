'use strict';
// The Mini App's page (local/mini-app.ts, docs/telegram-ui.md#mini-app): a reader's stories, a story's characters and
// one person's card. Every question to the server carries the launch data Telegram signed, which the page keeps in
// memory alone, as Telegram's script gives it. Text from the server goes in as text, never as markup.
const app = window.Telegram?.WebApp;
const lines = JSON.parse(document.getElementById('lines').textContent);
const view = document.getElementById('view');
const zoom = document.getElementById('zoom');
// The screens down to the list of stories, which Telegram's Back button returns along, and a count that drops the
// answer to a screen already left.
const stack = [];
let shown = 0;
let picture = null;
let lang = pick(app?.initDataUnsafe?.user?.language_code || navigator.language);

// As the bot picks a language from Telegram's (local/text.ts `langFromTelegram`), until the server names the reader's own.
function pick(code) {
  const primary = String(code || '').toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(lines, primary) ? primary : 'en';
}
const say = key => lines[lang][key];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class Refusal extends Error {}

// A 401 means the launch data is missing, forged or over an hour old, which only reopening the page mends; a 404, that
// the item is gone or not this reader's.
async function api(path) {
  let response;
  try {
    response = await fetch(`/api/${path.map(encodeURIComponent).join('/')}`,
      { headers: { authorization: `tma ${app.initData}` }, cache: 'no-store', credentials: 'omit' });
  } catch { throw new Refusal('failed'); }
  if (response.status === 401) throw new Refusal('expired');
  if (response.status === 404) throw new Refusal('notFound');
  if (!response.ok) throw new Refusal('failed');
  return response;
}

async function answer(path) {
  const data = await (await api(path)).json();
  lang = pick(data.lang);
  document.documentElement.lang = lang;
  document.title = data.title;
  return data;
}

function go(route) {
  stack.at(-1).scroll = window.scrollY;
  stack.push(route);
  show();
}

function back() {
  if (!zoom.hidden) return closeZoom();
  if (stack.length > 1) stack.pop();
  show();
}

async function show() {
  const route = stack.at(-1);
  const turn = ++shown;
  closeZoom();
  if (picture) URL.revokeObjectURL(picture);
  picture = null;
  if (stack.length > 1) app.BackButton.show(); else app.BackButton.hide();
  view.replaceChildren(element('p', 'hint', '…'));
  let parts;
  try { parts = await screen(route, turn); } catch (error) {
    if (turn !== shown) return;
    const reason = error instanceof Refusal ? error.message : 'failed';
    const retry = element('button', 'refresh', say('refresh'));
    retry.type = 'button';
    retry.addEventListener('click', show);
    view.replaceChildren(element('p', 'notice', say(reason)), ...reason === 'failed' ? [retry] : []);
    return;
  }
  if (turn !== shown) return;
  view.replaceChildren(...parts);
  window.scrollTo(0, route.scroll ?? 0);
}

async function screen(route, turn) {
  if (route.screen === 'stories') {
    const data = await answer(['stories']);
    return [element('h1', '', data.title), data.stories.length
      ? list(data.stories, story => [story.name, story.note], story => ({ screen: 'characters', story: story.id }))
      : element('p', 'hint', data.none)];
  }
  if (route.screen === 'characters') {
    const data = await answer(['stories', route.story, 'people']);
    return [element('h1', '', data.title), data.people.length
      ? list(data.people, one => [`${one.pov ? '👁' : '👤'} ${one.name}`, one.look],
        one => ({ screen: 'card', story: route.story, index: String(one.index), tag: one.tag }))
      : element('p', 'hint', data.none)];
  }
  const path = ['stories', route.story, 'people', route.index, route.tag];
  const data = await answer(path);
  const parts = [element('h1', '', data.title)];
  if (data.picture) parts.push(portrait([...path, 'picture'], data.picture, data.name, turn));
  for (const block of data.blocks) {
    if (block.heading) parts.push(element('h2', '', block.heading));
    if (block.text) parts.push(copyable(block.text));
    for (const note of block.notes) parts.push(element('p', 'hint', note));
  }
  return parts;
}

function list(items, label, open) {
  const node = element('ul', 'list');
  for (const item of items) {
    const [name, note] = label(item);
    const entry = element('button', 'item');
    entry.type = 'button';
    entry.append(element('span', 'name', name));
    if (note) entry.append(element('span', 'note', note));
    entry.addEventListener('click', () => go(open(item)));
    const row = element('li');
    row.append(entry);
    node.append(row);
  }
  return node;
}

// The picture full width, in the place its size keeps for it while it loads, and whole on a tap.
function portrait(path, size, name, turn) {
  const frame = element('button', 'picture');
  frame.type = 'button';
  if (size.width && size.height) frame.style.aspectRatio = `${size.width} / ${size.height}`;
  const image = element('img');
  image.alt = name;
  frame.append(image);
  api(path).then(response => response.blob()).then(blob => {
    if (turn !== shown) return;
    picture = URL.createObjectURL(blob);
    image.src = picture;
    frame.addEventListener('click', openZoom);
  }).catch(error => {
    if (turn === shown) frame.replaceWith(element('p', 'hint', say(error instanceof Refusal ? error.message : 'failed')));
  });
  return frame;
}

function openZoom() {
  zoom.firstElementChild.src = picture;
  zoom.hidden = false;
  app.BackButton.show();
}

function closeZoom() {
  if (zoom.hidden) return;
  zoom.hidden = true;
  zoom.firstElementChild.removeAttribute('src');
  if (stack.length < 2) app.BackButton.hide();
}

// Text the chat lets one copy with a tap is copied here with a tap too, where the client allows it, and can be selected
// where it does not.
function copyable(text) {
  const node = element('pre', 'text', text);
  node.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    app.HapticFeedback?.notificationOccurred('success');
    node.classList.add('copied');
    setTimeout(() => node.classList.remove('copied'), 700);
  });
  return node;
}

zoom.addEventListener('click', closeZoom);
document.documentElement.lang = lang;
if (!app?.initData) view.replaceChildren(element('p', 'notice', say('outside')));
else {
  app.ready();
  app.expand();
  app.BackButton.onClick(back);
  // The characters' list in the chat opens the page at its story, with the list of stories under it.
  const story = new URLSearchParams(location.search).get('story');
  stack.push({ screen: 'stories' });
  if (/^h\d{1,9}$/.test(story ?? '')) stack.push({ screen: 'characters', story });
  show();
}
