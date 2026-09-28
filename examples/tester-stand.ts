// The tester stand's synthetic stories (local/image-refs-tester.ts, docs/action-experiment.md#tester-stand): the two
// complaints the tester sent through the owner on 2026-09-28 as clean cases. (1) «к тебе с двух сторон прижались
// девушки, а по картинке показывают что они напротив тебя, а мы по сути лишь их часть должны видеть боковым зрением»:
// four stories seen through Артём's eyes, where people are pressed against both his shoulders on a bench, walk at his
// shoulder, lean in from behind, or, as the control, sit facing him. (2) «если персонаж голый, то он и должен быть
// голым, если он в одежде, то он и должен быть в одежде, а не в бодди из референса»: three stories by a lake, a man
// bare-chested after a swim beside a woman who stays dressed, a woman in named everyday clothes, and a woman in a
// swimsuit. The people are the refs stands' H, L, B and T (their details and looks word for word, so that their kept
// fronts in the grey suit are their portraits); Артём, the viewer, keeps none. Each story is its seed and the
// narrator's answers, the last one the scene a frame is described from, with what the people wear before it as the
// bot would start the frame (local/picture.ts `wornAt`), and what a blind judge is told the picture should show.
// Nothing here is adult: a man's bare chest after a swim and a one-piece swimsuit on a beach are all it bares.

export type Who = 'H' | 'L' | 'B' | 'T';
export type Family = 'pov' | 'clothes';
export type CaseId = 'V-squeeze' | 'V-walk' | 'V-behind' | 'V-face' | 'C-bare' | 'C-outfit' | 'C-swim';
export type Person = { name: string; description: string; details: string; look: string };

// The refs stands' people (~/simple-story-chat-runs/2026-09-28/refs-backlog/build-texts.ts): details and looks as the
// bot's retelling wrote them, and a description in the story's language as its sheet would hold it.
export const PEOPLE: Record<Who, Person> = {
  H: { name: 'Мара', description: 'Молодая женщина среднего роста, фигура песочные часы: очень большая грудь, тонкая талия, широкие бёдра. Очень светлая кожа, густые медно-рыжие волнистые волосы ниже лопаток, распущенные, зелёные глаза, веснушки на плечах.',
    details: 'A young adult woman with an hourglass figure: a very large bust, a much narrower waist and wide rounded hips, soft arms and legs without muscle definition, average height. Very light skin with a pinkish undertone. Thick copper-red hair in large waves below the shoulder blades, usually worn down. Round face, soft chin, slightly upturned nose, green eyes, thin straight eyebrows, and full lips. Freckles on the shoulders.',
    look: 'A young adult woman with an hourglass figure: very large breasts, a much narrower waist and wide hips; copper-red wavy hair, average height, very light skin.' },
  L: { name: 'Лина', description: 'Молодая женщина, высокая и стройная, фигура грушей: небольшая грудь, узкая талия, широкие бёдра, длинные ноги. Очень светлая кожа, прямые светло-рыжие волосы до плеч в высоком хвосте, серо-голубые глаза, родинка над левым уголком рта.',
    details: 'A young adult woman with a tall, slender pear-shaped figure: small breasts, a narrow waist, wide rounded hips and long legs, soft arms without muscle definition. Very light skin. Straight light-red golden hair to the shoulders, worn in a high ponytail. Oval face, sharp chin, straight nose, gray-blue eyes, thick arched light eyebrows, and thin lips. A mole above the left corner of the mouth.',
    look: 'A young adult woman with a tall, slender pear-shaped figure: small breasts, a narrow waist and wide hips; golden ponytail, very light skin, a mole above the left corner of the mouth.' },
  B: { name: 'Бруно', description: 'Мужчина средних лет, высокий и грузный: широкие покатые плечи, бочкообразная грудь, большой круглый живот. Светлая кожа с румянцем, короткие тёмно-русые волосы с залысинами, зачёсаны назад, густая короткая тёмная борода, шрам через правую бровь.',
    details: 'A middle-aged man, tall and heavyset: broad rounded shoulders, a thick barrel chest, a large round belly, a thick waist, heavy arms and thick legs, soft rather than muscular. Light skin with a ruddy undertone. Short dark-brown hair thinning at the temples, combed back. Broad round face, full cheeks, a double chin, thick dark eyebrows, small dark-brown eyes, a wide nose, and a full dark-brown beard trimmed short. A small scar through the right eyebrow.',
    look: 'A middle-aged man, tall and heavyset: broad shoulders, a large round belly, thick arms and legs; short dark-brown hair, a full beard, light skin.' },
  T: { name: 'Тесса', description: 'Молодая женщина, невысокая и худенькая: узкие плечи, небольшая грудь, узкие бёдра. Светло-смуглая кожа, прямые чёрные волосы каре до подбородка с ровной чёлкой, карие глаза, круглые очки в чёрной оправе, маленькое родимое пятно на левой стороне шеи.',
    details: 'A young adult woman, short and slim: narrow shoulders, small breasts, a narrow waist and narrow hips, thin arms and slim legs, a small light frame. Light brown skin with a warm undertone. Straight black hair cut in a chin-length bob with a blunt fringe. Heart-shaped face, pointed chin, small nose, dark-brown eyes, straight dark eyebrows, and full lips. Round black-framed glasses. A small dark birthmark on the left side of the neck.',
    look: 'A young adult woman, short and slim: small breasts, a narrow waist and narrow hips; black chin-length bob, light brown skin, round black glasses.' },
};
// The reader's own person, through whose eyes the four POV stories are seen. No portrait: the bot keeps a viewer's
// out of the references anyway (local/picture-pov.ts).
export const VIEWER: Person = { name: 'Артём', description: 'Молодой мужчина среднего роста, худощавый, короткие тёмно-русые волосы, лёгкая щетина, светлая кожа.',
  details: 'A young adult man of average height and lean build. Light skin. Short dark-brown hair. Light stubble.',
  look: 'A young adult man of average height and lean build; short dark-brown hair, light stubble, light skin.' };

// The seeds, as a reader writes one: a title, the start and the world (lib/library.ts `addSeed`).
export const SEEDS = {
  sea: `Выходные у моря
2026-08-14 09:00
Ты — Артём, приехал на выходные в приморский городок к старым друзьям: Маре, Лине, Бруно и Тессе. Компания давно знакома, все подшучивают друг над другом, много гуляют и спорят, куда идти дальше.

Мара рыжая и смешливая, Лина высокая и спокойная, Бруно большой и громкий, Тесса маленькая, в круглых очках и всегда с картой.

Начни с утра субботы.`,
  lake: `Неделя на озере
2026-07-20 10:00
Мара, Лина, Бруно и Тесса, старые друзья, сняли на неделю деревянный домик у лесного озера. Жарко, вода тёплая, дел никаких: купаться, играть в карты и готовить на огне.

Начни с первого утра.`,
};

// What the people of a story wear before its last scene, by name: the sheet's outfit, or the clothes the picture of an
// earlier scene gave them. Everybody on the sheet has some, as a written sheet does.
const WORN = {
  H: 'wearing a fitted sleeveless white top, a fitted knee-length navy skirt and white canvas shoes',
  L: 'wearing a green knitted cardigan over a white blouse, grey trousers and white canvas shoes',
  B: 'wearing a loose dark green shirt with rolled sleeves, brown trousers and brown boots',
  T: 'wearing a mustard-yellow cardigan over a white T-shirt, a black knee-length skirt and black flat shoes',
  viewer: 'wearing a dark blue denim jacket over a grey hoodie, black jeans and white sneakers',
};

// A narrator's answer and the reader's message it answers; none for the story's first scene, which answers the bot's
// own opening (local/story-text/ru.ts `startStory`).
export type Turn = { input?: string; time: string; text: string };
// Where a person of a POV story should be in the frame: the side of the picture, how they stand against the viewer,
// and how much of them should be in view. `whole` for the one really in front, whose face and upper body are in view.
export type Placed = { who: Who; side: 'left edge' | 'right edge' | 'middle'; where: string; view: 'part' | 'whole' };
// What a person of a clothes story should wear, the parts of the body the scene leaves bare, and those their clothes
// cover. A part in neither, such as the legs under swim shorts or a knee-length skirt, is not judged.
export type BarePart = 'chest and belly' | 'arms' | 'legs' | 'feet';
export type Dressed = { who: Who; clothes: string; bare: BarePart[]; covered: BarePart[] };
export type TesterCase = { id: CaseId; family: Family; seed: keyof typeof SEEDS; turns: Turn[]; outfits: Partial<Record<Who, string>>;
  intent: string; placed?: Placed[]; dressed?: Dressed[] };

const SEA_OUTFITS = { H: WORN.H, L: WORN.L, B: WORN.B, T: WORN.T };
export const CASES: TesterCase[] = [
  { id: 'V-squeeze', family: 'pov', seed: 'sea', outfits: SEA_OUTFITS, turns: [{ time: '2026-08-14 09:40',
    text: 'Ветер с моря холодный, и на узкой скамейке в конце пирса вы сидите втроём, тесно, плечом к плечу. Ты посередине. Лина прижалась к твоему левому плечу, Тесса — к правому, так что тебе не пошевелиться. Лина передаёт через тебя Тессе термос с чаем, Тесса смеётся и дует на крышку-стаканчик. Ты смотришь прямо перед собой, на серое море и чаек над волнорезом.' }],
    intent: 'Seen through the eyes of a young man sitting in the middle of a narrow bench at the end of a pier, looking straight ahead at a grey sea and gulls over a breakwater. Two young women sit pressed against his shoulders: one against his left shoulder, one against his right, passing a thermos of tea across in front of him. Nobody is in front of him.',
    placed: [{ who: 'L', side: 'left edge', where: 'sitting pressed against the viewer\'s left shoulder on the same bench, seen from the side at the very edge of the picture', view: 'part' },
      { who: 'T', side: 'right edge', where: 'sitting pressed against the viewer\'s right shoulder on the same bench, seen from the side at the very edge of the picture', view: 'part' }] },
  { id: 'V-walk', family: 'pov', seed: 'sea', outfits: SEA_OUTFITS, turns: [{ time: '2026-08-14 11:10',
    text: 'Вы с Марой идёте по набережной. Она шагает совсем рядом, у твоего левого плеча, так близко, что задевает тебя рукавом, и рассказывает, как вчера заблудилась на рынке. Ты смотришь вперёд, на длинную набережную с фонарями и на белый маяк в её конце. Мара на ходу поворачивает к тебе голову и смеётся.' }],
    intent: 'Seen through the eyes of a young man walking along a seafront promenade, looking ahead at the lamp posts and a white lighthouse at its end. A young woman walks right beside him at his left shoulder, close enough to brush his sleeve, turning her head toward him and laughing. Nobody walks in front of him.',
    placed: [{ who: 'H', side: 'left edge', where: 'walking right beside the viewer at his left shoulder, seen from the side at the very edge of the picture', view: 'part' }] },
  { id: 'V-behind', family: 'pov', seed: 'sea', outfits: SEA_OUTFITS, turns: [{ time: '2026-08-14 13:30',
    text: 'Ты сидишь за столиком летнего кафе и разворачиваешь бумажную карту побережья. Бруно подходит сзади, наклоняется над твоим правым плечом и тычет толстым пальцем в маленькую бухту на карте: туда, говорит, завтра и пойдём. Его борода почти касается твоего уха. Ты смотришь вниз, на карту и на его руку на ней.' }],
    intent: 'Seen through the eyes of a young man seated at a café table, looking down at a paper map of the coast spread out before him. A big bearded man leans in from behind over his right shoulder and points at a small bay on the map with a thick finger. Nobody sits across the table.',
    placed: [{ who: 'B', side: 'right edge', where: 'leaning in from behind over the viewer\'s right shoulder: his arm and pointing hand reach into the picture over the map, and at most the side of his bearded face shows at the right edge', view: 'part' }] },
  { id: 'V-face', family: 'pov', seed: 'sea', outfits: SEA_OUTFITS, turns: [{ time: '2026-08-14 19:00',
    text: 'Вечером вы с Марой ужинаете в маленьком рыбном ресторанчике у воды. Она сидит напротив тебя за узким столом, подпирает подбородок рукой и рассказывает про свою работу. Между вами тарелка с жареной рыбой и два стакана лимонада. Ты смотришь на неё через стол.' }],
    intent: 'Seen through the eyes of a young man at dinner in a small fish restaurant by the water. A young woman sits across the narrow table facing him, her chin propped on her hand, talking; between them a plate of fried fish and two glasses of lemonade.',
    placed: [{ who: 'H', side: 'middle', where: 'sitting across the table from the viewer, facing him, in front of him in the middle of the picture', view: 'whole' }] },
  { id: 'C-bare', family: 'clothes', seed: 'lake', outfits: { H: WORN.H, L: WORN.L, B: WORN.B, T: WORN.T }, turns: [
    { time: '2026-07-20 10:00', text: 'Утро тёплое и тихое. Бруно в свободной тёмно-зелёной рубашке с закатанными рукавами, коричневых брюках и ботинках спускается к деревянным мосткам с корзиной полотенец. Тесса в горчичном кардигане поверх белой футболки, чёрной юбке до колен и чёрных балетках идёт следом с термосом. Вода у мостков прозрачная и неподвижная.' },
    { input: 'Бруно идёт купаться.', time: '2026-07-20 10:40', text: 'Бруно сбрасывает рубашку, брюки и ботинки прямо на мостки и в одних тёмно-синих плавательных шортах прыгает в озеро. Через несколько минут он выбирается обратно, мокрый, по пояс голый и босой, и садится на край мостков, свесив ноги к воде. Тесса, всё так же в кардигане и юбке, садится рядом и протягивает ему крышку термоса с горячим чаем. Бруно берёт её обеими руками и смеётся.' }],
    intent: 'A big bearded man, wet after a swim in a forest lake, sits on the edge of a wooden jetty with his feet toward the water, holding a cup of hot tea in both hands and laughing. A short young woman in glasses, still fully dressed, sits beside him.',
    dressed: [{ who: 'B', clothes: 'only dark navy swim shorts: bare-chested and barefoot', bare: ['chest and belly', 'arms', 'feet'], covered: [] },
      { who: 'T', clothes: 'a mustard-yellow cardigan over a white T-shirt, a black knee-length skirt and black flat shoes', bare: [],
        covered: ['chest and belly', 'arms', 'feet'] }] },
  { id: 'C-outfit', family: 'clothes', seed: 'lake', outfits: { H: 'wearing a red knitted sweater, blue jeans and white canvas sneakers', L: WORN.L, B: WORN.B, T: WORN.T },
    turns: [{ time: '2026-07-21 09:30', text: 'Мара выходит на крыльцо домика в красном вязаном свитере, синих джинсах и белых кедах, с кружкой кофе в руке. Она спускается по ступенькам к столу под соснами, ставит кружку и начинает раскладывать на столе карты для игры. Солнце пробивается сквозь ветки.' }],
    intent: 'A young woman with wavy copper-red hair at a table under pine trees by a wooden cabin, a mug of coffee beside her, laying out playing cards on the table in the morning sun.',
    dressed: [{ who: 'H', clothes: 'a red knitted sweater, blue jeans and white canvas sneakers', bare: [], covered: ['chest and belly', 'arms', 'legs', 'feet'] }] },
  { id: 'C-swim', family: 'clothes', seed: 'lake', outfits: { H: WORN.H, L: 'wearing a light white sundress, a straw hat and brown sandals', B: WORN.B, T: WORN.T }, turns: [
    { time: '2026-07-22 11:00', text: 'Лина приходит на песчаный пляж у озера в лёгком белом сарафане, соломенной шляпе и коричневых сандалиях, с полосатым полотенцем под мышкой. Она выбирает место у самой воды и расстилает полотенце на песке.' },
    { input: 'Лина идёт плавать.', time: '2026-07-22 11:15', text: 'Лина снимает сарафан, шляпу и сандалии и остаётся в ярко-жёлтом слитном купальнике. Босиком она заходит в воду по колено, оборачивается к берегу и машет рукой, щурясь от солнца. Сарафан и шляпа лежат на полотенце.' }],
    intent: 'A tall young woman with a golden ponytail stands knee-deep in a forest lake by a sandy beach, turned back toward the shore and waving, squinting in the sun. Her white sundress and straw hat lie on a striped towel on the sand.',
    dressed: [{ who: 'L', clothes: 'a bright yellow one-piece swimsuit, barefoot', bare: ['arms', 'legs', 'feet'], covered: ['chest and belly'] }] },
];
// The viewer's own clothes in the four POV stories, and how a judge would know him should he be drawn from outside.
export const VIEWER_OUTFIT = WORN.viewer;
export const VIEWER_SEEN = 'a young man with short dark-brown hair and light stubble, wearing a dark blue denim jacket over a grey hoodie, black jeans and white sneakers';
