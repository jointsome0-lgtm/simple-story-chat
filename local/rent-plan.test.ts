import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOOT_SECONDS, DESTROY_SECONDS, chooseOffers, createBody, describeOffer, destroyInstance, emptyReason, instanceState, offerQuery, redactedBody, rentPlan, sshRoute } from './rent-plan.ts';
import type { Choice, EmptyReason, RawOffer, RentPlan } from './rent-plan.ts';

const RENT = fileURLToPath(new URL('../gpu/rent.mjs', import.meta.url));

// Byte counts as a manifest pins them, read from the one file that owns each rather than copied into this test.
const pinned = (file: string, ...keys: string[]) => {
  const text = readFileSync(fileURLToPath(new URL(`../gpu/${file}`, import.meta.url)), 'utf8');
  return keys.reduce((total, key) => {
    const size = Number(new RegExp(`^${key}=(\\d+)$`, 'm').exec(text)?.[1]);
    assert.ok(Number.isSafeInteger(size) && size > 0, `${key} is a byte count`);
    return total + size;
  }, 0);
};
// What a default run pulls on each lane: Gemma and its draft; the fine-tune, the ComfyUI-native encoder and VAE, and
// the Turbo checkpoint. The gated bf16 originals come only with SIMPLE_CHAT_IMAGE_SOURCE=official, and the three Qwen
// files only with SIMPLE_CHAT_IMAGE_QWEN.
const TEXT = pinned('manifest.env', 'MODEL_BYTES', 'DRAFT_BYTES');
const PICTURES = pinned('image-manifest.env', 'IMAGE_MODEL_BYTES', 'IMAGE_ENCODER_BYTES', 'IMAGE_VAE_BYTES', 'IMAGE_TURBO_BYTES');
const QWEN = pinned('image-manifest.env', 'IMAGE_QWEN_MODEL_BYTES', 'IMAGE_QWEN_ENCODER_BYTES', 'IMAGE_QWEN_VAE_BYTES');

// A plausible cheap offer; every row changes only the fields it is about.
const offer = (fields: RawOffer = {}): RawOffer => ({
  id: 1, host_id: 7, geolocation: 'PL', driver_version: '580.95.05', direct_port_count: 12,
  cpu_cores_effective: 30.72, cpu_ram: 128000, inet_down: 900, reliability2: 0.99,
  dph_total: 0.9, storage_cost: 0.1, inet_down_cost: 0.0026, ...fields,
});

test('every machine is priced whole, its card, its own disk and its own downloads, and is rented only at a known price under its ceiling', () => {
  // [label, plan, disk, RAM floor in GB, downloads, what else its disk has room for, ceiling, the hour and the traffic
  // of an offer at $0.50/h, $0.10 per GB-month of disk and a cent per GB]. One disk size serves the offer filter, the
  // storage price and the create body. The downloads are the default run's files and wheels, torch's five gigabytes on
  // the picture lane, so two single-lane machines pull what one machine for both would. Qwen is priced only where it is
  // asked for, and fits every disk that draws pictures beside about 13 GiB of torch and ComfyUI; a machine that pulls
  // Qwen alone needs none of the pinned files and rents a disk that holds its own. The RAM floor is 32 GB a card, and
  // the picture lane's own 30 GB: it has no cache to feed. The small machine is simple-serving's rehearsal, priced by
  // Gemma 4 E2B and vLLM, under a ceiling of its own.
  const machines: [string, RentPlan, number, number, number, number, number, number[]][] = [
    ['one card for both lanes', rentPlan(), 150, 32, TEXT + PICTURES + 6e9, QWEN, 0.693, [0.521, 0.63]],
    ['two cards for both lanes', rentPlan({ gpus: 2 }), 150, 64, TEXT + PICTURES + 6e9, QWEN, 1.043, [0.521, 0.63]],
    ['the language machine', rentPlan({ lane: 'text' }), 60, 32, TEXT + 1e9, 0, 0.667, [0.508, 0.27]],
    ['the picture machine', rentPlan({ lane: 'pictures' }), 100, 30, PICTURES + 5e9, QWEN, 0.678, [0.514, 0.36]],
    ['a picture machine that pulls Qwen alone', rentPlan({ lane: 'pictures', qwenOnly: true }), 60, 30, QWEN + 5e9, 0, 0.667, [0.508, 0.22]],
    ['the small machine', rentPlan({ lane: 'small' }), 60, 16, 10246621918 + 32198128 + 6e9, 0, 0.267, [0.508, 0.16]],
  ];
  for (const [label, plan, disk, ram, bytes, room, ceiling, price] of machines) {
    assert.deepEqual([plan.diskGb, offerQuery(plan).disk_space.gte, createBody({ plan, onstart: '' }).disk], [disk, disk, disk], label);
    assert.ok((bytes + room) / 1e9 + 14 < disk, `${label}: the disk holds what the machine pulls`);
    // The card count drives the query as well as the ceiling, and the search is asked for the RAM floor in MB.
    assert.deepEqual([plan.sessionBytes, plan.maxHour, offerQuery(plan).num_gpus.eq, plan.minRamGb, offerQuery(plan).cpu_ram.gte],
      [bytes, ceiling, plan.gpus, ram, ram * 1000], label);
    const { hour, download } = describeOffer(offer({ dph_total: 0.5, storage_cost: 0.1, inet_down_cost: 0.01 }), plan);
    assert.deepEqual([hour, download], price, label);
  }
  // What nobody priced is refused rather than guessed.
  for (const [label, wrong, error] of [['four cards', { gpus: 4 }, /price ceiling/],
    ['a lane of two cards', { gpus: 2, lane: 'text' }, /one lane has one card/], ['a lane nobody defined', { lane: 'video' as 'text' }, /no such lane/],
    ['Qwen alone beside text', { qwenOnly: true }, /picture machine/]] as const) assert.throws(() => rentPlan(wrong), error, label);

  // The ceiling is the card price the owner approved, $0.65 for one card and $1.00 for two, and the machine's disk at
  // the $0.207 per GB-month the measured rental was billed (docs/knowledge/gpu-measurements.md#costs-and-downloads):
  // the top of each quoted range stays rentable on a host charging that or the commonly quoted $0.10, and a dearer card
  // is refused on either. A price that is missing or not a number, of the card, the disk or the traffic, is no price:
  // read as zero it would sort first and be rented first.
  const [one, two] = [rentPlan(), rentPlan({ gpus: 2 })];
  const offers: [string, RentPlan, RawOffer, 'rented' | 'over' | 'unknown'][] = [
    ['a card of unknown price', two, { dph_total: undefined }, 'unknown'],
    ['a card priced in text', two, { dph_total: '0.10' as unknown as number }, 'unknown'],
    ['a disk of unknown price', two, { storage_cost: undefined }, 'unknown'],
    ['traffic of unknown price', two, { inet_down_cost: null }, 'unknown'],
  ];
  for (const storage_cost of [0.1, 0.207]) {
    for (const dph_total of [0.44, 0.519, 0.53, 0.548, 0.6, 0.65, 0.7]) {
      offers.push([`one card at $${dph_total}, disk at $${storage_cost}`, one, { dph_total, storage_cost }, dph_total > 0.65 ? 'over' : 'rented']);
    }
    for (const dph_total of [0.89, 0.96, 1.0, 1.1]) {
      offers.push([`two cards at $${dph_total}, disk at $${storage_cost}`, two, { dph_total, storage_cost }, dph_total > 1 ? 'over' : 'rented']);
    }
  }
  for (const [label, plan, fields, outcome] of offers) {
    const { candidates, withinPrice, droppedForUnknownPrice } = chooseOffers([offer(fields)], plan);
    assert.deepEqual([candidates.length, withinPrice, droppedForUnknownPrice],
      { rented: [1, 1, 0], over: [0, 0, 0], unknown: [0, 0, 1] }[outcome], label);
  }
});

test('each rule counts the offers it drops and names itself when it empties the list, and the rest are tried in order', () => {
  const [one, two] = [rentPlan(), rentPlan({ gpus: 2 })];
  // The search asks the host for all of it, and a field the API does not understand is ignored silently, so every rule
  // runs again over the answer. The CUDA floor is the one the pinned image carries: a 570 driver stops at 12.8, and
  // llama-server built by the image's nvcc 13 would not start on it.
  const query = offerQuery(one);
  assert.deepEqual([query.geolocation, query.cuda_max_good.gte, Number(/cuda-(\d+\.\d+)/.exec(one.image)?.[1])], [{ notin: ['CN'] }, 13, 13], 'the query');
  // The measured host's one card of eight on 2026-09-23: the console showed "64/516 GB" and the search answered
  // `cpu_ram` 64469 beside `gpu_frac` 0.125. Read as the machine's RAM times the share it was 8 GB, under every floor.
  const measured = { id: 'measured', host_id: 402342, cpu_ram: 64469, gpu_frac: 0.125, dph_total: 0.508, storage_cost: 0.133 };
  // A 32 GB share that reports 31.2 GB, as the cheapest machines did on 2026-09-25: over the picture lane's floor and
  // under the language lane's.
  const share = offer({ id: 'share', cpu_ram: 31197, dph_total: 0.5 });
  // [label, plan, offers, the ids left in the order they are tried, counts, the reason an empty list gives]
  const rows: [string, RentPlan, RawOffer[], unknown[], Partial<Choice>, EmptyReason?][] = [
    // The cheapest two are the blocked ones. An offer that names no place is kept, like one that names no RAM.
    ['a country the weights cannot be fetched from', one, [offer({ id: 1, geolocation: 'Zhejiang, CN', dph_total: 0.3 }),
      offer({ id: 2, geolocation: ', CN', dph_total: 0.3 }), offer({ id: 3, geolocation: 'Texas, US', dph_total: 0.5 }),
      offer({ id: 4, geolocation: null, dph_total: 0.5 })], [3, 4], { droppedForCountry: 2, withinPrice: 2 }],
    ['a rule each', two, [offer({ id: 'good' }), offer({ id: 'too-dear', dph_total: 1.4 }),
      offer({ id: 'too-few-cores', cpu_cores_effective: 2 }), offer({ id: 'proxy-only', direct_port_count: 1 }),
      offer({ id: 'too-little-ram', cpu_ram: 32000 }), offer({ id: 'ram-unknown', cpu_ram: null })], ['good', 'ram-unknown'],
      { offered: 6, withinPrice: 5, droppedForFewCores: 1, droppedForProxyOnly: 1, droppedForRam: 1 }],
    // A search that matched nothing is the likeliest first answer to a two-card query, and says nothing of the price.
    ['nothing offered', two, [], [], { offered: 0 }, 'none_offered'],
    ['only a country out of reach', one, [offer({ geolocation: 'China, CN' })], [], { droppedForCountry: 1 }, 'none_in_reachable_country'],
    ['only dearer offers', two, [offer({ dph_total: 1.4 })], [], { withinPrice: 0 }, 'none_within_price'],
    ['only too few cores', two, [offer({ cpu_cores_effective: 2 })], [], { droppedForFewCores: 1 }, 'none_with_enough_cores'],
    ['only the proxy', two, [offer({ direct_port_count: 1 })], [], { droppedForProxyOnly: 1 }, 'none_with_direct_ports'],
    ['only too little RAM for two cards', two, [offer({ cpu_ram: 32000 })], [], { droppedForRam: 1 }, 'none_with_enough_ram'],
    ['the measured host\'s share, on the language machine', rentPlan({ lane: 'text' }), [offer(measured)], ['measured'], {}],
    ['the measured host\'s share, on the picture machine', rentPlan({ lane: 'pictures' }), [offer(measured)], ['measured'], {}],
    ['a share of 31.2 GB, on the picture machine', rentPlan({ lane: 'pictures' }), [share], ['share'], { droppedForRam: 0 }],
    ['a share of 31.2 GB, on the language machine', rentPlan({ lane: 'text' }), [share], [], { droppedForRam: 1 }, 'none_with_enough_ram'],
    // The measured host first while it fits the ceiling, then the cheapest over the rental's two and a half hours: the
    // $0.08/h the cheaper card saves outweighs the $0.15 of traffic it costs extra, which over 45 minutes it would not.
    ['the order they are tried in', two, [offer({ id: 'dear-by-the-hour', dph_total: 0.94, storage_cost: 0 }),
      offer({ id: 'cheap-by-the-hour', dph_total: 0.86, storage_cost: 0, inet_down_cost: 0.005 }),
      offer({ id: 'measured', host_id: 402342, dph_total: 0.95 }), offer({ id: 'measured-too-dear', host_id: 402342, dph_total: 1.5 })],
      ['measured', 'cheap-by-the-hour', 'dear-by-the-hour'], { withinPrice: 3 }],
  ];
  for (const [label, plan, offers, ids, counts, reason] of rows) {
    const choice = chooseOffers(offers, plan);
    assert.deepEqual(choice.candidates.map(o => o.id), ids, label);
    assert.deepEqual(Object.fromEntries(Object.keys(counts).map(key => [key, choice[key as keyof Choice]])), counts, label);
    if (reason) assert.equal(emptyReason(choice), reason, label);
  }
  // The RAM an offer states is its own share in MB, rounded down to the GB a floor is judged by.
  assert.deepEqual([describeOffer(offer(measured), one).ramGb, describeOffer(offer({ cpu_ram: 256000 }), two).ramGb], [64, 256], 'RAM');
});

// A canned Vast. It answers the search from STUB_OFFERS, the create request as STUB_PUT asks, a read of an instance
// with the next state of STUB_READS (the last one repeats), a delete with STUB_DELETE's status and a start with
// success. Its time is virtual: a pause takes none of the real kind and moves both clocks on by its length, and
// the answer that creates the machine takes fifty seconds. Every request is written to STUB_LOG with the second it was
// sent at and the bound its signal was given, a create request with the seconds its body gives the guard, and a start
// with the state its body asks for. `fetch` is replaced before gpu/rent.mjs is loaded, so no request below leaves this
// machine. The record of a present instance carries its address, with a newline after it, and its ports.
const STUB = `import { appendFileSync } from 'node:fs';
const reads = (process.env.STUB_READS ?? '').split(',');
const answers = { present: [200, { instances: { id: 123, actual_status: 'running', intended_status: 'running',
  public_ipaddr: '203.0.113.7\\n', ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '41022' }] }, ssh_host: 'ssh5.vast.ai', ssh_port: 36500 } }],
  gone: [200, { instances: null }], missing: [404, {}], failing: [500, {}], empty: [200, {}], other: [200, { instances: { id: 124 } }],
  stopped: [200, { instances: { id: 123, actual_status: 'exited', intended_status: 'stopped' } }] };
let skew = 0;
const later = globalThis.setTimeout, wall = Date.now, monotonic = performance.now.bind(performance);
globalThis.setTimeout = (next, ms = 0, ...rest) => { skew += ms; return later(next, 0, ...rest); };
Date.now = () => wall() + skew;
performance.now = () => monotonic() + skew;
const timeout = AbortSignal.timeout.bind(AbortSignal);
let bound = 0;
AbortSignal.timeout = ms => { bound = ms; return timeout(ms); };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname, method = init.method ?? 'GET';
  const start = method === 'PUT' && path.includes('/instances/');
  const sent = start ? ' ' + JSON.parse(init.body).state
    : method === 'PUT' ? ' guard ' + /SIMPLE_CHAT_TRIAL_SECONDS=(\\d+)/.exec(JSON.parse(init.body).onstart)?.[1] + 's' : '';
  appendFileSync(process.env.STUB_LOG, method + ' ' + Math.round(skew / 1000) + 's ' + bound + 'ms ' + path + sent + '\\n');
  if (path.includes('/bundles/')) return new Response(process.env.STUB_OFFERS, { status: 200 });
  if (method === 'DELETE') return new Response('{"success":true}', { status: Number(process.env.STUB_DELETE ?? 200) });
  if (start) return new Response('{"success":true}');
  if (method === 'GET') {
    const [status, body] = answers[reads.length > 1 ? reads.shift() : reads[0]];
    return new Response(JSON.stringify(body), { status });
  }
  if (process.env.STUB_PUT === 'reject') throw new TypeError('fetch failed');
  if (process.env.STUB_PUT !== 'contract') return new Response('{"success":true}', { status: 200 });
  skew += 50000;
  return new Response('{"success":true,"new_contract":123}', { status: 200 });
};
`;

// A HOME of its own for gpu/rent.mjs, with an ssh key and the stub in it.
function canned(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'simple-chat-rent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'simple_chat_vast_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1secret owner@host\n');
  writeFileSync(join(home, 'stub.mjs'), STUB);
  return home;
}

// One run against the canned Vast, with the account's key unless the row takes it away. Whatever Vast answers, nothing
// reaches stderr and neither key reaches the terminal.
function rent(home: string, label: string, env: Record<string, string>, args: string[]) {
  const log = join(home, 'requests.log');
  writeFileSync(log, '');
  const offers = JSON.stringify({ offers: [offer({ id: 'first' }), offer({ id: 'second', dph_total: 0.95 })] });
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(home, 'stub.mjs')).href, RENT, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH ?? '', HOME: home, SIMPLE_CHAT_VAST_API_KEY: 'stub-account-key', STUB_OFFERS: offers, STUB_LOG: log, ...env },
  });
  assert.equal(result.stderr, '', `${label}: an answer the script cannot read is an outcome, not a stack trace`);
  assert.doesNotMatch(result.stdout, /stub-account-key|AAAAC3NzaC1secret/, `${label}: neither key is printed`);
  return { label, status: result.status, events: result.stdout.trim().split('\n').map(line => JSON.parse(line)),
    requests: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

// [label, env, arguments, exit status, events by name, requests by method, second and guard, what else the run shows]
type Run = ReturnType<typeof rent>;
type Row = [string, Record<string, string>, string[], number, string[], string, ((run: Run, before: number) => void)?];
function runs(home: string, rows: Row[]) {
  for (const [label, env, args, status, events, requests, check] of rows) {
    const before = Math.floor(Date.now() / 1000), run = rent(home, label, env, args);
    const timeline = run.requests.map(line => line.replace(/ \d+ms \S+/, '')).join(', ');
    assert.deepEqual([run.status, run.events.map(event => event.event), timeline], [status, events, requests], label);
    check?.(run, before);
  }
}

test('the create body asks for the devel image, direct ssh and a guard of one to three hours, and neither key is ever printed', t => {
  const plan = rentPlan({ gpus: 2 });
  const body = createBody({ plan, onstart: "#!/bin/bash\nSIMPLE_CHAT_SSH_PUBLIC_KEY='ssh-ed25519 AAAAC3NzaC1secret owner@host'\nsleep 1\n" });
  assert.deepEqual([body.runtype, body.env, body.use_jupyter_lab], ['ssh_direc ssh_proxy', { '-p 22:22': '1' }, false], 'direct ssh');
  // The image measured in docs/knowledge/gpu-measurements.md#verified-2026-09-17. gpu/bootstrap.sh compiles
  // llama-server on the machine and a runtime image has no nvcc, so the session would be paid for and build nothing.
  assert.equal(body.image, 'vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07', 'the devel image');
  // What --print-body shows: every field that decides what is rented, and the script's size in place of the script.
  const printed = JSON.stringify(redactedBody(body));
  assert.ok(!printed.includes('AAAAC3NzaC1secret') && !printed.includes('sleep 1'), 'neither the key nor the script');
  assert.ok(printed.includes(plan.image) && printed.includes('"disk":150') && printed.includes('4 lines'), 'what is rented');

  // --print-body is the review before anything is set up: it needs no account key, and on a fresh machine it says in
  // one line that there is no ssh key either; with the account's key it searches too, and creates nothing. The guard
  // deletes the machine after three hours unless the session asks for one or two, and never after more. The printed
  // field is not what the machine is told, so a longer rental is refused before anything is sent, and the stub reads
  // the seconds out of the body that is. An onstart script past the size Vast's own checks keep to is refused before
  // anything is printed or sent.
  const home = canned(t), review = { SIMPLE_CHAT_VAST_API_KEY: '' };
  mkdirSync(join(home, 'long', '.ssh'), { recursive: true });
  writeFileSync(join(home, 'long', '.ssh', 'simple_chat_vast_ed25519.pub'), `ssh-ed25519 AAAAC3NzaC1secret ${'x'.repeat(400)}\n`);
  runs(home, [
    ['a machine with no ssh key yet', { ...review, HOME: join(home, 'fresh') }, ['--print-body'], 1, ['no_public_key'], ''],
    ['an onstart script past 4048 bytes', { ...review, HOME: join(home, 'long') }, ['--print-body'], 1, ['onstart_too_long'], ''],
    ['the review before the account key is set', review, ['--print-body'], 0, ['create_request'], '', ({ label, events: [shown] }) => {
      assert.deepEqual([shown.body.disk, shown.hours, shown.sessionHours], [150, 3, 2.5], label);
      assert.match(shown.body.onstart, /^\[redacted: \d+ lines, \d+ bytes, ssh key inside\]$/, label);
    }],
    ['the review with the account key', {}, ['--print-body', '--gpus', '2'], 0, ['create_request', 'candidates', 'would_try', 'would_try'], 'GET 0s'],
    ['an hour of a picture machine that pulls Qwen alone', review, ['--print-body', '--lane', 'pictures', '--hours', '1', '--qwen', 'only'], 0,
      ['create_request'], '', ({ label, events: [shown] }) =>
        assert.deepEqual([shown.body.disk, shown.hours, shown.sessionHours, shown.sessionGb], [60, 1, 1.34, 22], label)],
    ['four hours', {}, ['--gpus', '2', '--hours', '4'], 1, ['bad_arguments'], ''],
    ['Qwen alone on a machine that serves text too', {}, ['--qwen', 'only'], 1, ['bad_arguments'], ''],
    ['a Qwen flag of another value', {}, ['--lane', 'pictures', '--qwen', 'true'], 1, ['bad_arguments'], ''],
    ['a rental of two hours', { STUB_PUT: 'contract' }, ['--gpus', '2', '--hours', '2'], 0, ['candidates', 'rented'], 'GET 0s, PUT 0s guard 7200s'],
  ]);
});

test('an answer that is not certain is never taken for the outcome, of a rental, its destroy or its start', async t => {
  // One read of an instance: only a 404, and a 200 whose record is null, say it is gone. Of a record, two status words
  // are kept, and only while they are plain words.
  const present = { instances: { id: 123, actual_status: 'exited', intended_status: 'ssh-ed25519 AAAA' } };
  for (const [label, status, body, state] of [['a 404', 404, {}, 'gone'], ['a null record', 200, { instances: null }, 'gone'],
    ['no record', 200, {}, 'unknown'], ['a failure', 500, { instances: null }, 'unknown'], ['no answer', 0, null, 'unknown'],
    ['another instance', 200, { instances: { id: 124 } }, 'unknown'], ['its record', 200, present, 'present']] as const) {
    assert.equal(instanceState('123', status, body).state, state, label);
  }
  assert.deepEqual(instanceState('123', 200, present), { state: 'present', status: 200, actual: 'exited', intended: null }, 'its words');
  // Where ssh reaches it, from the same read: an address and a port, or null for any part that is not one. Each row
  // spoils one field of a record that routes both ways.
  const route = { public_ipaddr: '203.0.113.7', ports: { '22/tcp': [{ HostPort: '41022' }] }, ssh_host: 'ssh5.vast.ai', ssh_port: 36500 };
  const [direct, proxy] = ['203.0.113.7:41022', 'ssh5.vast.ai:36500'];
  for (const [label, id, fields, routed] of [['its record', 123, {}, { direct, proxy }],
    ['a box still loading, with no port mapped yet', 123, { ports: {} }, { direct: null, proxy }],
    ['an address with a command after it', 123, { public_ipaddr: '203.0.113.7; rm -rf /' }, { direct: null, proxy }],
    ['a mapped port out of range', 123, { ports: { '22/tcp': [{ HostPort: '70000' }] } }, { direct: null, proxy }],
    ['a proxy that is not Vast\'s', 123, { ssh_host: 'evil.example' }, { direct, proxy: null }],
    ['a proxy host with an option after it', 123, { ssh_host: 'ssh5.vast.ai -o ProxyCommand=x' }, { direct, proxy: null }],
    ['a proxy port with an option after it', 123, { ssh_port: '22 -o ProxyCommand=x' }, { direct, proxy: null }],
    ['another instance', 124, {}, { direct: null, proxy: null }]] as const) {
    assert.deepEqual(sshRoute('123', 200, { instances: { ...route, id, ...fields } }), routed, label);
  }

  // The destroy's own clock, virtual, against a Vast that answers every request after 19 s, one whose reads never
  // answer, one whose deletes never do, and one that answers in five seconds, which leaves a last pause to be cut. A
  // request not answered within its bound comes back empty then, as AbortSignal.timeout makes it in gpu/rent.mjs.
  // Whatever Vast does, the destroy ends five minutes after it began, nothing is sent after them and no request is
  // bounded past them, and the first delete waits out the guard's minute. Returned: how it ended, its seconds, the
  // second of the first delete, and the requests sent.
  const running = instanceState('123', 200, { instances: { id: 123, actual_status: 'running' } });
  const clocked = async (label: string, readMs: number, removeMs: number) => {
    let clock = 0;
    const sent: { method: string; at: number; bound: number }[] = [];
    const answer = async <T>(method: string, bound: number, takes: number, value: T, none: T) => {
      sent.push({ method, at: clock, bound });
      clock += Math.min(takes, bound);
      return takes <= bound ? value : none;
    };
    const end = await destroyInstance({ now: () => clock, sleep: async ms => { clock += ms; }, log: () => undefined,
      read: bound => answer('GET', bound, readMs, running, instanceState('123', 0, null)),
      remove: bound => answer('DELETE', bound, removeMs, { status: 200, success: true }, { status: 0, success: null }) });
    const limit = DESTROY_SECONDS * 1000;
    assert.ok(sent.every(one => one.at < limit && Number.isInteger(one.bound) && one.bound <= Math.min(20000, limit - one.at)), label);
    return [end.event, clock / 1000, sent.find(one => one.method === 'DELETE')!.at / 1000, sent.length];
  };
  for (const [label, readMs, removeMs, first, sent] of [['answers after 19 s', 19000, 19000, 77, 13], ['reads never answered', Infinity, 0, 80, 18],
    ['deletes never answered', 0, Infinity, 60, 22], ['answers in five seconds', 5000, 5000, 65, 25]] as const) {
    assert.deepEqual(await clocked(label, readMs, removeMs), ['destroy_unconfirmed', 300, first, sent], label);
  }

  // A 2xx body the script cannot read, and a request that never came back: after either one an instance may be
  // billing, so the money stops there and the owner is told where to look, instead of a second machine being rented
  // on top of the first. Both offers passed every rule, and the line the owner reads says so.
  const uncertain = (reason: string): Row[6] => ({ label, events: [candidates, attempt] }) => {
    assert.deepEqual([candidates.offered, candidates.chosen, attempt.offer, attempt.reason], [2, 2, 'first', reason], label);
    assert.match(attempt.check, /vast\.ai/, label);
  };
  // A read every ten seconds from the first to `last`, and after the read of each second in `sends` a delete, or the
  // request that `send` writes.
  const reads = (last: number, sends: number[] = [], send = (second: number) => `DELETE ${second}s`) =>
    Array.from({ length: last / 10 + 1 }, (_, at) => at * 10)
      .flatMap(second => sends.includes(second) ? [`GET ${second}s`, send(second)] : [`GET ${second}s`]).join(', ');
  const resumes = (second: number) => `PUT ${second}s running`;
  const told = ({ label, events }: Run) => assert.match(events.at(-1).tell, /owner/, label);
  runs(canned(t), [
    ['a 2xx body that names no instance', { STUB_PUT: 'unrecognised' }, ['--gpus', '2'], 1, ['candidates', 'attempt_uncertain'],
      'GET 0s, PUT 0s guard 10800s', uncertain('no instance named')],
    ['a create request that never came back', { STUB_PUT: 'reject' }, ['--gpus', '2'], 1, ['candidates', 'attempt_uncertain'],
      'GET 0s, PUT 0s guard 10800s', uncertain('no answer')],
    // Before a rental of an hour, the dry run prices each offer for all of it: $0.921 and $0.971 an hour over
    // 1 h 20 min 20 s, and $0.16 of traffic.
    ['the dry run of an hour', { SIMPLE_CHAT_RENT_DRY_RUN: '1' }, ['--gpus', '2', '--hours', '1'], 0, ['candidates', 'would_try', 'would_try'],
      'GET 0s', ({ label, events: [candidates, ...tried] }) => assert.deepEqual([candidates.sessionHours, ...tried.map(one => [one.id, one.session])],
        [1.34, ['first', 1.39], ['second', 1.46]], label)],
    // An answer that names its instance ends the loop, with the operator's own deadline: the guard's hour and the
    // quarter of an hour the box is given to start, counted from before the request that created the machine, never
    // from its answer, which took fifty seconds here.
    ['an answer that names its instance', { STUB_PUT: 'contract' }, ['--gpus', '2', '--hours', '1'], 0, ['candidates', 'rented'],
      'GET 0s, PUT 0s guard 3600s', ({ label, events: [, rented] }, before) => {
        assert.deepEqual([rented.offer, rented.instance], ['first', 123], label);
        assert.ok(rented.destroyBy >= before + 3600 + BOOT_SECONDS && rented.destroyBy <= Date.now() / 1000 + 3600 + BOOT_SECONDS, label);
      }],
    // The other end of a rental, by its ID and the account's key alone. Nothing is asked without an ID, or of one that
    // is not a number.
    ['--destroy without an ID', {}, ['--destroy'], 1, ['bad_arguments'], ''],
    ['--show of an ID that is not a number', {}, ['--show', '123/'], 1, ['bad_arguments'], ''],
    ['--show', { STUB_READS: 'present' }, ['--show', '123'], 0, ['instance'], 'GET 0s', ({ label, events, requests }) => assert.deepEqual([events, requests],
      [[{ event: 'instance', instance: '123', state: 'present', status: 200, actual: 'running', intended: 'running',
        ssh: { direct: '203.0.113.7:41022', proxy: 'ssh5.vast.ai:36500' } }], ['GET 0s 20000ms /api/v0/instances/123/']], label)],
    // A destroy's dry run only reads, and an instance the guard deletes within its minute is read as gone and never
    // deleted with the account's key. One still there after the minute is deleted, and read every ten seconds until a
    // read says it is gone; the delete's own `success` is no such read, and it is sent again after half a minute.
    ['the dry run of a destroy', { STUB_READS: 'present', SIMPLE_CHAT_RENT_DRY_RUN: '1' }, ['--destroy', '123'], 0, ['would_destroy'], reads(0)],
    ['gone within the guard\'s minute', { STUB_READS: 'present,present,gone' }, ['--destroy', '123'], 0, ['destroy_confirmed'], reads(20)],
    ['still there after it', { STUB_READS: [...Array(10).fill('present'), 'missing'].join(',') }, ['--destroy', '123'], 0,
      ['destroy_sent', 'destroy_sent', 'destroy_confirmed'], reads(100, [60, 90])],
    // Reads that say nothing certain end, five minutes after the first, as a deletion not confirmed, and the owner is
    // to be told; a key that may not delete ends so at once.
    ['reads that say nothing certain', { STUB_READS: 'failing,empty,other' }, ['--destroy', '123'], 1,
      [...Array(8).fill('destroy_sent'), 'destroy_unconfirmed'], reads(290, [60, 90, 120, 150, 180, 210, 240, 270]), run => {
        assert.ok(Number(/ (\d+)ms /.exec(run.requests.at(-1)!)?.[1]) <= 10000, `${run.label}: the last read is cut at the time left`);
        told(run);
      }],
    ['a key that may not delete', { STUB_READS: 'present', STUB_DELETE: '403' }, ['--destroy', '123'], 1, ['destroy_sent', 'destroy_refused'],
      reads(60, [60]), told],
    // A start asks a stopped instance to run, again each minute while a read still says it is stopped, and gives up
    // twenty minutes after its first read.
    ['a stopped instance', { STUB_READS: 'stopped,present' }, ['--start', '123'], 0, ['start_sent', 'start_confirmed'],
      reads(10, [0], resumes)],
    ['a start that never takes', { STUB_READS: 'stopped' }, ['--start', '123'], 1, [...Array(20).fill('start_sent'), 'start_unconfirmed'],
      reads(1190, Array.from({ length: 20 }, (_, at) => at * 60), resumes)],
  ]);
});
