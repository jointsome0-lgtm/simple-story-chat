// A synthetic probe must not inherit the bot's credentials or configuration from an npm script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scripts: Record<string, string> = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts;

test('synthetic probes are not handed the bot environment', () => {
  for (const name of ['illustrate:probe', 'judge:extract']) {
    const command = scripts[name];
    assert.ok(command, `${name} has no npm script`);
    assert.doesNotMatch(command, /--env-file/, `${name} must build its own environment`);
  }
});
