import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { createAgentApi } from './agent-api.ts';
import type { Provider } from './model.ts';

// The MCP SDK is the one runtime dependency; `npm test` runs without `npm install`, so these tests skip without it.
// The dynamic import also shows that the SDK loads next to our type-stripped .ts files.
async function load() {
  try {
    return {
      mcp: await import('./mcp.ts'),
      client: await import('@modelcontextprotocol/sdk/client/index.js'),
      memory: await import('@modelcontextprotocol/sdk/inMemory.js'),
      stdio: await import('@modelcontextprotocol/sdk/client/stdio.js'),
    };
  } catch { return null; }
}
const sdk = await load();
const skip = sdk ? false : 'the MCP SDK is not installed (npm install)';
const SEED = 'Lighthouse\n2026-08-02 20:00\nThe keeper meets a boat.';
// Tool results are JSON text; the tests read the fields they check.
type Text = { content: { type: string; text: string }[] };
const parse = (result: unknown) => JSON.parse((result as Text).content[0].text);

test('MCP: a story round trip over an in-memory transport, with a fake model', { skip }, async t => {
  const store = new Store(':memory:');
  const provider: Provider = { generate: async () => ({ text: '2026-08-02 20:05\n\nSynthetic scene.', finishReason: 'stop' }) };
  const api = createAgentApi({ store, provider, config: { model: 'test-model', provider: 'claude-code', maxOutputTokens: 1024, contextTokens: 65536 } });
  const [clientSide, serverSide] = sdk!.memory.InMemoryTransport.createLinkedPair();
  const server = sdk!.mcp.createMcpServer(api);
  const client = new sdk!.client.Client({ name: 'test', version: '0' });
  t.after(async () => { await client.close(); await server.close(); await api.close(); store.close(); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['create_seed', 'start_story', 'act', 'fork', 'read', 'status', 'wait', 'cancel']);
  const seed = parse(await client.callTool({ name: 'create_seed', arguments: { requestId: 'seed-1', text: SEED } }));
  assert.equal(seed.status, 'done');
  const started = parse(await client.callTool({ name: 'start_story', arguments: { requestId: 'start-1', seedId: seed.result.seedId } }));
  assert.equal(started.status, 'done');
  assert.equal(started.result.scene.worldTime, '2026-08-02 20:05');
  const acted = parse(await client.callTool({ name: 'act', arguments: { requestId: 'act-1', storyId: started.result.storyId,
    branchId: started.result.branchId, expected: started.result.revision, input: 'I wave.' } }));
  assert.equal(acted.status, 'done');
  const view = parse(await client.callTool({ name: 'read', arguments: { storyId: started.result.storyId, memory: true } }));
  assert.equal(view.result.revision, acted.result.revision);
  assert.deepEqual(view.result.memory, []);
  const unknown = await client.callTool({ name: 'delete_everything', arguments: {} });
  assert.equal(unknown.isError, true);
});

test('MCP: the stdio server starts under its lock and answers without a model', { skip }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-mcp-'));
  // An empty directory and no inherited SIMPLE_CHAT_ settings: no local .env, no bot database, no model call.
  const transport = new sdk!.stdio.StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp.ts', import.meta.url))],
    cwd: directory, env: { PATH: process.env.PATH!, HOME: directory, SIMPLE_CHAT_AGENT_DB_PATH: join(directory, 'agents.sqlite') }, stderr: 'ignore' });
  const client = new sdk!.client.Client({ name: 'test', version: '0' });
  t.after(async () => { await client.close(); rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const seed = parse(await client.callTool({ name: 'create_seed', arguments: { requestId: 'seed-1', text: SEED } }));
  assert.deepEqual(seed.result, { seedId: 's1', title: 'Lighthouse', worldTime: '2026-08-02 20:00' });
  const overview = parse(await client.callTool({ name: 'read', arguments: {} }));
  assert.equal(overview.result.seeds.length, 1);
  assert.equal(parse(await client.callTool({ name: 'status', arguments: { requestId: 'nobody' } })).reason, 'unknown_request');
});
