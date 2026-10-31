// What a reader thinks of a picture, for the readers of SIMPLE_CHAT_RATING_USERS, on the owner's word of 2026-11-01:
// «Давай лучше через 👍/👎». Nobody reads a reader's stories, so a press is the only way to learn how a frame came out
// (docs/telegram-ui.md#picture-rating). It is one row of the log and nothing else: the thumb, a reason from a fixed list
// and the number of the picture's own row (`pictureRef`), by which the two are read together. No story, scene, prompt or
// picture is in that row, and nothing goes into the reader's library.
import { RATING_REASONS, member } from './model-error.ts';
import type { InlineButton, InlineKeyboard } from './telegram.ts';
import type { Messages } from './text.ts';

// A picture's number: 31 random bits, drawn for it alone, and kept nowhere but in its row and its buttons.
export const PICTURE_REFS = 2 ** 31;

type Pressed = 'up' | 'down' | typeof RATING_REASONS[number];
export type RatingPress = { ref: number; value: Pressed; storyId: string; nodeId: string };

// The buttons of a note under a picture: the variant's for everybody, as ever, and with a number the thumbs above it.
// A thumb down opens the reasons, and a reason closes them with its name on the thumb, so that the note shows what was
// pressed. A button names the scene to draw these same buttons again, and stays well inside the 64 bytes of its data.
export function noteKeyboard(t: Messages, storyId: string, nodeId: string, ref?: number, pressed?: Pressed): InlineKeyboard {
  const button = (text: string, value: Pressed): InlineButton => ({ text, callback_data: `rate:${ref}:${value}:${storyId}:${nodeId}` });
  const reason = member(RATING_REASONS, pressed) ? pressed : undefined;
  const thumbs = [button(pressed === 'up' ? '👍 ✓' : '👍', 'up'),
    button(reason ? `👎 ${t.rating[reason]}` : pressed === 'down' ? '👎 ✓' : '👎', 'down')];
  const reasons = RATING_REASONS.map(one => button(t.rating[one], one));
  return { inline_keyboard: [
    ...ref === undefined ? [] : [thumbs],
    ...ref !== undefined && pressed === 'down' ? [reasons.slice(0, 3), reasons.slice(3)] : [],
    [{ text: t.variant.button, callback_data: `prompt-edit:${storyId}:${nodeId}` }]] };
}

// A button's data, or nothing if it is not one of these.
export function ratingPress(data: string | undefined): RatingPress | undefined {
  const [verb, ref, value, storyId, nodeId] = data?.split(':') ?? [];
  const known = value === 'up' || value === 'down' || member(RATING_REASONS, value);
  return verb === 'rate' && /^\d{1,10}$/.test(ref ?? '') && known && storyId && nodeId ? { ref: Number(ref), value: value as Pressed, storyId, nodeId } : undefined;
}

// The row of a press. A reason is a thumb down, and the last row of a picture is what its reader thinks of it.
export function ratingRow({ ref, value }: RatingPress) {
  return { pictureRef: ref, ...value === 'up' || value === 'down' ? { pictureRating: value } : { pictureRating: 'down', ratingReason: value } };
}
