// The language test of the portraits (docs/action-experiment.md#t-probe-lang), fixed before any card: three made-up
// people, each described once in English and once in Russian, sentence for sentence, in the order the sheet writes
// `details` (local/illustrate.ts `SHEET`): sex and age as a word, skin, height and build, hair, face, and permanent
// marks with their side, the person's own. The owner decided on 2026-09-26 that the bot draws a portrait from the
// reader's `details` exactly as written, in any language, with no translation; the T probe (local/image-t-probe.ts)
// draws each text as the bot draws a portrait, and the owner compares the two portraits of each person. `id` names a
// person in the probe's files and on its page. `name` is the sheet's, which a portrait strips from its text: it
// appears in no text, so that the two prompts of a person differ in the language of the text alone. Nothing here is
// anybody's story, and all of it may be shown and sent.
export type LanguagePerson = { id: string; name: string; en: string; ru: string };

export const PORTRAIT_LANGUAGES: LanguagePerson[] = [
  {
    id: 'girl', name: 'Ярина',
    en: 'A girl, a child, with light olive skin. Small and slight for her age, thin arms and legs. Straight dark brown hair to her shoulders with a blunt fringe. A round face with full cheeks, thick straight brows, large dark brown eyes, a small upturned nose and thin lips. A gap where a front tooth is missing. A small brown birthmark on her left cheek below the eye.',
    ru: 'Девочка со светлой оливковой кожей. Маленькая и хрупкая для своего возраста, тонкие руки и ноги. Прямые тёмно-каштановые волосы до плеч с ровной чёлкой. Круглое лицо с пухлыми щеками, густые прямые брови, большие тёмно-карие глаза, маленький вздёрнутый нос и тонкие губы. Щербинка на месте выпавшего переднего зуба. Небольшое коричневое родимое пятно на левой щеке под глазом.',
  },
  {
    id: 'elder', name: 'Тимофей',
    en: 'A man, elderly, with deep brown skin. Tall and lean, slightly stooped, long bony hands. Short tightly curled white hair, receding at the temples, and a short white beard. A long narrow face with deep lines across the forehead and around the mouth, heavy grey brows, deep-set dark eyes, a broad nose and full lips. A pale scar across the bridge of his nose and a missing tip of the right little finger.',
    ru: 'Пожилой мужчина с тёмно-коричневой кожей. Высокий и сухощавый, слегка сутулый, длинные костлявые кисти рук. Короткие туго вьющиеся седые волосы с залысинами на висках и короткая седая борода. Длинное узкое лицо с глубокими морщинами на лбу и вокруг рта, густые серые брови, глубоко посаженные тёмные глаза, широкий нос и полные губы. Бледный шрам поперёк переносицы, у правого мизинца нет кончика.',
  },
  {
    id: 'redhead', name: 'Ванда',
    en: 'A woman, young adult, with pale freckled skin. Short and stocky, broad shoulders, strong arms. Bright copper-red hair, thick and wavy, shaved on the left side and falling past the chin on the right. A square face with a strong jaw, sparse light brows, pale green eyes, a crooked nose that was once broken and a wide mouth. A tattoo of black ivy leaves climbing the right side of her neck.',
    ru: 'Молодая женщина с бледной веснушчатой кожей. Невысокая и коренастая, широкие плечи, сильные руки. Ярко-рыжие медные волосы, густые и волнистые, слева выбриты, справа спадают ниже подбородка. Квадратное лицо с массивной челюстью, редкие светлые брови, светло-зелёные глаза, кривой, когда-то сломанный нос и широкий рот. Татуировка из чёрных листьев плюща поднимается по правой стороне шеи.',
  },
];
