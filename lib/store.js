import { emptyLibrary } from 'lib/library';

// mutate() callbacks are synchronous and have no external side effects:
// a competing invocation may cause them to run again against a newer revision.
export function createStore(adapter) {
  return {
    async read() {
      const row = await adapter.read();
      const state = row ? JSON.parse(row.payload) : emptyLibrary();
      if (state.version !== 1) throw new Error('Unsupported library version');
      return state;
    },
    async mutate(fn) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await adapter.read();
        const state = row ? JSON.parse(row.payload) : emptyLibrary();
        if (state.version !== 1) throw new Error('Unsupported library version');
        const result = fn(state);
        if (await adapter.write(row?.revision ?? null, JSON.stringify(state))) return result;
      }
      throw new Error('Library is busy; retry the action');
    },
  };
}
