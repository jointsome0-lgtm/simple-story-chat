import { table, integer, text } from 'sdk/db';

export const settings = table('settings', {
  id: integer('id').primaryKey(),
  payload: text('payload').notNull(),
});

// A revision-checked write changes the entire single-owner library atomically.
// No foreign keys or undocumented multi-statement transactions are needed.
export const library = table('library', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
});
