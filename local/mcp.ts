// The agent interface as an MCP server over stdio (docs/agent-interface.md#the-contract). A thin adapter: each tool
// is one call of local/agent-api.ts, its input a JSON schema, its result the call's response as JSON text. The
// process is long-lived and holds the agent library's lock, so a turn keeps running after its `wait` expires and
// `cancel` can reach it.
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openAgent, underLock } from './agent-api.ts';
import type { AgentApi, AgentResponse } from './agent-api.ts';
import { loadAgentConfig } from './config.ts';
import type { AgentConfig } from './config.ts';
import type { Log } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';

// Arguments are the client's JSON; the core checks every field it reads.
type Args = { [field: string]: unknown };
type Tool = { name: string; description: string; inputSchema: { type: 'object'; properties: object; required?: string[] };
  call: (api: AgentApi, args: Args) => AgentResponse | Promise<AgentResponse> };

const string = (description: string) => ({ type: 'string', description });
const requestId = string('Your key for this request. The same key with the same arguments returns the stored result and never runs anything again; with other arguments it is a conflict.');
const wait = { type: 'number', minimum: 0, maximum: 600, description: 'Seconds to wait for the scene before answering `running`; continue with the wait tool.' };
const SHAPE = 'Every result is JSON: {requestId?, status: done|running|failed|interrupted|preempted|conflict|stale|busy, result?, reason?}.';

export const TOOLS: Tool[] = [
  { name: 'create_seed', description: `Save a seed: first line the title, second the world time as 2026-08-02 20:00, then the world. Returns {seedId, title, worldTime}. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId, text: string('The seed text.') }, required: ['requestId', 'text'] },
    call: (api, args) => api.createSeed(args) },
  { name: 'start_story', description: `Start a story from a seed and write its first scene. Returns {storyId, branchId, scene, checkpointId, revision}. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId, seedId: string('From create_seed.'), wait }, required: ['requestId', 'seedId'] },
    call: (api, args) => api.startStory(args) },
  { name: 'act', description: `Play one turn on a branch. Empty input lets the narrator continue. \`expected\` is the branch revision you last saw; if the branch has moved the answer is \`stale\` with the current revision and nothing is generated. Returns {scene, checkpointId, revision, compaction?}. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId, storyId: string('Story id.'), branchId: string('Branch id.'),
      expected: string('The revision you last saw.'), input: string('Your move, in the language of the story; empty to continue.'), wait },
    required: ['requestId', 'storyId', 'branchId', 'expected'] },
    call: (api, args) => api.act(args) },
  { name: 'fork', description: `Start a new branch from a checkpoint (every scene has one; compactions add pre-compaction and compaction ones). The branch gets the checkpoint's scenes and memory. Returns {branchId, revision}. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId, storyId: string('Story id.'), checkpointId: string('From read or from a scene.') },
      required: ['requestId', 'storyId', 'checkpointId'] },
    call: (api, args) => api.fork(args) },
  { name: 'read', description: `Look without changing anything. Without storyId: the seeds and stories. With it: a branch's recent scenes with their inputs, its checkpoints with their kinds, its revision, and with memory=true the memory increments with the scene ids each fact comes from. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { storyId: string('Story id.'), branchId: string('Branch id; the last one used by default.'),
      scenes: { type: 'integer', minimum: 0, description: 'How many recent scenes, 3 by default.' }, memory: { type: 'boolean', description: 'Include the memory increments.' } } },
    call: (api, args) => api.read(args) },
  { name: 'status', description: `The stored result of a request. Never starts anything. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId }, required: ['requestId'] },
    call: (api, args) => api.status(args) },
  { name: 'wait', description: `Wait for a running request, up to \`seconds\`. Never starts anything, and its expiry cancels nothing. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId, seconds: { type: 'number', minimum: 0, maximum: 600 } }, required: ['requestId'] },
    call: (api, args) => api.wait(args) },
  { name: 'cancel', description: `Stop a running turn. A turn that has already saved its scene stays done. ${SHAPE}`,
    inputSchema: { type: 'object', properties: { requestId }, required: ['requestId'] },
    call: (api, args) => api.cancel(args) },
];

export function createMcpServer(api: AgentApi) {
  const server = new Server({ name: 'simple-story-chat', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map(({ call, ...tool }) => tool) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = TOOLS.find(tool => tool.name === request.params.name);
    const response: AgentResponse = tool ? await tool.call(api, request.params.arguments ?? {}) : { status: 'failed', reason: 'invalid_request' };
    return { content: [{ type: 'text', text: JSON.stringify(response) }], ...(tool ? {} : { isError: true }) };
  });
  return server;
}

if (import.meta.main) {
  process.umask(0o077);
  // stdout is the protocol; technical rows go to stderr and carry no story text.
  const log: Log = (event, code, details) => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), event,
    ...(typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? { code } : {}), ...safeErrorDetails(details) }) + '\n');
  let config: AgentConfig | null = null;
  let agentId: string | undefined;
  try {
    agentId = parseArgs({ options: { agent: { type: 'string' } } }).values.agent;
    config = loadAgentConfig();
  } catch (error) {
    // Argument and configuration errors are this project's own messages and name no path or value.
    console.error((error as Error).message);
    process.exitCode = 1;
  }
  if (config) {
    try {
      if (underLock(config.dbPath, fileURLToPath(import.meta.url), () => console.error('Another process is writing this agent library.'))) {
        const agent = await openAgent(config, { userId: agentId ?? config.agentId, log });
        log(agent.queue ? 'agent_model_queue' : 'agent_model_direct');
        const server = createMcpServer(agent.api);
        // Running turns end as interrupted, with the point they saved.
        const stop = async () => { await agent.close(); process.exit(0); };
        for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void stop(); });
        process.stdin.once('end', () => { void stop(); });
        await server.connect(new StdioServerTransport());
      }
    } catch {
      // A system error may name a path; only its code is shown.
      log('agent_failed', 'internal_error', { actor: 'agent' });
      process.exitCode = 1;
    }
  }
}
