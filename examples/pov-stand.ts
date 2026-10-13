// The POV stand's synthetic stories (local/pov-stand.ts, docs/telegram-ui.md#seen-through-their-eyes): two runs of
// examples/seed.txt, one seen through Мира's eyes and one through Ефим's, twenty scenes in all. Each scene is a
// narrator's answer written for the stand, the reader's input before it, and what a blind judge is told the picture
// is meant to show, with the people it should hold besides the viewer. Clean and synthetic: safe to send to models.

// The cases the stand covers: the viewer looks down at their own body, holds something, sees their reflection in a
// mirror or in water, is absent from a cutaway, faces two other people drawn from their kept portraits, or touches
// somebody.
export type Case = 'body' | 'holding' | 'mirror' | 'water' | 'cutaway' | 'two-references' | 'touch';
export type StandScene = { id: string; case: Case; input: string; time: string; text: string; intent: string; people: number };
// `portraits`: who keeps a portrait on the sheet, and which: a synthetic front of the refs stand (`L`, `H`), or a stub
// the stand must never find among a frame's references (the viewer's). Nobody else keeps one.
export type StandStory = { id: string; viewer: string; portraits: Record<string, 'L' | 'H' | 'stub'>; scenes: StandScene[] };

// The sheet the story model is answered with, and the retellings: Лида's look is the synthetic L's of the refs stand
// and Хелена's the synthetic H's, so that their kept portraits can be those fronts.
export const SHEET = { characters: [
  { name: 'Мира', description: 'Молодая женщина, светлая кожа, стройная, длинные тёмно-русые волосы в низком хвосте, веснушки.', changes: '',
    outfit: 'wearing a navy wool sweater, dark grey trousers and brown leather boots' },
  { name: 'Ефим', description: 'Пожилой мужчина, обветренная загорелая кожа, коренастый, короткая белая борода, лысый.', changes: '',
    outfit: 'wearing a patched canvas coat, canvas trousers and rubber boots' },
  { name: 'Лида', description: 'Молодая женщина, высокая и стройная, очень светлая кожа, прямые светло-рыжие волосы до плеч в высоком хвосте, серо-голубые глаза, родинка над левым уголком рта.',
    changes: '', outfit: 'wearing a green knitted cardigan over a white blouse and grey trousers' },
  { name: 'Хелена', description: 'Молодая женщина среднего роста, фигура песочные часы, очень светлая кожа с розоватым оттенком, густые медно-рыжие волнистые волосы ниже лопаток, распущенные, круглое лицо, зелёные глаза.',
    changes: '', outfit: 'wearing a mustard wool coat over a cream knitted dress and brown ankle boots' },
] };
export const LOOKS = [
  { details: 'A young adult woman with fair skin and a slender build, long straight dark-blond hair in a low ponytail, freckles.',
    look: 'A young adult woman, fair skin, slender build, long dark-blond hair in a low ponytail, freckles across her nose' },
  { details: 'An elderly man with weathered tanned skin and a stocky build, a short white beard and a bald head.',
    look: 'An elderly man, weathered tanned skin, stocky build, short white beard, bald head' },
  { details: 'A tall slender young adult woman with very light skin, straight light-red golden hair to the shoulders in a high ponytail, gray-blue eyes and a mole above the left corner of the mouth.',
    look: 'A young adult woman, tall slender build, very light skin, straight light-red golden hair to the shoulders in a high ponytail, oval face, gray-blue eyes, a mole above the left corner of the mouth' },
  { details: 'A young adult woman of average height with an hourglass figure, very light skin with a pinkish undertone, thick wavy copper-red hair below the shoulder blades worn down, a round face and green eyes.',
    look: 'A young adult woman, average height, hourglass figure, very light skin with a pinkish undertone, thick wavy copper-red hair below the shoulder blades worn down, round face, green eyes' },
];
// The scene that opens both runs, drawn before the viewer is chosen; its frame is answered by the stand, not a model.
export const OPENING = { time: '2026-08-02 20:05', text: 'Мира стоит у окна фонарной комнаты и смотрит вниз, на причал. Пустая лодка покачивается у свай, на её носу горит фонарь.' };

const MIRA = 'a young woman (long dark-blond hair in a low ponytail)';
const LIDA = 'a young woman with straight light-red golden hair in a high ponytail';
const HELENA = 'a young woman with thick wavy copper-red hair worn down';

export const STORIES: StandStory[] = [
  { id: 'A', viewer: 'Мира', portraits: { Мира: 'stub', Лида: 'L', Хелена: 'H' }, scenes: [
    { id: 'A1', case: 'body', input: 'Сесть в лодку и отплыть от причала.', time: '2026-08-02 20:20',
      text: 'Мира садится на скамью пустой лодки и берётся за вёсла. Она гребёт, глядя вниз: на свои колени в тёмно-серых брюках, на коричневые ботинки, упёртые в мокрое дно, на руки, сжимающие вёсла. Вокруг только тёмная вода и туман. Она одна.',
      intent: 'Seen through the eyes of a young woman rowing a small boat alone and looking down: her own knees in dark grey trousers, her brown boots on the wet bottom boards, her hands gripping the oars. Nobody else is there.', people: 0 },
    { id: 'A2', case: 'body', input: 'Вернуться и лечь отдохнуть.', time: '2026-08-02 22:40',
      text: 'Поздно вечером Мира ложится на узкую кровать в комнате смотрителя, поверх шерстяного одеяла, прямо в свитере. Она приподнимает голову и смотрит вдоль себя: на синий свитер, на раскрытую книгу у себя на животе, на ноги в шерстяных носках у спинки кровати. В комнате никого.',
      intent: 'Seen through the eyes of a young woman lying on a narrow bed and lifting her head to look down along her own body: her navy sweater, an open book on her belly, her legs in wool socks at the foot of the bed. Nobody else is there.', people: 0 },
    { id: 'A3', case: 'holding', input: 'Подняться в фонарную комнату.', time: '2026-08-02 23:10',
      text: 'Мира поднимается по винтовой лестнице маяка, держа фонарь на вытянутой правой руке. Свет прыгает по каменным ступеням. Левой рукой она держится за холодные железные перила и смотрит вверх, туда, где лестница уходит в темноту. Она одна.',
      intent: 'Seen through the eyes of a young woman climbing a dark spiral stone staircase, her right hand holding a lantern out ahead, her left hand on an iron railing, looking up the stairs. Nobody else is there.', people: 0 },
    { id: 'A4', case: 'holding', input: 'Изучить морскую карту.', time: '2026-08-02 23:30',
      text: 'У окна фонарной комнаты Мира разворачивает обеими руками старую морскую карту острова. Бумага шуршит, на ней карандашом обведена бухта к северу от маяка. Мира держит карту перед собой и водит взглядом по линиям. Больше здесь никого нет.',
      intent: 'Seen through the eyes of a young woman holding an old sea chart unfolded in both hands in front of her by a window; a bay is circled in pencil on it. Nobody else is there.', people: 0 },
    { id: 'A5', case: 'holding', input: 'Открыть кладовую.', time: '2026-08-03 07:10',
      text: 'Утром Мира подходит к низкой двери кладовой и вставляет в замок тяжёлый латунный ключ. Правой рукой она поворачивает ключ, левой упирается в дверь. Замок щёлкает. Вокруг никого.',
      intent: 'Seen through the eyes of a young woman at a low wooden door, her right hand turning a heavy brass key in the lock, her left hand pressed against the door. Nobody else is there.', people: 0 },
    { id: 'A6', case: 'mirror', input: 'Причесаться перед зеркалом.', time: '2026-08-03 07:30',
      text: 'В комнате смотрителя Мира встаёт перед старым зеркалом в деревянной раме, распускает волосы и расчёсывает их гребнем. В зеркале видно её лицо с веснушками и синий свитер. Она одна в комнате.',
      intent: `Seen through the eyes of ${MIRA} standing before an old mirror in a wooden frame and combing her loose hair; her reflection in the mirror faces her. Only her reflection shows her; nobody else is in the room.`, people: 0 },
    { id: 'A7', case: 'water', input: 'Спуститься к причалу с фонарём.', time: '2026-08-03 21:00',
      text: 'Мира опускается на колени на краю причала, держа фонарь над водой. Вода внизу совсем гладкая, и в ней, освещённое снизу, видно её отражение: лицо, выбившиеся волосы, синий свитер. Вокруг никого.',
      intent: `Seen through the eyes of ${MIRA} kneeling at the edge of a wooden pier at night, holding a lantern over still black water and looking down at her own reflection in it. Nobody else is there.`, people: 0 },
    { id: 'A8', case: 'cutaway', input: 'Что в это время делает Ефим?', time: '2026-08-03 21:20',
      text: 'Тем временем старый паромщик Ефим сидит в своей избушке у берега. Он чистит трубку у печки, на столе лежит мокрая верёвка. Старик долго смотрит в огонь, потом достаёт из сундука старую фотографию маяка и хмурится.',
      intent: 'A scene without the young woman: an old bald ferryman with a white beard alone in his hut by a stove, cleaning his pipe, an old photograph of a lighthouse at hand. An ordinary picture, not seen through anybody\'s eyes; the young woman is not there.', people: 1 },
    { id: 'A9', case: 'two-references', input: 'Позавтракать с соседками.', time: '2026-08-04 08:00',
      text: 'Утром на кухне маяка Мира сидит за столом. Напротив неё садятся две соседки: Лида, племянница смотрителя, и её подруга Хелена. Лида наливает чай, Хелена режет хлеб, и обе наперебой рассказывают Мире про ночной шторм.',
      intent: `Seen through the eyes of a young woman seated at a kitchen table; opposite her sit two young women, ${LIDA} pouring tea and ${HELENA} cutting bread, both talking to her.`, people: 2 },
    { id: 'A10', case: 'two-references', input: 'Помочь вытащить лодку.', time: '2026-08-04 09:30',
      text: 'На причале Лида и Хелена тянут пустую лодку за верёвку к берегу, упираясь ногами в доски. Мира стоит на ступеньках над ними, держится рукой за перила и смотрит сверху. Хелена кричит ей что-то и смеётся.',
      intent: `Seen through the eyes of a young woman standing on steps above a pier, one hand on the railing, looking down at two young women hauling a small boat by a rope: ${LIDA} and ${HELENA}, who looks up laughing.`, people: 2 },
    { id: 'A11', case: 'touch', input: 'Утешить Лиду.', time: '2026-08-04 20:00',
      text: 'Вечером Лида сидит на ступеньках крыльца и плачет. Мира садится рядом и кладёт правую руку ей на плечо. Лида поворачивает к ней заплаканное лицо.',
      intent: `Seen through the eyes of a young woman sitting beside ${LIDA} on porch steps; the viewer's own right hand rests on her shoulder, and she turns her tearful face toward the viewer.`, people: 1 },
    { id: 'A12', case: 'touch', input: 'Познакомиться с Ефимом.', time: '2026-08-05 10:00',
      text: 'На причале старый паромщик Ефим протягивает Мире широкую обветренную ладонь. Мира пожимает её правой рукой. Ефим улыбается в белую бороду.',
      intent: 'Seen through the eyes of a young woman shaking hands with an old bald ferryman with a white beard on a pier; her own right hand clasps his.', people: 1 },
  ] },
  { id: 'B', viewer: 'Ефим', portraits: { Ефим: 'stub', Лида: 'L', Хелена: 'H' }, scenes: [
    { id: 'B1', case: 'body', input: 'Выйти на палубу парома.', time: '2026-08-02 20:30',
      text: 'Ефим стоит на качающейся палубе своего парома и смотрит под ноги: на резиновые сапоги в лужах морской воды, на живот, обтянутый залатанным брезентовым плащом, на моток мокрой верёвки у ног. Он один на палубе.',
      intent: 'Seen through the eyes of a stocky old man standing on the rocking deck of a small ferry and looking down at his own rubber boots in puddles, his belly in a patched canvas coat, a coil of wet rope at his feet. Nobody else is there.', people: 0 },
    { id: 'B2', case: 'body', input: 'Починить сеть.', time: '2026-08-02 21:00',
      text: 'Ефим сидит на табурете у двери избушки и чинит сеть, разложенную у него на коленях. Он смотрит вниз, на свои загорелые узловатые пальцы с деревянной иглой и на колени в брезентовых штанах. Вокруг никого.',
      intent: 'Seen through the eyes of an old man sitting on a stool and looking down at a fishing net spread over his own knees in canvas trousers, and at his own weathered tanned hands mending it with a wooden needle. Nobody else is there.', people: 0 },
    { id: 'B3', case: 'holding', input: 'Рассмотреть старую фотографию.', time: '2026-08-02 21:30',
      text: 'Ефим садится за стол и держит в обеих руках старую выцветшую фотографию: маяк в солнечный день, на скале, без людей. Он подносит снимок ближе к керосиновой лампе. В избушке больше никого.',
      intent: 'Seen through the eyes of an old man seated at a table, holding a faded photograph of a lighthouse in both hands close to an oil lamp. Nobody else is there.', people: 0 },
    { id: 'B4', case: 'mirror', input: 'Побриться.', time: '2026-08-03 06:30',
      text: 'Утром Ефим бреется перед маленьким зеркалом, прибитым к стене избушки. Он держит бритву в правой руке и смотрит на своё отражение: лысая голова, белая борода, которую он подравнивает. Больше в избушке никого.',
      intent: 'Seen through the eyes of an old man shaving before a small mirror nailed to the wall of a hut, a razor in his right hand; in the mirror his reflection, bald with a white beard, faces him. Nobody else is there.', people: 0 },
    { id: 'B5', case: 'water', input: 'Умыться из бочки.', time: '2026-08-03 06:50',
      text: 'Ефим наклоняется над бочкой с дождевой водой у крыльца. Вода совсем тихая, и в ней отражается его лицо, лысина и белая борода, а над ними серое небо. Он опускает в воду ладони. Вокруг никого.',
      intent: 'Seen through the eyes of an old man leaning over a barrel of still rainwater and looking down at his own reflection in it, bald with a white beard, against a grey sky, his hands reaching into the water. Nobody else is there.', people: 0 },
    { id: 'B6', case: 'cutaway', input: 'Что в это время делает Мира?', time: '2026-08-03 21:00',
      text: 'Тем временем Мира в фонарной комнате маяка зажигает большую лампу. Она подкручивает фитиль, свет разгорается, и луч уходит в темноту над морем. Мира довольно улыбается.',
      intent: `A scene without the old man: ${MIRA} alone in the lamp room of a lighthouse, lighting the great lamp, its beam going out over the dark sea. An ordinary picture, not seen through anybody's eyes; the old man is not there.`, people: 1 },
    { id: 'B7', case: 'two-references', input: 'Встретить пассажирок.', time: '2026-08-04 09:00',
      text: 'К парому подходят Лида и Хелена с корзинами. Ефим стоит у трапа. Лида протягивает ему билеты, Хелена машет рукой и смеётся. Ефим берёт билеты и кивает им.',
      intent: `Seen through the eyes of an old man standing at the gangway of a small ferry; before him two young women with baskets, ${LIDA} holding out tickets and ${HELENA} waving and laughing; his own hand takes the tickets.`, people: 2 },
    { id: 'B8', case: 'touch', input: 'Помочь Мире выбраться из лодки.', time: '2026-08-04 18:00',
      text: 'Мира стоит в качающейся лодке у причала. Ефим наклоняется с досок, протягивает ей правую руку, и Мира хватается за неё. Он тянет её наверх, на причал.',
      intent: `Seen through the eyes of an old man leaning down from a pier, his own right hand gripping the hand of ${MIRA} who stands in a rocking boat below, pulling her up.`, people: 1 },
  ] },
];
