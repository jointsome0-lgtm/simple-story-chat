// The lean frame (the owner, 2026-10-28: «1. да 2. да 3. да»), which since 2026-10-30 describes every frame of a story
// seen through a person's eyes (docs/telegram-ui.md#seen-through-their-eyes), and no other: the owner's «поставить при
// режиме на пов B + guide + cfg=2 + step=33». The owner's marks on the Qwen pictures of the third stand put most
// faults where a person or a touch was written twice: in `moment` or `props` and again in the person's own clause, or one hand-holding in both
// people's lines, and the picture had that person twice or a third hand. Here each person is written once, in their own
// entry, and each touch once, in a list of its own, and the frame has no `moment` and no `props`. Each person's face is
// asked for, which the bot's frames gave about one person line in five; a hairstyle the scene gives replaces the
// sheet's; a person seen only on a screen gets no portrait and is drawn small, as a video image; and the prompt says
// how many people the picture has. The answer names the people where it means them, and the assembly puts in their
// place the words the image model knows each by: "the person from image 2" for a referenced one, the noun of the look
// for the others ("the young man"). The style line is said once. The owner's «да давай» of the same evening, after a
// ritual of portals and ninjas was taken apart on paper, added the rest: a touch of three or more as one shared pose, a
// gesture of two as one touch, one hand doing one thing, a touch that comes from no person said where it comes from, a
// named gesture by its name, a rider's animal in the rider's action, two of one role told apart by their place, and
// the people far behind the four in `background`.
//
// The owner's «да можно» of 2026-10-29, after the marks of that day's picture card were read beside GPT-6 Astra's,
// added the rules of what the frames had missed there: the whole outfit at any shot, dressed for the scene and checked
// against it rather than carried over, with how each garment closes and sits; a costume by its parts; the shot by what
// must fit and the camera where the faces show; depth, gaze and the place's layout in words; the people a crowd presses
// on written as people; the body line first, limbs near and far, a raised head on a support, forces at their size, one
// thing per person, a pair's known pose by its name, teams by screen sides and one crossing of a game; only the people
// of the scene; objects in use and how an unknown one is built; one expression per face. A person seen through frosted
// glass is a blur (`blurred`): no portrait, no face, and no "Clear silhouettes." in the line, since none of the
// card's 24 glass scenes came out with the blur asked for. A story seen through a person's eyes now has a lean frame
// too, which chooses whether to look through their eyes (`eyesRule`).
//
// local/illustrate.ts keeps its request builders as they are, which the action experiment pins by hash
// (local/action-text.ts `textPins`), as local/picture-pov.ts does, so this frame has its own rule for the clothes.
// A story without such a person keeps every request, prompt, graph and recipe as it was.
import type { Story } from '../lib/library.ts';
import { DESCRIBE_TOKENS, matchSheet, sheetLooks, stripAges, stripNames } from './illustrate.ts';
import type { Assembled, Character, Description, Excerpt, Person } from './illustrate.ts';
import type { ModelRequest } from './model.ts';
import { firstPerson, openingOf, unnamed } from './picture-pov.ts';
import { frameReferences } from './picture-references.ts';
import type { PoseViews } from './pose-set.ts';

// A person of a lean frame: the hairstyle of the scene, empty for the usual one, the face, whether they are only on a
// screen, and whether they are seen only through frosted or fogged glass, a curtain or steam. `state` stays empty: what
// it held went to `action`.
export type LeanPerson = Person & { hair: string; face: string; onScreen: boolean; blurred: boolean };
// What the answer says of the person a story is seen through, when it chose to look through their eyes: what they
// wear, what of their body is in view and their reflection (local/picture-pov.ts).
export type Eyes = { clothes: string; body: string; reflection: string };
// `moment` and `props` stay empty, every touch between people is one line of `touches`, and `background` is the people
// far behind, small and faceless, or empty. `eyes` only until `leanSeen` makes the frame a first-person one, and
// `ownShot` only after it: the shot as the answer wrote it, which the first-person clause then stands in place of.
export type LeanDescription = Omit<Description, 'people'> & { people: LeanPerson[]; touches: string[]; background: string; eyes?: Eyes;
  ownShot?: string };
// A frame is lean by what it carries, so that a sample of its style draws it as it was described.
export const isLean = (description: Description): description is LeanDescription =>
  Array.isArray((description as Partial<LeanDescription>).touches);

// What the sheet's people wore before this scene (local/picture.ts `wornAt`), as local/illustrate.ts `clothesRule` gives
// it, and when the frame dresses them otherwise. Told to repeat the line unless the story changed it, the card's frames
// kept a young woman in the seed's shorts in autumn rain, ill at home and on a run, a woman in the seed's linen dress at
// a waltz, and an apron put on five days before; the change the scene before made is kept as the next frames needed it.
const wornRule = (sheet: Character[]) => {
  const worn = sheet.filter(character => character.outfit?.trim());
  if (!worn.length) return '';
  return `
- Одежда людей из списка до этой сцены:
${worn.map(character => `  - ${character.name}: ${character.outfit!.trim()}`).join('\n')}
  С неё начни и проверь каждую вещь по последней сцене. Если история с тех пор переодела человека, испачкала или порвала одежду, пиши её такой, какая она сейчас. Сравни дату и время в начале этой сцены и прошлой: если это тот же день и человеку было негде переодеться (он не уходил к себе, не выходил на улицу и не возвращался), одежда та же, с тем, что с тех пор сняли, надели или закатали; новое дело на том же месте одежду само не меняет. Если настал другой день, человек сменил место или погоду или занялся тем, для чего нужна своя одежда (бег, плавание, сон), а история не говорит, во что он одет, одень его так, как он оделся бы сам для этой сцены, и не неси из прошлого то, что к ней не подходит (фартук, уличную обувь в гостях, шапку в доме). clothes_as_before: true, если человек одет в точности так, как в его строке здесь, ничего не сняв и не надев, и в строке уже есть цвет и посадка каждой вещи, как застёгнуто и обувь; тогда программа сама возьмёт эту строку слово в слово, и где ещё в ответе видна его одежда (action, viewer, reflection), она та, что в этой строке. Иначе false, и clothes пиши заново: всю одежду такой, какой она стала, с тем, чего в строке не хватало.`;
};

// The instruction, in the language and with the rules of local/illustrate.ts `instruction` wherever the two agree.
const instruction = (sheet: Character[], opening: string) => `Не продолжай историю. Опиши ПОСЛЕДНЮЮ сцену${opening ? ` (последний ответ рассказчика, тот, что начинается словами «${opening}…»)` : ''} для художника-иллюстратора: один неподвижный кадр, как в визуальной новелле. Пиши по-английски. Готовый запрос для модели картинок соберёт программа из твоих полей, поэтому всё существенное должно быть в полях; чего в них нет, того не будет на картинке.
Правила:
- Каждый человек описан ОДИН раз, в своей записи people, и каждое касание между людьми ОДИН раз, в touches. В setting, objects и light людей нет, а в shot человек бывает только тем, откуда смотрит камера (over the guard's shoulder). Человека или касание, названные дважды, модель рисует дважды: второго человека, третью руку.
- Людей из списка в shot, action и touches называй по имени из списка, остальных — их ролью из who (the waiter). Программа заменит имя на то, по чему модель картинок знает этого человека. В look, hair, clothes и face имён нет.
- Модель картинок хорошо рисует, КТО в кадре, ГДЕ они, как стоят и что держат. Она НЕ умеет рисовать точные контакты (лезвие в щели, пальцы на кнопке, отмычку в скважине), читаемый текст и содержимое экранов. Скрывай такие детали ракурсом: экран повёрнут тыльной стороной к зрителю, кончик инструмента закрыт руками. Жест с общеизвестным названием (high five, thumbs up, a military salute, a ninja hand seal) пиши названием и одной короткой фразой о том, как он выглядит; пальцы жеста без названия не расписывай.
- Выбери ОДИН конкретный момент сцены, до или после сложного контакта, и сохрани состояние людей и предметов именно в этот момент: у кого оружие, обнажено оно или в ножнах, какая рука повреждена, открыта или закрыта дверь, кто продолжает важное действие. Не смешивай состояния из разных моментов сцены. Если предмет по ходу сцены перешёл из рук в руки, реши, до или после передачи твой кадр. Из нескольких моментов бери тот, что читается с одного взгляда; в прыжке, сальто или трюке — устойчивый соседний: разбег, стойку или приземление, а не полёт.
- Момент должен узнаваться как именно этот эпизод: через место, крупные позы и состояние предметов. Просто присутствия людей в нужном месте мало. Кто продолжает работу (у замка, у стола, у раненого), тот описан у этой работы, с руками на её высоте, а не стоящим рядом.
- В people только те, кто есть в последней сцене; не добавляй людей, которых она не называет. Их не больше четырёх. Если в моменте их больше, выбери тесный ракурс, который естественно оставляет остальных за краем кадра; не показывай часть группы как всю группу. Толпу или прохожих, без которых место не узнать (перрон, кафе, улица), пиши одной фразой в background: далеко, мелко, без лиц и подробностей, без людей из списка. Толпа, которая прижимает людей кадра вплотную (давка в вагоне, очередь, зрители у сцены), — не фон: одного-двух из неё, кто прижат к ним, впиши в people ролью (commuter in a grey coat), хотя сцена и не называет их по отдельности, а то, чем и куда они давят, — в touches; в background тогда только те, кто дальше. Других людей на картинке не будет.
- Перед ответом проверь: кадр не меняет сторону травмы, владельца оружия, состояние двери, число щитов, мечей и других единственных предметов и то, кто что делает. Не добавляй действий, которых в сцене нет, ради более напряжённой позы.
- Точно сохраняй, КТО делает действие, какой рукой, какая сторона тела повреждена, у кого предмет и где точки контакта людей и предметов. left и right — стороны самого персонажа ("her own left forearm"); место в кадре называй отдельно: screen-left, screen-right. У лежащего и у стоящего спиной к камере руки и ноги называй ближней и дальней к камере (her near arm, his far leg), а не его left и right: их модель путает и дорисовывает лишнюю руку. Если сцене важно, какая это рука или нога (травма, повязка), реши, ближняя она или дальняя, и скажи обе стороны одной фразой ("her bandaged near arm, her own left").
- Прямые запреты и физические ограничения сцены обязательны: переведи их в видимую позу ("her bandaged left forearm stays folded against her chest, bearing no weight").
- Не передавай действие другому человеку: если в сцене запись отматывает председатель, то и в кадре это делает председатель; если в сцене никто ни на что не указывает, никто и не указывает. Не выдумывай подробностей позы, которых сцена не называет.
- Сохраняй, где кто находится, если сцена это говорит: на пороге, внутри комнаты, в середине, справа от другого, спиной к двери.
- Не добавляй свечение, магию, оружие, травмы и действия, которых нет в выбранном моменте. Наличие волшебного предмета не значит, что он светится.
- Прежде чем описывать людей, реши, как снять кадр, как решил бы режиссёр. point: по-английски, одной фразой, что в этом кадре главное: чьё чувство или какое действие должен увидеть зритель ("the girl's delight at the first snow", "the boy catching the falling vase"), а не чья-то внешность или фигура. camera: по-английски, одной фразой, откуда смотрит камера и почему: с какой стороны от людей и от того, что их разделяет или к чему они прижаты (стекло, дверь, стол, порог), и на какой высоте. Ставь камеру туда, откуда видно лицо того, чьё чувство главное, а если это важно, то и то, на что он смотрит или что делает. Например, человек прильнул к окну, разглядывая что-то снаружи: если главное его лицо, камера снаружи и смотрит на него сквозь стекло; если главное то, что он видит, камера внутри, за его плечом. Остальные поля пиши под это решение; shot называет только видимое: план, ракурс и откуда смотрит камера, без причин и чувств. point и camera в запрос для модели картинок не попадут.
- people: каждый человек, который должен быть виден, отдельной записью. who — имя из списка [${sheet.map(character => character.name).join(', ')}], если это он; иначе короткая роль по-английски ("salt worker"); если роль у двоих одна, добавь к ней место в кадре ("ninja on the left", "ninja on the right") и называй их так же в action и touches. Животное не человек: на котором едут или сидят — в action всадника ("rides a white winged horse"), остальные — в objects. on_screen — true, если человек виден только на экране (видеозвонок, телевизор, фотография), а в самом месте его нет; иначе false. blurred — true, если человек виден только сквозь матовое, запотевшее или мутное стекло, занавеску, пар или дым и лица его не разобрать; иначе false. Сквозь прозрачное стекло (окно автобуса или вагона, витрина) человек виден чётко: blurred — false; само стекло напиши в action, а если сцена прижимает к нему человека, то и чем и как сильно ("her palms pressed flat against the bus window, the fingertips whitening"). look: для людей из списка — ПУСТАЯ строка, их постоянную внешность подставит программа из листа внешности, и твой текст для них не будет использован; для остальных — пол, возраст словом (small child, child, teenager, young adult, middle-aged, elderly) по виду, а не по годам, цвет кожи, телосложение, волосы, без одежды; у ребёнка и подростка — без груди, бёдер и ягодиц. hair — причёска в этот момент, без цвета волос, если сцена её называет или она не та, что обычно (loose, wet, braided, under a hood); парик — его цветом, длиной, причёской и словом wig ("a short spiky blue wig hiding all of her own hair"); иначе пустая строка. face — одно выражение лица в этот момент, по сцене, а не по портрету, через глаза, рот и брови ("eyes squeezed shut with laughter, mouth wide open", "brows drawn together, lips pressed thin"), а не одним словом вроде happy и не двумя выражениями сразу; никогда не пустая строка.
- clothes_as_before: false для того, кого нет в списке одежды до этой сцены, и для всех, если такого списка нет; когда true, смотри ниже. clothes — во что человек одет В ЭТОТ МОМЕНТ, по-английски, фразой, которая начинается с wearing: вся одежда сверху донизу при любом плане, даже если край кадра её срежет, — верх, низ (брюки, юбка или шорты; у платья его длина) и обувь или босые ноги. У каждой вещи цвет и посадка (fitted, regular, loose), а у того, что застёгивается, — как застёгнуто, вместе с посадкой в одной фразе ("a white linen shirt buttoned up to the collarbone, roomy over the chest, tucked into the narrow waist of light jeans"); у вещи не по размеру — как она висит ("an oversized grey hoodie hanging loose to mid-thigh, the sleeves over the hands"). Костюм (косплей, маскарад, наряд героя игры или фильма) — по частям: каждая вещь с цветом и длиной, обувь, реквизит; без имени героя и названия костюма, их модель картинок не знает. Одежда по сцене: по погоде, месту и делу ("a raincoat in the rain", "running clothes on a run", "pyjamas in bed").${wornRule(sheet)}
- action — поза: сначала линия всего тела (stands upright, leans forward over the table, lies on her side, kneels, hangs from the bar by both hands), потом место в кадре (screen-left, screen-right, in the center) и в глубину (in the foreground, a step behind her, in the middle distance), потом руки и ноги; что держит и какой рукой — "holds X in her right hand", не точнее; повязки, шины и оружие в ножнах тоже здесь. Куда смотрит — направлением в кадре и с целью ("looks screen-right at the guard", "looks down at the pan"); в камеру — только если сцена об этом. Голову человек поворачивает не дальше профиля: чтобы посмотреть назад, он поворачивается плечами. Лежащему, который поднял голову, нужна опора под ней: локоть, подушка, чьи-то колени, свёрнутая куртка. Поза, которая держится на ногах или руках (лестница, турник, бег, танец), говорит, на что они опираются и на какой высоте ("both hands on the bar well above his head, his sneakers off the ground"). Сила — её настоящей величины ("pinches his cheek lightly, his mouth pulled a little to one side"), без растянутой кожи и вывернутых суставов. У человека одно дело: кто готовит у плиты, тот готовит, а обнимают его другие. Касаний других людей в action нет. Одна рука делает одно дело: рука, которая держит предмет, не участвует в касании, и наоборот; если в касании занята одна рука человека, скажи в его action, что делает другая.
- touches: каждое касание между людьми (держатся за руки, объятие, рука на плече, поцелуй) одной строкой: кто, какой своей рукой, кого и где ("the guard rests his right hand on the old man's left shoulder", у людей из списка имя вместо роли). Касание двоих — тоже одна строка: не пиши его второй раз со стороны другого. Общий жест двоих (дают пять, пожимают руки, складывают одну печать из двух рук) — одно касание: чья какая рука и как они сходятся ("the guard raises his right hand and the old man raises his left hand, the two palms pressed together between them"). Известную позу двоих (a slow waltz in closed hold, a princess carry, a piggyback ride, arm wrestling) пиши одной строкой: сначала оба и название позы, потом не больше двух уточнений, чья рука где ("the farmer and his wife dance a slow waltz in closed hold, his right hand on her shoulder blade, her left hand on his shoulder"). Касание троих и больше (общие объятия, куча-мала, двое тянут третьего) — одна строка, одна общая поза, которую легко представить ("the three of them lie in a heap at the foot of the stairs"), и в ней не больше двух уточнений, чья рука где. Команды и тягу в разные стороны пиши направлениями в кадре: кто с какой стороны и куда тянет ("the rope runs across the frame: the guard pulls toward screen-right, the three sailors toward screen-left"). В игре, где руки и ноги переплетаются (твистер), выбери одно скрещение, которое легко нарисовать, и напиши только его; остальные игроки — рядом. Касание может идти не от человека (руки из порталов, щупальца, ветви): напиши в той же строке, откуда оно тянется ("pale hands reach out of the portals and grip the man's wrists"), иначе модель приставит лишние руки людям. Пустой список, если никто никого не касается.
- shot: план и ракурс. План выбирай по тому, что должно влезть: все люди кадра до тех частей тела, на которых держится действие, с запасом над поднятыми руками и предметами до верхнего края кадра, и ноги с опорой, когда поза держится на них; не сжимай людей, чтобы влезли, бери план шире. Камеру ставь там, откуда видны лица: если один обнимает или несёт другого и кто-то из них оказался бы к камере спиной, бери вид спереди в три четверти. В тесной сцене с несколькими людьми бери средне-общий план в три четверти, а не эффектный нижний ракурс. Если кто-то виден только на экране, бери план через плечо того, кто смотрит, с небольшим экраном в кадре, или крупно сам экран.
- setting: место, по-английски, без людей и без названий, которые ничего не говорят глазу, и его устройство там, где на нём держатся позы: стол между теми, кто сидит друг напротив друга; куда и с какой стороны кадра ведёт дорога, тропа или лестница; что впереди и что сбоку. objects: важные предметы, которых никто не держит, и их состояние, и те, на которых или с которыми что-то делают (гамак, канат, турник, качели); предмет, которого модель может не знать, — тем, как он устроен: из чего, чем и к чему прикреплён ("a striped fabric hammock slung between two pine trunks, its rope ends tied round them"); пустая строка, если нечего. В background только люди: место — в setting, предметы — в objects.
- light: свет и время суток словами (morning, evening) и откуда свет, если сцена это называет (a desk lamp, the shop window), без часов и минут. Не называй дверь, проём или арку источником света: закрытая дверь должна остаться закрытой. Если дверь или окно в сцене закрыты, так и напиши в setting.
- Только то, что можно увидеть: без мыслей, реплик, предыстории. Без слов стиля, техники, качества (photorealistic, anime, 8k, cinematic). Возраст словами, не числом.`;

// In a story seen through a person's eyes (local/picture-pov.ts), the frame chooses whether to look through them: the
// owner, 2026-10-29, «Иногда лучше пов, челик мешает пейзажу... как будто гибрид нужен... для геммы», after the marks
// of the third stand gave the first-person pictures of somebody before the viewer the wrong figure in 2% against 23% of
// the usual view's and a wrong body as often, while a hug, a dance, a carry or a crowd broke the body in 14 first-person
// pictures of 27 against 2. The rule takes the words of the mode's own (`povRequest`) wherever they still hold, the
// viewer called «смотрящий» after the name, and names the last scene by its first words as that one does.
const eyesRule = (name: string, opening: string) => `
Смотрящий — ${name}. Последняя сцена — последний ответ рассказчика${opening ? `, тот, что начинается словами «${opening}…»` : ''}; кадр всегда из неё. Реши, как снять этот кадр: глазами смотрящего или со стороны, где он в кадре, как все.
- through_eyes: true, если смотрящий есть в последней сцене и она о том, что он видит: люди перед ним или рядом с ним (за столом напротив, на скамейке, ведут его за руку), кто-то на экране у него в руках, место или вид, которые он разглядывает. false, если она о том, что он делает телом вместе с другими (несёт кого-то, обнимает, танцует, подтягивается, борется, его тесно обступили), и если его в последней сцене нет.
- При false опиши кадр по правилам выше: смотрящий, если он в сцене, — в people, как все; viewer_clothes_as_before — false, viewer_clothes, viewer и reflection — пустые строки.
- При true смотрящий не человек, а камера на месте его глаз: кадр показывает то, что он видит в этот момент со своего места, при своей позе и туда, куда смотрит. Его нет в people, и ни в одном поле кадра (shot, setting, people, touches, background, objects, light, viewer, reflection, viewer_clothes) нет ни его имени, ни слов о нём как о человеке (the viewer, a man, a woman, he, she, they); вне этих полей его имя пиши, как обычно. Что он держит, пиши в viewer, а его касания других людей — в touches, и там и там только видимыми частями его тела ("hands at the bottom of the frame hold the cup"); каждую его руку один раз, там или там. Кто смотрит на него, протягивает ему что-то или берёт его за руку, делает это toward the camera ("the waiter reaches toward the camera and takes the hand at the bottom of the frame"). camera — с места его глаз: куда он смотрит и почему; правило о лице того, чьё чувство главное, тут не действует, его лицо не видно, и чувство показывает то, что он видит. shot — вид от первого лица с высоты его глаз и куда направлен взгляд ("first-person view at eye level, looking across the table"). viewer — по-английски, только те части его тела, которые он сам видит при этой позе и этом взгляде, обрезанные краем кадра и в перспективе: кисти и предплечья, колени и ноги, в его рукавах, штанинах и обуви, и то, что он держит; без лица, волос и фигуры; пустая строка, если ничего не видно. reflection — его отражение, если перед его глазами зеркало, вода или стекло: где оно в кадре и что делает; иначе пустая строка. viewer_clothes_as_before — по правилу clothes_as_before выше, по его строке в списке одежды до этой сцены; при true программа сама возьмёт ту строку. viewer_clothes — во что он одет, фразой, которая начинается с wearing, по правилам одежды выше.`;

const str = { type: 'string' };
// What matters in the picture and where the camera stands for it first, as a director would choose before the rest
// (the owner, 2026-10-29: «что думаешь об добавление этапа режисирования в бота? Что бы картинки нормальными и
// эффективными были... когда персонаж прислоняется из увлечение к окну режисер выбирает показать изнутри или улицы»),
// then the shot and the place, then the people, so that each touch is written knowing who is there, and those far
// behind them after both. The two choices stay out of the picture's prompt.
const LEAN_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['point', 'camera', 'shot', 'setting', 'people', 'touches', 'background', 'objects', 'light'], properties: {
  point: str, camera: str, shot: str, setting: str,
  people: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false,
    required: ['who', 'on_screen', 'blurred', 'look', 'hair', 'clothes_as_before', 'clothes', 'face', 'action'],
    properties: { who: str, on_screen: { type: 'boolean' }, blurred: { type: 'boolean' }, look: str, hair: str, clothes_as_before: { type: 'boolean' },
      clothes: str, face: str, action: str } } },
  touches: { type: 'array', maxItems: 4, items: str },
  background: str, objects: str, light: str } };
// With a viewer, whether the frame looks through their eyes right after what matters in it, so that the camera, the
// shot and the people are written knowing it, and what they wear, what of them is in view and their reflection after
// the rest, as local/picture-pov.ts asks.
const { point, ...framed } = LEAN_SCHEMA.properties;
const EYES_SCHEMA = { ...LEAN_SCHEMA, required: ['point', 'through_eyes', ...LEAN_SCHEMA.required.slice(1), 'viewer_clothes_as_before', 'viewer_clothes', 'viewer', 'reflection'],
  properties: { point, through_eyes: { type: 'boolean' }, ...framed, viewer_clothes_as_before: { type: 'boolean' }, viewer_clothes: str, viewer: str, reflection: str } };
// Room for the faces, the hairstyles, the touches and the background, less the moment and the props, and since
// 2026-10-29 for whole outfits with how they sit, depth and gaze, the director's two phrases, whether each person wears
// what they wore, and a margin; with a viewer, the room the four fields of their own take in local/picture-pov.ts.
const LEAN_TOKENS = 400;
const EYES_TOKENS = 250;

// One lean frame of the last scene of `context`, shaped as local/illustrate.ts `frameRequest` shapes the usual one, and
// with `viewer`, the person the story is seen through, the frame that may look through their eyes.
export function leanRequest(context: Excerpt, sheet: Character[], viewer?: Character): ModelRequest {
  const opening = openingOf(context.messages);
  const asked = instruction(sheet, opening) + (viewer ? eyesRule(viewer.name, opening) : '');
  return { system: context.system, maxOutputTokens: DESCRIBE_TOKENS + LEAN_TOKENS + (viewer ? EYES_TOKENS : 0),
    outputSchema: viewer ? EYES_SCHEMA : LEAN_SCHEMA, messages: [...context.messages, { role: 'user', content: asked }] };
}

const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

// The answer to `leanRequest` as a frame, whatever of it parsed: a field that is missing or not a string is empty, and
// a touch written twice word for word is one. `eyes` when the answer chose to look through the viewer's eyes. A person
// of `sheet` whom the answer says wears what they wore wears their line there word for word: told to repeat it, the
// card's frames of 2026-10-29 still dressed a young man anew fifteen minutes into the same morning, twice, and kept a
// young woman back from the ice rink in December in the summer's shorts. `viewer`, seen through, likewise.
export function leanOf(value: Record<string, unknown>, sheet: Character[] = [], viewer?: Character): LeanDescription {
  const names = sheet.map(character => character.name);
  const people = (Array.isArray(value.people) ? value.people : []).slice(0, 4).map(one => {
    const person = (one ?? {}) as Record<string, unknown>;
    const name = person.clothes_as_before === true ? matchSheet(text(person.who), names) : null;
    const before = name === null ? '' : sheet.find(character => character.name === name)?.outfit?.trim() ?? '';
    return { who: text(person.who), look: text(person.look), hair: text(person.hair), clothes: before || text(person.clothes), face: text(person.face),
      state: '', action: text(person.action), onScreen: person.on_screen === true, blurred: person.blurred === true };
  });
  const touches = [...new Set((Array.isArray(value.touches) ? value.touches : []).map(text).filter(Boolean))];
  const worn = value.viewer_clothes_as_before === true ? viewer?.outfit?.trim() ?? '' : '';
  const eyes = value.through_eyes === true ? { clothes: worn || text(value.viewer_clothes), body: text(value.viewer), reflection: text(value.reflection) } : undefined;
  return { moment: '', props: '', shot: text(value.shot), setting: text(value.setting), objects: text(value.objects),
    light: text(value.light), people, touches, background: text(value.background), ...eyes ? { eyes } : {} };
}

// A lean frame of a story seen through `viewer`'s eyes, as local/picture-pov.ts `seenBy` makes the usual one. `seen`
// when the answer chose the eyes: then the viewer leaves `people`, which keeps their portrait out of the frame, every
// field loses their name ("the camera", and their possessive "the") and the words "the viewer", and the first-person
// clause takes the shot's place. `dressed` is what the clothes are read from for the next picture, with the viewer in
// what the answer says they wear. A frame from outside comes back as it was, the viewer among its people like anybody.
export function leanSeen(description: LeanDescription, viewer: Character): { description: LeanDescription; dressed: Description; seen: boolean } {
  const { eyes, ...plain } = description;
  if (!eyes) return { description: plain, dressed: plain, seen: false };
  const own = (person: LeanPerson) => matchSheet(person.who, [viewer.name]) !== null || /^(?:the )?viewer$/i.test(person.who);
  const camera = (value: string) => unnamed(stripNames(value ?? '', [viewer.name], (_, found) => /'s$/i.test(found) ? "the camera's" : 'the camera').text)
    .replace(/\b(t)he camera's\s+/gi, '$1he ');
  const others = plain.people.filter(one => !own(one)).map(one => ({ ...one, look: camera(one.look), hair: camera(one.hair),
    clothes: camera(one.clothes ?? ''), face: camera(one.face), action: camera(one.action) }));
  const clothes = eyes.clothes || plain.people.find(own)?.clothes || viewer.outfit || '';
  const seen = { ...plain, ownShot: plain.shot, people: others, touches: plain.touches.map(camera), setting: camera(plain.setting), objects: camera(plain.objects),
    light: camera(plain.light), background: camera(plain.background), shot: firstPerson(camera(plain.shot), camera(eyes.body), camera(eyes.reflection)) };
  return { description: seen, dressed: { ...seen, people: [...others, { who: viewer.name, look: '', clothes, state: '', action: '' }] }, seen: true };
}

// The people a lean frame binds portraits to: those in the place itself, and clear to see. With a portrait, a person the
// scene showed only on a screen was drawn in the room: eight Qwen pictures of twelve contradicted their screen scene.
// One behind frosted glass would be drawn sharp from it. `views` as in `frameReferences`.
export function leanReferences(story: Story, description: LeanDescription, views?: PoseViews) {
  return frameReferences(story, { ...description, people: description.people.filter(one => !one.onScreen && !one.blurred) }, views);
}

// The noun of a look's opening clause, which names the person where the frame names them: "A slim young man of
// eighteen" is the young man. Empty when the clause has none of these words.
const NOUN = /\b(?:(young adult|young|middle-aged|elderly|old|little|teenage)\s+)?(man|woman|boy|girl|child|teenager|lady|adult|person)\b/i;
function nounOf(look: string): string {
  const found = NOUN.exec(look.split(',')[0]);
  if (!found) return '';
  const age = found[1]?.toLowerCase();
  return [age === 'young adult' ? 'young' : age, found[2].toLowerCase()].filter(Boolean).join(' ');
}
// The clause of a look that names the hair, as far as the word itself: its colour, length and texture, not its style.
const cutAtHair = (clause: string) => clause.replace(/^(.*?\bhair\b).*$/i, '$1');
// The words that join a person to their hair in a clause of a look: "A young woman with long blonde hair", "sporting",
// "having", "framed by".
const JOIN = /\b(?:with|sporting|having|framed by)\s+/i;
// The hair of a look, and nothing else of its clause: "with blue eyes and long blonde hair" is long blonde hair.
const hairOf = (look: string) => cutAtHair(look.split(/,\s*/).find(clause => /\bhair\b/i.test(clause)) ?? '').split(JOIN).at(-1)!
  .split(/\s+and\s+/i).filter(part => /\bhair\b/i.test(part)).join(' and ').trim();
// A clause of a look without its hair: "A young woman with blue eyes and long blonde hair" is a young woman with blue
// eyes, and a clause that is the hair alone is nothing.
function withoutHair(clause: string): string {
  const join = JOIN.exec(clause);
  const head = (join ? clause.slice(0, join.index) : clause).trim();
  if (/\bhair\b/i.test(head)) return '';
  const kept = join ? clause.slice(join.index + join[0].length).split(/\s+and\s+/i).filter(part => !/\bhair\b/i.test(part)) : [];
  return kept.length ? `${head} with ${kept.join(' and ')}` : head;
}
// Where an action puts a person, in the instruction's words: screen-left is on the left.
const PLACES: [RegExp, string][] = [[/\bscreen[- ]left\b/i, 'on the left'], [/\bscreen[- ]right\b/i, 'on the right'], [/\bin the cent(?:er|re)\b/i, 'in the center']];
const placeOf = (action: string) => PLACES.find(([pattern]) => pattern.test(action))?.[1] ?? '';
// A look whose hairstyle the scene replaces: its first clause that names the hair keeps it as far as that word, the
// scene's hairstyle follows there, and any later clause of the hair goes ("thick pearl-platinum hair in a high
// ponytail" with the scene's "loose and wet" is thick pearl-platinum hair loose and wet). A look that names no hair
// gets the hairstyle as a clause of its own. A wig hides the hair: it stands where the hair was, after what that clause
// says besides the hair ("A young woman with long blonde hair" keeps the young woman), and no clause of the hair stays.
function restyled(look: string, hair: string): string {
  const style = hair.replace(/^(?:(?:her|his|their)\s+)?hair\s+(?:is\s+|are\s+)?/i, '').trim();
  const clauses = look.split(/,\s*/).filter(Boolean);
  const at = clauses.findIndex(clause => /\bhair\b/i.test(clause));
  const wig = /\bwig\b/i.test(style);
  if (!style) return look;
  if (at < 0) return [...clauses, wig ? style : `hair ${style}`].join(', ');
  return clauses.flatMap((clause, index) => index === at ? wig ? [withoutHair(clause), style].filter(Boolean) : [`${cutAtHair(clause)} ${style}`]
    : /\bhair\b/i.test(clause) ? [] : [clause]).join(', ');
}
// What of a look shows through frosted glass: who it is, in the words of `nounOf` alone, and the hair as far as the
// word, or the wig the scene puts on them. Nothing of a face, and a person where the look says nothing else.
function blurredLook(look: string, hair: string): string {
  const noun = nounOf(look);
  return [noun ? `${/^[aeiou]/i.test(noun) ? 'An' : 'A'} ${noun}` : '', /\bwig\b/i.test(hair) ? hair : hairOf(look)].filter(Boolean).join(', ') || 'A person';
}

const phrase = (value: string) => value.trim().replace(/\.$/, '').trim();
const sentence = (value: string) => {
  const one = phrase(value);
  return one ? `${one.charAt(0).toUpperCase()}${one.slice(1)}. ` : '';
};
const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('');
const COUNTS = ['no', 'one', 'two', 'three', 'four'];

// The reference instruction, in one sentence where the usual frame has three (local/picture-references.ts
// `referencePrompt`): the same parts of a person kept and the rest taken from the text, with the medium named once, first.
const RULE = (line: string) => `Create a brand-new scene${line ? ' in this medium and style' : ''}. The reference images are identity `
  + 'sources only: keep each referenced person\'s face, hair color, skin, age, body proportions and relative body volumes, without '
  + 'slimming, enlarging, aging or idealizing them, and take their clothes, hairstyle, pose, expression, place, light and framing from '
  + 'the text below, never from the images.';

// The prompt of a lean frame, with the portraits of `bound` (`leanReferences`, or a saved recipe's) or none. The shot,
// the place, how many people there are and by which words, each person once, each touch once, the free objects, the
// light, and the style line: first, after nothing, when there are portraits, and last, where the six steps measured it,
// when there are none. A person of the sheet takes the sheet's look, as in local/illustrate.ts `assemblePrompt`, with
// the hairstyle of the scene in place of the sheet's, and the frame's clothes or else those they wore before. A name
// in any field becomes the words of that person, a possessive kept, and a name of somebody the frame does not show
// becomes "someone", where the usual net writes "the figure"; only those count as names stripped. A person seen through
// frosted glass keeps of the look only who they are and the hair or the wig, has no face and no portrait and is said
// to be a blur, and the style line loses "Clear silhouettes." (`line`, the line as the prompt carries it).
export function leanPrompt(frame: { description: LeanDescription; sheet: Character[] }, bound: { name: string }[], given: string): Assembled {
  const { description, sheet } = frame;
  const looks = sheetLooks(sheet);
  const outfits = new Map(sheet.map(character => [character.name.trim().toLowerCase(), character.outfit ?? '']));
  const sheetNames = sheet.map(character => character.name);
  // The names of strangers, as `assemblePrompt` tells them from roles: one capitalised word that is not on the sheet.
  const stranger = (who: string) => who.length > 1 && !/\s/.test(who) && /^\p{Lu}/u.test(who) && matchSheet(who, sheetNames) === null;
  // A person of the sheet whom the answer lists twice is drawn once, as their clothes are kept once (local/picture.ts
  // `clothesOf`).
  const seen = new Set<string>();
  const people = (description.people ?? []).map(person => {
    const who = (person.who ?? '').trim();
    const name = matchSheet(who, sheetNames);
    const key = name === null ? undefined : name.trim().toLowerCase();
    const known = key === undefined ? undefined : looks.get(key);
    const slot = name === null || person.onScreen || person.blurred ? -1 : bound.findIndex(one => one.name === name);
    const look = stripAges(known ?? person.look ?? '');
    const role = name === null && !stranger(who) ? who.toLowerCase().replace(/^(?:the|a|an)\s+/, '') : '';
    // A wig hides the hair that would tell them apart, and tells them apart itself, as far as the word.
    const wig = /\bwig\b/i.test(person.hair ?? '') ? stripNames(stripAges(person.hair ?? ''), sheetNames).text.replace(/^(.*?\bwig\b).*$/i, '$1').trim() : '';
    return { person, who, name, key, known, slot, label: slot >= 0 ? `the person from image ${slot + 1}` : `the ${role || nounOf(look) || 'person'}`,
      hair: wig || hairOf(look) };
  }).filter(one => one.name === null || (!seen.has(one.name) && !!seen.add(one.name)));
  // Two people the same words would name are told apart by their places in the frame where the actions give each its
  // own, and else by their hair, as far as the look gives it.
  const clashes = Map.groupBy(people.filter(one => one.slot < 0 && people.some(other => other !== one && other.label === one.label)), one => one.label);
  for (const group of clashes.values()) {
    const places = group.map(one => placeOf(one.person.action ?? ''));
    const apart = places.every(Boolean) && new Set(places).size === group.length;
    group.forEach((one, at) => { if (apart) one.label = `${one.label} ${places[at]}`; else if (one.hair) one.label = `${one.label} with ${one.hair}`; });
  }
  const labels = new Map<string, string>();
  for (const one of people) {
    if (one.name !== null) labels.set(one.name, one.label);
    else if (stranger(one.who)) labels.set(one.who, one.label);
  }
  const names = [...sheetNames, ...people.filter(one => stranger(one.who)).map(one => one.who)];
  let namesStripped = 0;
  let fromSheet = 0;
  let withoutLook = 0;
  const clean = (value: string) => stripNames(stripAges(value ?? ''), names, (name, found) => {
    const label = labels.get(name);
    const own = /'s$/i.test(found) ? "'s" : '';
    if (label === undefined) { namesStripped++; return `someone${own}`; }
    return `${label}${own}`;
  }).text;
  const lines = people.map(one => {
    if (one.known) fromSheet++;
    const whole = phrase(clean(one.known ?? one.person.look ?? ''));
    const blurred = one.person.blurred && !one.person.onScreen;
    const hair = phrase(clean(one.person.hair ?? ''));
    const look = blurred ? blurredLook(whole, hair) : restyled(whole, hair);
    if (!look) withoutLook++;
    const clothes = phrase(clean(one.person.clothes ?? '')) || (one.key === undefined ? '' : phrase(clean(outfits.get(one.key) ?? '')));
    const before = [one.slot >= 0 ? `The person from image ${one.slot + 1}` : '', look, clothes,
      blurred ? 'seen only as a soft, featureless blur, the shape and colors showing through' : clean(one.person.face ?? ''),
      one.person.onScreen ? 'seen only as a small video image on a screen and not physically present' : ''].map(phrase).filter(Boolean).join(', ');
    const action = phrase(clean(one.person.action ?? ''));
    return sentence(before && action ? `${before}: ${action}` : before || action);
  }).join('');
  const present = people.filter(one => !one.person.onScreen).map(one => one.label);
  const shown = people.filter(one => one.person.onScreen).map(one => one.label);
  // With people far behind, the count is of the foreground, and they follow it.
  const behind = phrase(clean(description.background ?? ''));
  const count = [present.length ? `Exactly ${COUNTS[present.length] ?? present.length} ${present.length === 1 ? 'person' : 'people'} in the ${behind ? 'foreground' : 'picture'}: ${listed(present)}` : '',
    shown.length ? `${present.length ? 'Besides them, only' : 'Only'} on a screen: ${listed(shown)}` : '',
    behind ? `Far in the background, small: ${behind.charAt(0).toLowerCase()}${behind.slice(1)}` : ''].map(sentence).join('');
  const body = sentence(clean(description.shot)) + sentence(clean(description.setting)) + count + lines
    + (description.touches ?? []).map(touch => sentence(clean(touch))).join('') + sentence(clean(description.objects)) + sentence(clean(description.light));
  // Of the card's 24 scenes behind frosted or fogged glass none came out with the blur asked for, and the line's last
  // sentence asks for the opposite.
  const line = people.some(one => one.person.blurred && !one.person.onScreen) ? given.replace(/\s*\bClear silhouettes\.(?=\s|$)/, '').trim() : given;
  const prompt = bound.length ? `${line ? `${line} ` : ''}${RULE(line)} ${body}` : body + line;
  return { prompt: prompt.trimEnd(), namesStripped, fromSheet, withoutLook, ...line === given ? {} : { line } };
}
