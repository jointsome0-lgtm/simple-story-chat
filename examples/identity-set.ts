// The fixed synthetic set of the identity measurement (docs/identity-experiment.md#identity-runbook): one story,
// its character sheet and eight frames, written here before any card is rented, so that nothing about the set is
// chosen after a picture has been seen. `npm run image:identity -- set` writes it as a prompts directory, and each
// frame is drawn in three arms from two seeds: 48 pictures.
//
// What the frames cover, each on purpose:
//   - figures a face does not carry: a very muscular, heavy man (Бран), a slight, thin woman (Ива), and a very tall
//     man beside a very short one (Тимофей, Кузьма). Both pairs meet in frame 2 and again in the swapped order, in
//     frames 4 and 5. No frame text says who is big or small: in arm C a bound person's look is gone, and the figure
//     has to come from the portrait alone, which is the owner's question;
//   - two women who look alike on purpose (Вера, Лада: the same height, build and hair, told apart by the fringe, the
//     eyes, a mole and freckles), together in frame 3 and swapped in frame 6;
//   - one, two and four portraits in a frame, and in frame 7 a ferryman nobody drew a portrait of, standing between
//     the two women: the binding stops at him, so Лада after him keeps her look in every arm;
//   - clothes the story changes (frames 1, 4 and 6), a new pose and a new place in every frame. No frame dresses anybody
//     as the portraits are dressed (local/image-portraits.ts, a white tank top and dark grey trousers), so a change that
//     shows is the text's and not the portrait's.
// Everything is synthetic and safe to send to a hosted model; nothing here is adult.
import type { Character, Description } from '../local/illustrate.ts';

export const IDENTITY_STORY = 'troupe';
// The second seed is an independent repeat of the first, never a second chance for a cell.
export const IDENTITY_SEEDS = [7, 11];
// The smoke the paid run starts with: the frame with one portrait and a frame with four, which is the most memory
// the set asks of the card. A failure of memory or of geometry there stops the measurement before the main set.
export const IDENTITY_SMOKE = ['troupe-1', 'troupe-2'];
// The text-to-image control, drawn once after the main set at the first seed and counted as cost only: one first
// frame and two after it, by the rule the arms follow, where an arm's first frame is its first cell.
export const IDENTITY_CONTROL = ['troupe-1', 'troupe-2', 'troupe-3'];
// Whose portrait each frame sends, in slot order, once all six are drawn: what local/image-batch.ts `bindingPlan` has
// to find, checked before the smoke. Frame 7 binds Вера alone, because the ferryman stops the binding.
export const IDENTITY_BINDING: Record<string, string[]> = {
  'troupe-1': ['Бран'], 'troupe-2': ['Бран', 'Ива', 'Тимофей', 'Кузьма'], 'troupe-3': ['Вера', 'Лада'],
  'troupe-4': ['Ива', 'Бран'], 'troupe-5': ['Кузьма', 'Тимофей'], 'troupe-6': ['Лада', 'Вера'], 'troupe-7': ['Вера'],
  'troupe-8': ['Вера', 'Кузьма', 'Лада', 'Тимофей'],
};

// The sheet as local/illustrate.ts shapes one: the look is the body, the face and the permanent bearing, the outfit
// what the person wears unless a frame says otherwise.
export const identitySheet: Character[] = [
  { name: 'Бран', look: 'A middle-aged man of huge heavy build, massive muscled shoulders, chest and arms, thick neck, shaved head, full red beard, pale scar across the left cheek, grim menacing bearing',
    outfit: 'wearing a sleeveless brown leather jerkin, dark wool trousers and heavy boots' },
  { name: 'Ива', look: 'A young adult woman, very slight and thin, narrow shoulders, thin arms and wrists, small pointed face, large dark eyes, short cropped black hair',
    outfit: 'wearing a short red wool tunic over grey leggings and soft ankle boots' },
  { name: 'Тимофей', look: 'A young adult man, very tall and lanky, long thin limbs, slightly stooped shoulders, long narrow face, crooked nose, curly light-brown hair, clean-shaven',
    outfit: 'wearing a mustard-yellow jacket over a white shirt, black trousers and boots' },
  { name: 'Кузьма', look: 'An elderly man, very short and stocky, round belly, bald crown, long white braided beard, bushy white eyebrows, ruddy round cheeks',
    outfit: 'wearing a green quilted waistcoat over a white shirt, brown breeches and buckled shoes' },
  { name: 'Вера', look: 'A young adult woman of average height and slim build, long straight chestnut hair with a straight fringe, oval face, green eyes, a small mole above the upper lip',
    outfit: 'wearing a dark green dress with a white collar and a narrow belt' },
  { name: 'Лада', look: 'A young adult woman of average height and slim build, long straight chestnut hair parted in the middle, oval face, grey eyes, light freckles across the nose',
    outfit: 'wearing a dark blue dress with a white collar and a narrow belt' },
];

export type IdentityFrame = { id: string; scene: string; description: Description };
// A person of the sheet with the sheet's clothes, or with clothes of this frame.
const cast = (who: string, action: string, clothes = '') => ({ who, look: '', clothes, state: '', action });

export const identityFrames: IdentityFrame[] = [
  { id: 'troupe-1', scene: 'После метели Бран вышел во двор постоялого двора в одной льняной рубахе и колет дрова: топор занесён над головой, у колоды растёт гора поленьев.',
    description: { shot: 'Medium-wide shot at eye level, three-quarter view', setting: 'A snowy inn yard with a woodpile and a stone well, snow on the roofs',
      moment: 'The man is about to split a log on the chopping block',
      people: [cast('Бран', 'raises an axe above his head with both hands, a log standing on the chopping block in front of him',
        'wearing a faded blue linen shirt with rolled-up sleeves, brown wool trousers and heavy boots')],
      objects: 'A pile of split logs beside the chopping block', props: 'The man holds the only axe with both hands.',
      light: 'Cold morning light after a snowstorm' } },
  { id: 'troupe-2', scene: 'На рассвете труппа грузит фургон. Бран поднимает сундук с костюмами, Ива сидит на козлах с вожжами, Тимофей подаёт ей свёрнутый задник, а Кузьма стоит рядом с ним и сверяет список.',
    description: { shot: 'Wide shot at eye level showing all four people and the wagon', setting: 'A muddy inn courtyard with a painted theatre wagon',
      moment: 'The troupe loads the wagon before leaving',
      people: [cast('Бран', 'stands screen-left at the back of the wagon, lifting a large wooden chest onto it'),
        cast('Ива', 'sits on the driver\'s bench of the wagon, holding the reins in both hands'),
        cast('Тимофей', 'stands beside the wagon, passing a rolled painted canvas up toward the bench'),
        cast('Кузьма', 'stands screen-right beside the man with the canvas, reading a paper list held in both hands')],
      objects: 'A painted theatre wagon with trunks on it', props: 'The man at the back of the wagon holds the one wooden chest; the woman on the bench holds the reins; the man beside the wagon holds the rolled canvas; the man at screen-right holds the paper list.',
      light: 'Grey dawn light' } },
  { id: 'troupe-3', scene: 'В пустом амбаре Вера и Лада репетируют. Вера держит маску лисы и повторяет монолог, Лада сидит на краю сцены с тетрадью роли.',
    description: { shot: 'Medium shot at eye level', setting: 'A wooden stage built in an empty barn, hay bales behind it',
      moment: 'Two actresses rehearse on the stage',
      people: [cast('Вера', 'stands screen-left at the front of the stage, holding a fox mask in her right hand at chest height'),
        cast('Лада', 'sits screen-right on the edge of the stage, reading a notebook held open on her knees')],
      objects: 'A fox mask; an open notebook', props: 'The standing woman holds the only fox mask in her right hand; the seated woman holds the notebook with both hands.',
      light: 'Warm afternoon light through gaps in the barn walls' } },
  { id: 'troupe-4', scene: 'Вечером у реки Ива, переодевшись в серый вязаный свитер, штопает плащ, сидя на перевёрнутой бочке. Бран стоит за ней с двумя вёдрами воды.',
    description: { shot: 'Medium-wide shot at eye level', setting: 'A grassy river bank with reeds and a wooden jetty',
      moment: 'The two rest by the river after fetching water',
      people: [cast('Ива', 'sits screen-left on an upturned barrel, sewing a patch onto a folded cloak in her lap',
        'wearing a grey knitted sweater, brown trousers and soft ankle boots'),
        cast('Бран', 'stands screen-right behind her, holding a full wooden bucket in each hand')],
      objects: 'An upturned barrel; two wooden buckets of water; a folded cloak', props: 'The seated woman holds a needle and the folded cloak; the standing man holds one bucket in each hand.',
      light: 'Dusk, an orange sky over the river' } },
  { id: 'troupe-5', scene: 'Под моросящим дождём Кузьма ведёт лошадь под уздцы по деревенской улице, а Тимофей идёт следом с мотком верёвки на плече.',
    description: { shot: 'Wide shot at eye level along the street', setting: 'A narrow village street with wet cobbles and a tavern',
      moment: 'Two men walk a horse down the street in the rain',
      people: [cast('Кузьма', 'walks screen-left, leading a brown horse by the bridle with his right hand'),
        cast('Тимофей', 'walks screen-right behind him, carrying a coil of rope on his left shoulder')],
      objects: 'A brown horse; a coil of rope', props: 'The man in front holds the horse\'s bridle in his right hand; the man behind carries the coil of rope on his left shoulder.',
      light: 'Grey overcast daylight, light rain' } },
  { id: 'troupe-6', scene: 'За кулисами перед премьерой Лада, уже в белом платье Снегурочки, поправляет перед зеркалом венец, а Вера в красном кафтане скомороха затягивает жёлтый кушак.',
    description: { shot: 'Medium shot at eye level', setting: 'A cramped backstage room with a tall mirror, a costume rack and an oil lamp on a table',
      moment: 'Two actresses finish dressing before a performance',
      people: [cast('Лада', 'stands screen-left in front of the tall mirror, adjusting her headband with both hands',
        'wearing a long white costume dress embroidered with silver and a silver headband'),
        cast('Вера', 'stands screen-right beside the costume rack, tying a yellow sash around her waist',
          'wearing a red jester caftan with yellow trim and red trousers')],
      objects: 'A tall mirror; a costume rack; an oil lamp', props: 'The woman at the mirror touches only her headband; the woman at the rack holds the yellow sash with both hands.',
      light: 'Warm lamplight' } },
  { id: 'troupe-7', scene: 'Туман над рекой. Старый паромщик тянет канат парома; Вера стоит слева у перил, Лада справа сидит на мешке с реквизитом и держит сложенную карту.',
    description: { shot: 'Wide shot at eye level from the river bank', setting: 'A flat wooden river ferry in thick fog, a guide rope stretched across the water',
      moment: 'A ferryman pulls the ferry across the river with two passengers',
      people: [cast('Вера', 'stands screen-left at the ferry railing, looking at the water'),
        { who: 'ferryman', look: 'An elderly man, lean and weathered, long white hair tied back, deep-set eyes',
          clothes: 'wearing a patched grey oilskin coat and a wide-brimmed hat', state: '',
          action: 'stands in the middle of the ferry, pulling the guide rope hand over hand' },
        cast('Лада', 'sits screen-right on a sack of props, holding a folded map')],
      objects: 'A thick guide rope; sacks of props', props: 'The ferryman holds the guide rope with both hands; the seated woman holds the folded map; the woman at the railing has empty hands.',
      light: 'Diffuse white morning light in the fog' } },
  { id: 'troupe-8', scene: 'Ночной привал в лесу. У костра Вера помешивает котелок, Кузьма греет руки, Лада подкладывает хворост, а Тимофей стоит, прислонившись к дереву, и настраивает лиру.',
    description: { shot: 'Wide shot at eye level around the campfire', setting: 'A forest clearing at night with a campfire and a cooking pot on an iron tripod',
      moment: 'Four members of the troupe gather around the campfire',
      people: [cast('Вера', 'kneels screen-left by the fire, stirring the pot with a wooden spoon'),
        cast('Кузьма', 'sits on a log, holding his open hands toward the fire'),
        cast('Лада', 'crouches beside him, laying a bundle of dry branches on the fire'),
        cast('Тимофей', 'stands screen-right leaning against a tree, tuning a small wooden lyre held against his chest')],
      objects: 'A campfire; a cooking pot on an iron tripod; a bundle of branches', props: 'The kneeling woman holds the only wooden spoon; the crouching woman holds the bundle of branches; the man at the tree holds the lyre; the seated man\'s hands are empty.',
      light: 'Night, warm firelight from below' } },
];
