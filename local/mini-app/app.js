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
let pictureCached = false;
let requests = new AbortController();
let pictureClickAfter = 0;
// A few originals live only in this open gallery's memory, never in browser storage or the HTTP cache.
const referencePictures = new Map();
const CACHED_PICTURES = 5;
const CACHED_BYTES = 32 * 1024 * 1024;
let referenceScope = '';
let selectedPicture = '';
let lang = pick(app?.initDataUnsafe?.user?.language_code || navigator.language);
const galleryLines = {
  ru: { title: 'Референсы', empty: 'В наборе пока нет картинок.', main: 'Основной для варианта', ready: 'Размечено', pending: 'Ожидает разметки',
    failed: 'Авторазметка не получена', previous: 'Назад', next: 'Дальше', page: 'Страница', pose: 'Поза', side: 'Ракурс', framing: 'Кадрирование',
    specificPose: 'Вариант позы', poseDetails: 'Детали позы', expression: 'Выражение лица', faceVisibility: 'Видимость лица',
    visible: 'Видно', partial: 'Частично', hidden: 'Не видно', given: 'Метки читателя', caption: 'Разметка', confidence: 'Уверенность', open: 'Открыть картинку' },
  en: { title: 'References', empty: 'No pictures in this set yet.', main: 'Preferred for variant', ready: 'Labeled', pending: 'Awaiting labels',
    failed: 'Automatic labeling failed', previous: 'Previous', next: 'Next', page: 'Page', pose: 'Pose', side: 'View', framing: 'Framing',
    specificPose: 'Pose variant', poseDetails: 'Pose details', expression: 'Expression', faceVisibility: 'Face visibility',
    visible: 'Visible', partial: 'Partial', hidden: 'Hidden', given: 'Reader labels', caption: 'Labels', confidence: 'Confidence', open: 'Open picture' },
  ja: { title: '参照画像', empty: '画像はまだありません。', main: 'このバリエーションの優先画像', ready: '分類済み', pending: '分類待ち',
    failed: '自動分類に失敗', previous: '前へ', next: '次へ', page: 'ページ', pose: 'ポーズ', side: '向き', framing: '構図',
    specificPose: 'ポーズの種類', poseDetails: 'ポーズの詳細', expression: '表情', faceVisibility: '顔の見え方',
    visible: '見える', partial: '一部', hidden: '見えない', given: '読者のラベル', caption: 'ラベル', confidence: '確信度', open: '画像を開く' },
  ko: { title: '참조 이미지', empty: '아직 이미지가 없습니다.', main: '이 변형의 우선 이미지', ready: '분류됨', pending: '분류 대기',
    failed: '자동 분류 실패', previous: '이전', next: '다음', page: '페이지', pose: '자세', side: '방향', framing: '구도',
    specificPose: '자세 유형', poseDetails: '자세 상세', expression: '표정', faceVisibility: '얼굴 노출',
    visible: '보임', partial: '일부', hidden: '가림', given: '독자 지정', caption: '분류', confidence: '확신도', open: '이미지 열기' },
  zh: { title: '参考图', empty: '暂无图片。', main: '该变体的首选图', ready: '已标注', pending: '等待标注',
    failed: '自动标注失败', previous: '上一页', next: '下一页', page: '页', pose: '姿势', side: '视角', framing: '构图',
    specificPose: '姿势变体', poseDetails: '姿势细节', expression: '表情', faceVisibility: '面部可见度',
    visible: '可见', partial: '部分', hidden: '不可见', given: '读者标注', caption: '标注', confidence: '置信度', open: '打开图片' },
};
const galleryText = key => (galleryLines[lang] || galleryLines.en)[key];
const swipeLines = {
  ru: { hint: 'Листайте картинки влево и вправо', previous: 'Предыдущий референс', next: 'Следующий референс', description: 'Описание' },
  en: { hint: 'Swipe left or right to browse', previous: 'Previous reference', next: 'Next reference', description: 'Description' },
  ja: { hint: '左右にスワイプして画像を切り替えます', previous: '前の参照画像', next: '次の参照画像', description: '説明' },
  ko: { hint: '좌우로 밀어 이미지를 넘겨 보세요', previous: '이전 참조 이미지', next: '다음 참조 이미지', description: '설명' },
  zh: { hint: '左右滑动切换图片', previous: '上一张参考图', next: '下一张参考图', description: '说明' },
};
const swipeText = key => (swipeLines[lang] || swipeLines.en)[key];
const galleryLabels = {
  ru: {
    pose: { standing: 'Стоя', sitting: 'Сидя', walking: 'Идёт', lying: 'Лёжа', kneeling: 'На коленях', crouching: 'Присев', all_fours: 'На четвереньках' },
    side: { front: 'Спереди', 'three-quarter left': 'Вполоборота влево', 'three-quarter right': 'Вполоборота вправо',
      'profile left': 'Профиль влево', 'profile right': 'Профиль вправо', back: 'Спиной' },
    framing: { 'full body': 'В полный рост', 'half body': 'По пояс', 'head and shoulders': 'Голова и плечи' },
  },
  en: {
    pose: { standing: 'Standing', sitting: 'Sitting', walking: 'Walking', lying: 'Lying down', kneeling: 'Kneeling', crouching: 'Crouching', all_fours: 'On all fours' },
    side: { front: 'Front', 'three-quarter left': 'Three-quarter left', 'three-quarter right': 'Three-quarter right',
      'profile left': 'Left profile', 'profile right': 'Right profile', back: 'Back' },
    framing: { 'full body': 'Full body', 'half body': 'Waist up', 'head and shoulders': 'Head and shoulders' },
  },
  ja: {
    pose: { standing: '立つ', sitting: '座る', walking: '歩く', lying: '横になる', kneeling: '膝をつく', crouching: 'しゃがむ', all_fours: '四つん這い' },
    side: { front: '正面', 'three-quarter left': '斜め左向き', 'three-quarter right': '斜め右向き',
      'profile left': '左向きの横姿', 'profile right': '右向きの横姿', back: '後ろ姿' },
    framing: { 'full body': '全身', 'half body': '腰から上', 'head and shoulders': '頭と肩' },
  },
  ko: {
    pose: { standing: '서 있음', sitting: '앉아 있음', walking: '걷기', lying: '누워 있음', kneeling: '무릎 꿇기', crouching: '쪼그려 앉기', all_fours: '네발 자세' },
    side: { front: '정면', 'three-quarter left': '왼쪽 사선', 'three-quarter right': '오른쪽 사선',
      'profile left': '왼쪽 옆모습', 'profile right': '오른쪽 옆모습', back: '뒷모습' },
    framing: { 'full body': '전신', 'half body': '허리 위', 'head and shoulders': '머리와 어깨' },
  },
  zh: {
    pose: { standing: '站立', sitting: '坐姿', walking: '行走', lying: '躺卧', kneeling: '跪姿', crouching: '蹲姿', all_fours: '四肢着地' },
    side: { front: '正面', 'three-quarter left': '左斜侧面', 'three-quarter right': '右斜侧面',
      'profile left': '左侧面', 'profile right': '右侧面', back: '背面' },
    framing: { 'full body': '全身', 'half body': '腰部以上', 'head and shoulders': '头部和肩部' },
  },
};
function referenceLabel(field, value) {
  const labels = (galleryLabels[lang] || galleryLabels.en)[field];
  return labels && Object.hasOwn(labels, value) ? labels[value] : value;
}

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
async function api(path, page, signal = requests.signal) {
  let response;
  try {
    response = await fetch(`/api/${path.map(encodeURIComponent).join('/')}${page === undefined ? '' : `?page=${page}`}`,
      { headers: { authorization: `tma ${app.initData}` }, cache: 'no-store', credentials: 'omit', signal });
  } catch { throw new Refusal('failed'); }
  if (response.status === 401) throw new Refusal('expired');
  if (response.status === 404) throw new Refusal('notFound');
  if (!response.ok) throw new Refusal('failed');
  return response;
}

function dropReferencePicture(key) {
  const item = referencePictures.get(key);
  if (!item) return;
  item.controller.abort();
  if (item.url) URL.revokeObjectURL(item.url);
  referencePictures.delete(key);
}

function clearReferencePictures() {
  for (const key of referencePictures.keys()) dropReferencePicture(key);
  selectedPicture = '';
}

function trimReferencePictures() {
  let bytes = [...referencePictures.values()].reduce((total, item) => total + item.bytes, 0);
  for (const [key, item] of referencePictures) {
    if (referencePictures.size <= CACHED_PICTURES && bytes <= CACHED_BYTES) break;
    if (key === selectedPicture) continue;
    bytes -= item.bytes;
    dropReferencePicture(key);
  }
}

async function referencePicture(path, selected = false) {
  // Cached bytes must not extend the signed launch's one-hour lifetime.
  const authDate = Number(new URLSearchParams(app.initData).get('auth_date'));
  if (!authDate || Date.now() > (authDate + 3600) * 1000) {
    clearReferencePictures();
    throw new Refusal('expired');
  }
  const key = path.join('/');
  if (selected) {
    selectedPicture = key;
    // Keep an in-flight preload when it becomes selected. Cancel other downloads so the visible image comes first.
    for (const [other, item] of referencePictures) if (other !== key && !item.url) dropReferencePicture(other);
  }
  const kept = referencePictures.get(key);
  if (kept) {
    referencePictures.delete(key);
    referencePictures.set(key, kept);
    return kept.promise;
  }
  const item = { controller: new AbortController(), bytes: 0, url: null, promise: null };
  referencePictures.set(key, item);
  trimReferencePictures();
  item.promise = api(path, undefined, item.controller.signal).then(response => response.blob()).then(blob => {
    if (item.controller.signal.aborted || referencePictures.get(key) !== item) throw new Refusal('failed');
    // The authenticated picture endpoint serves at most 10 MiB. Bound retained bytes independently here too.
    if (blob.size > 10 * 1024 * 1024) throw new Refusal('failed');
    item.bytes = blob.size;
    trimReferencePictures();
    item.url = URL.createObjectURL(blob);
    return item.url;
  }).catch(error => {
    if (referencePictures.get(key) === item) dropReferencePicture(key);
    if (error instanceof Refusal && error.message === 'expired') clearReferencePictures();
    throw error;
  });
  return item.promise;
}

async function answer(path, page) {
  const data = await (await api(path, page)).json();
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
  requests.abort();
  requests = new AbortController();
  closeZoom();
  if (picture && !pictureCached) URL.revokeObjectURL(picture);
  picture = null;
  pictureCached = false;
  const scope = route.screen === 'reference' ? [route.story, route.index, route.tag].join('/') : '';
  if (scope !== referenceScope) {
    clearReferencePictures();
    referenceScope = scope;
  }
  if (stack.length > 1) app.BackButton.show(); else app.BackButton.hide();
  view.replaceChildren(element('p', 'hint', '…'));
  let parts;
  try { parts = await screen(route, turn); } catch (error) {
    if (turn !== shown) return;
    clearReferencePictures();
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
  if (route.focusPicture) {
    route.focusPicture = false;
    view.querySelector('.reference-image')?.focus({ preventScroll: true });
  }
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
  if (route.screen === 'references') {
    const data = await answer([...path, 'references'], route.page ?? 0);
    const parts = [element('h1', '', data.title), element('p', 'hint', `${data.total} · ${galleryText('page')} ${data.page + 1} / ${data.pages}`)];
    parts.push(data.references.length ? list(data.references, one => [referenceTitle(one),
      [galleryText(one.status), one.specificPose, ...['pose', 'side', 'framing']
        .map(field => referenceLabel(field, (one.caption || one.given || {})[field]))].filter(Boolean).join(' · ')],
    one => ({ ...route, screen: 'reference', item: one, gallery: data, scroll: 0 })) : element('p', 'hint', galleryText('empty')));
    const pages = element('nav', 'pages');
    for (const [key, page] of [['previous', data.page - 1], ['next', data.page + 1]]) {
      const button = element('button', 'refresh', galleryText(key));
      button.type = 'button';
      button.disabled = page < 0 || page >= data.pages;
      button.addEventListener('click', () => { route.page = page; route.scroll = 0; show(); });
      pages.append(button);
    }
    if (data.pages > 1) parts.push(pages);
    return parts;
  }
  if (route.screen === 'reference') {
    return referenceScreen(route, path, turn);
  }
  const data = await answer(path);
  const parts = [element('h1', '', data.title)];
  if (data.picture) parts.push(portrait([...path, 'picture'], data.picture, data.name, turn));
  if (data.references) {
    const button = element('button', 'refresh references', `${galleryText('title')} · ${data.references}`);
    button.type = 'button';
    button.addEventListener('click', () => go({ ...route, screen: 'references', page: 0, scroll: 0 }));
    parts.push(button);
  }
  for (const block of data.blocks) {
    if (block.heading) parts.push(element('h2', '', block.heading));
    if (block.text) parts.push(copyable(block.text));
    for (const note of block.notes) parts.push(element('p', 'hint', note));
  }
  return parts;
}

async function referenceScreen(route, path, turn) {
  // Keep the current and adjacent page's metadata. A swipe replaces this screen, never adds another Back step.
  const data = route.gallery || await answer([...path, 'references'], route.page ?? 0);
  if (turn !== shown) return [];
  route.gallery = data;
  route.page = data.page;
  const one = route.item || data.references.at(route.edge === 'last' ? -1 : 0);
  if (!one) {
    clearReferencePictures();
    return [element('h1', '', data.title), element('p', 'hint', galleryText('empty'))];
  }
  route.item = one;
  const parent = stack.at(-2);
  if (parent?.screen === 'references' && parent.page !== data.page) {
    parent.page = data.page;
    parent.scroll = 0;
  }
  const move = (direction, focusPicture = false) => {
    if (turn !== shown || !zoom.hidden) return;
    const index = data.references.findIndex(item => item.id === one.id);
    const next = data.references[index + direction];
    const page = data.page + direction;
    if (!next && (page < 0 || page >= data.pages)) return;
    route.item = next;
    route.gallery = next ? data : route.neighbor?.page === page ? route.neighbor : null;
    if (!next) route.neighbor = data;
    route.page = next ? data.page : page;
    route.edge = direction > 0 ? 'first' : 'last';
    route.direction = direction;
    route.scroll = 0;
    route.focusPicture = focusPicture;
    show();
  };
  document.title = `${data.name} · ${referenceTitle(one)}`;
  const figure = element('figure', 'reference-viewer');
  const stage = element('div', 'reference-stage');
  const frame = portrait([...path, 'references', one.id, 'picture'], one, data.name, turn,
    () => preloadReference(route, path, data, one, turn));
  frame.classList.add('reference-image');
  swipe(frame, move);
  stage.append(frame);
  const controls = element('nav', 'reference-controls');
  controls.setAttribute('aria-label', galleryText('title'));
  const counter = element('p', 'hint reference-counter', `${one.number} / ${data.total}`);
  counter.setAttribute('role', 'status');
  for (const [key, direction, symbol, disabled] of [
    ['previous', -1, '←', one.number <= 1], ['next', 1, '→', one.number >= data.total],
  ]) {
    const button = element('button', 'refresh', symbol);
    button.type = 'button';
    button.disabled = disabled;
    button.setAttribute('aria-label', swipeText(key));
    button.addEventListener('click', () => move(direction));
    controls.append(button);
    if (direction < 0) controls.append(counter);
  }
  const description = element('figcaption', 'reference-description');
  description.append(element('h2', '', swipeText('description')), element('p', 'hint', galleryText(one.status)), ...referenceLabels(one));
  figure.append(stage, controls, description);
  return [element('h1', '', document.title), element('p', 'hint', swipeText('hint')), figure];
}

async function preloadReference(route, path, data, one, turn) {
  // One neighbor, only after the visible picture is ready. Do not compete with its transfer or load a whole set.
  try {
    const direction = route.direction ?? 1;
    const index = data.references.findIndex(item => item.id === one.id);
    let next = data.references[index + direction];
    if (!next) {
      const page = data.page + direction;
      if (page < 0 || page >= data.pages) return;
      const neighbor = route.neighbor?.page === page ? route.neighbor
        : await (await api([...path, 'references'], page)).json();
      if (turn !== shown) return;
      route.neighbor = neighbor;
      next = neighbor.references.at(direction > 0 ? 0 : -1);
    }
    if (turn === shown && next) await referencePicture([...path, 'references', next.id, 'picture']);
  } catch (error) {
    if (turn === shown && error instanceof Refusal && error.message === 'expired') {
      ++shown;
      requests.abort();
      closeZoom();
      picture = null;
      pictureCached = false;
      clearReferencePictures();
      view.replaceChildren(element('p', 'notice', say('expired')));
    }
    // Other preload failures leave normal selection and its error message available.
  }
}

function swipe(frame, move) {
  let start = null;
  const reset = () => { start = null; frame.classList.remove('swiping'); frame.style.transform = ''; };
  frame.addEventListener('pointerdown', event => {
    if (!event.isPrimary) { pictureClickAfter = Date.now() + 500; reset(); return; }
    if (event.button !== 0) return;
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', event => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) start.dragged = true;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      frame.classList.add('swiping');
      frame.style.transform = `translateX(${Math.max(-80, Math.min(80, dx))}px)`;
    }
  });
  frame.addEventListener('pointerup', event => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    // Dragging must not also open the full-size image through the click that follows a pointer release.
    if (start.dragged || Math.abs(dx) > 8 || Math.abs(dy) > 8) pictureClickAfter = Date.now() + 500;
    reset();
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.3) move(dx < 0 ? 1 : -1);
  });
  frame.addEventListener('pointercancel', () => { pictureClickAfter = Date.now() + 500; reset(); });
  frame.addEventListener('lostpointercapture', reset);
  frame.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    move(event.key === 'ArrowRight' ? 1 : -1, true);
  });
}

function referenceTitle(one) {
  return `#${one.number}${one.main ? ` · ${galleryText('main')}` : ''}`;
}

function referenceLabels(one) {
  const parts = [];
  const labels = values => {
    const list = element('dl', 'labels');
    for (const [key, value] of values) {
      if (value === undefined || value === '') continue;
      list.append(element('dt', '', galleryText(key)), element('dd', '', String(value)));
    }
    return list;
  };
  for (const key of ['caption', 'given']) if (one[key]) {
    parts.push(element('h2', '', galleryText(key)), labels(['pose', 'side', 'framing'].map(field => [field, referenceLabel(field, one[key][field])])));
    if (key === 'caption' && Number.isFinite(one.caption.confidence)) parts.push(element('p', 'hint', `${galleryText('confidence')}: ${Math.round(one.caption.confidence * 100)}%`));
  }
  parts.push(labels(['specificPose', 'poseDetails', 'expression', 'faceVisibility']
    .map(key => [key, key === 'faceVisibility' && one[key] ? galleryText(one[key]) : one[key]])));
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
function portrait(path, size, name, turn, referenceReady) {
  const frame = element('button', 'picture');
  frame.type = 'button';
  if (size.width && size.height) frame.style.aspectRatio = `${size.width} / ${size.height}`;
  const image = element('img');
  image.alt = name;
  image.draggable = false;
  frame.setAttribute('aria-label', `${galleryText('open')}: ${name}`);
  frame.append(image);
  const loaded = referenceReady ? referencePicture(path, true)
    : api(path).then(response => response.blob()).then(blob => turn === shown ? URL.createObjectURL(blob) : null);
  loaded.then(url => {
    if (turn !== shown) {
      if (!referenceReady && url) URL.revokeObjectURL(url);
      return;
    }
    picture = url;
    pictureCached = !!referenceReady;
    image.src = picture;
    frame.addEventListener('click', openZoom);
    referenceReady?.();
  }).catch(error => {
    if (turn === shown) frame.replaceWith(element('p', 'hint', say(error instanceof Refusal ? error.message : 'failed')));
  });
  return frame;
}

function openZoom() {
  if (Date.now() < pictureClickAfter || !picture) return;
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
window.addEventListener('pagehide', () => {
  ++shown;
  requests.abort();
  closeZoom();
  if (picture && !pictureCached) URL.revokeObjectURL(picture);
  picture = null;
  pictureCached = false;
  clearReferencePictures();
});
window.addEventListener('pageshow', event => { if (event.persisted && app?.initData) show(); });
document.documentElement.lang = lang;
if (!app?.initData) view.replaceChildren(element('p', 'notice', say('outside')));
else {
  app.ready();
  app.expand();
  app.BackButton.onClick(back);
  // Chat links can open a person's gallery, preserving the whole Back path. URL fields only select a screen;
  // every API request still authenticates the reader and checks this person's current tag and picture membership.
  const params = new URLSearchParams(location.search);
  const story = params.get('story');
  stack.push({ screen: 'stories' });
  if (/^h\d{1,9}$/.test(story ?? '') && params.getAll('story').length === 1) {
    stack.push({ screen: 'characters', story });
    const index = params.get('index');
    const tag = params.get('tag');
    if (/^\d{1,3}$/.test(index ?? '') && /^[a-f0-9]{8}$/.test(tag ?? '')
      && params.getAll('index').length === 1 && params.getAll('tag').length === 1) {
      stack.push({ screen: 'card', story, index, tag });
      if (params.get('references') === '1' && params.getAll('references').length === 1) {
        stack.push({ screen: 'references', story, index, tag, page: 0 });
      }
    }
  }
  show();
}
