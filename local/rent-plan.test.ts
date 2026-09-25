import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOOT_SECONDS, DESTROY_SECONDS, chooseOffers, createBody, describeOffer, destroyInstance, emptyReason, instanceState, offerQuery, redactedBody, rentPlan, sshRoute } from './rent-plan.ts';
import type { RawOffer } from './rent-plan.ts';

const RENT = fileURLToPath(new URL('../gpu/rent.mjs', import.meta.url));

// The `KEY=value` lines of a pinned manifest, so that a size the session downloads is read from the one file that
// owns it rather than copied into this test as well.
const pinned = (file: string): Record<string, string> => Object.fromEntries(
  readFileSync(fileURLToPath(new URL(`../gpu/${file}`, import.meta.url)), 'utf8').split('\n')
    .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).replace(/^"|"$/g, '')]));

// A plausible cheap offer; every test changes only the field it is about.
const offer = (fields: RawOffer = {}): RawOffer => ({
  id: 1, host_id: 7, geolocation: 'PL', driver_version: '580.95.05', direct_port_count: 12,
  cpu_cores_effective: 30.72, cpu_ram: 128000, inet_down: 900, reliability2: 0.99,
  dph_total: 0.9, storage_cost: 0.1, inet_down_cost: 0.0026, ...fields,
});

test('the disk size is one number: the plan, the offer filter, the storage price and the create body', () => {
  const plan = rentPlan({ gpus: 2 });
  assert.equal(plan.diskGb, 150);
  assert.equal(offerQuery(plan).disk_space.gte, plan.diskGb);
  assert.equal(createBody({ plan, onstart: '#!/bin/bash\n' }).disk, plan.diskGb);
  // $0.10 per GB per month over 150 GB is $0.0205/h on top of the hourly rate.
  assert.equal(describeOffer(offer({ dph_total: 0.9, storage_cost: 0.1 }), plan).hour, 0.921);
});

// What gpu/bootstrap.sh and gpu/image-bootstrap.sh pull with no flags set, at the sizes the manifests pin: Gemma
// and its draft, the fine-tune, the ComfyUI-native encoder and VAE, and the Turbo checkpoint
// (SIMPLE_CHAT_IMAGE_TURBO defaults to true). The gated bf16 originals under OFFICIAL_ are downloaded only by
// SIMPLE_CHAT_IMAGE_SOURCE=official, and the three Qwen files only by SIMPLE_CHAT_IMAGE_QWEN=true.
const defaultDownloadBytes = () => {
  const language = pinned('manifest.env'), image = pinned('image-manifest.env');
  const bytes = (record: Record<string, string>, key: string) => {
    const size = Number(record[key]);
    assert.ok(Number.isSafeInteger(size) && size > 0, `${key} is a byte count`);
    return size;
  };
  return bytes(language, 'MODEL_BYTES') + bytes(language, 'DRAFT_BYTES') + bytes(image, 'IMAGE_MODEL_BYTES')
    + bytes(image, 'IMAGE_ENCODER_BYTES') + bytes(image, 'IMAGE_VAE_BYTES') + bytes(image, 'IMAGE_TURBO_BYTES');
};

test('the traffic term counts every file a default run downloads, at the sizes the manifests pin', () => {
  const plan = rentPlan({ gpus: 2 });
  assert.equal(plan.sessionBytes - defaultDownloadBytes(), 6000000000, 'the pinned files plus the wheels, and nothing invented');
  // Gemma is 25.2 GB of the 63 GB the session pulls. At a cent per GB that is $0.63, not $0.25.
  const gemma = Number(pinned('manifest.env')['MODEL_BYTES']);
  assert.ok(plan.sessionBytes > 2 * gemma, 'the image lane is counted, not Gemma alone');
  assert.equal(describeOffer(offer({ inet_down_cost: 0.01 }), plan).download, 0.63);
});

test('the Qwen comparison is pinned beside the rest and is priced only by the session that asks for it', () => {
  const plan = rentPlan({ gpus: 2 });
  const image = pinned('image-manifest.env');
  const qwen = ['IMAGE_QWEN_MODEL_BYTES', 'IMAGE_QWEN_ENCODER_BYTES', 'IMAGE_QWEN_VAE_BYTES']
    .reduce((total, key) => total + Number(image[key]), 0);
  assert.equal(qwen, 17283091112, 'the int8 transformer, the int8 encoder and the bf16 VAE');
  // The term above is what an offer is chosen by. This is the other half of the same rule, written where somebody
  // who turns the opt-in on will look: the traffic term is the default download and the wheels, and these three
  // files are outside it. It has to be that identity — `sessionBytes > 3 * qwen` stood here, and it holds just as
  // well with the 17.28 GB added to the sum, so the regression it named could not have failed it.
  assert.equal(plan.sessionBytes, defaultDownloadBytes() + 6000000000, 'the opt-in is priced into every session');
  // And it still fits the disk the plan rents: the pinned files, the opt-in, and about 13 GiB for torch.
  assert.ok((plan.sessionBytes + qwen) / 1e9 + 14 < plan.diskGb, 'the opt-in does not fit the rented disk');
  // A picture machine that pulls Qwen alone, as the identity runbook's does, is priced by those three files and torch,
  // on a disk of its own that holds them; any other machine is refused the flag rather than priced for less than it
  // pulls.
  const alone = rentPlan({ lane: 'pictures', qwenOnly: true });
  assert.deepEqual([alone.sessionBytes, alone.diskGb], [qwen + 5000000000, 60]);
  assert.ok(alone.sessionBytes / 1e9 + 14 < alone.diskGb, 'Qwen alone does not fit its disk');
  assert.equal(offerQuery(alone).disk_space.gte, 60);
  assert.equal(createBody({ plan: alone, onstart: '' }).disk, 60);
  assert.throws(() => rentPlan({ qwenOnly: true }), /picture machine/);
});

test('a session on two machines rents each lane its own disk and prices it by its own downloads', () => {
  const both = rentPlan(), text = rentPlan({ lane: 'text' }), pictures = rentPlan({ lane: 'pictures' });
  // Nothing is counted twice and nothing is lost: the two lanes pull what one machine for both would.
  assert.equal(text.sessionBytes + pictures.sessionBytes, both.sessionBytes);
  const language = pinned('manifest.env');
  assert.equal(text.sessionBytes, Number(language['MODEL_BYTES']) + Number(language['DRAFT_BYTES']) + 1000000000);
  // The language machine's disk is the measured rental's; the picture machine's holds the Qwen opt-in as well.
  assert.equal(text.diskGb, 60);
  const image = pinned('image-manifest.env');
  const qwen = ['IMAGE_QWEN_MODEL_BYTES', 'IMAGE_QWEN_ENCODER_BYTES', 'IMAGE_QWEN_VAE_BYTES']
    .reduce((total, key) => total + Number(image[key]), 0);
  assert.ok((pictures.sessionBytes + qwen) / 1e9 + 14 < pictures.diskGb, 'the opt-in does not fit the picture machine');
  assert.ok(text.sessionBytes / 1e9 + 14 < text.diskGb);
  // A smaller disk is a smaller storage term, so the same approved card price gives a lower ceiling.
  assert.ok(text.maxHour < pictures.maxHour && pictures.maxHour < both.maxHour);
  assert.equal(offerQuery(pictures).disk_space.gte, 100);
  assert.equal(createBody({ plan: pictures, onstart: '' }).disk, 100);
  // The picture lane's RAM floor is its own: a 32 GB share that reports 31.2 GB is taken there, not for the language.
  assert.deepEqual([pictures.minRamGb, offerQuery(pictures).cpu_ram.gte, text.minRamGb], [30, 30000, 32]);
  const share = [offer({ id: 1, cpu_ram: 31197, dph_total: 0.5 })];
  assert.deepEqual(chooseOffers(share, pictures).candidates.map(one => one.id), [1]);
  assert.equal(chooseOffers(share, text).droppedForRam, 1);
  // One lane is one card, and a lane nobody defined is refused rather than rented as something else.
  assert.throws(() => rentPlan({ gpus: 2, lane: 'text' }), /one lane has one card/);
  assert.throws(() => rentPlan({ lane: 'video' as 'text' }), /no such lane/);
});

test('a machine in a country the weights cannot be fetched from is dropped, and says so', () => {
  const plan = rentPlan();
  assert.deepEqual(offerQuery(plan).geolocation, { notin: ['CN'] });
  const choice = chooseOffers([
    offer({ id: 1, geolocation: 'Zhejiang, CN', dph_total: 0.3 }), offer({ id: 2, geolocation: ', CN', dph_total: 0.3 }),
    offer({ id: 3, geolocation: 'Texas, US', dph_total: 0.5 }), offer({ id: 4, geolocation: null, dph_total: 0.5 }),
  ], plan);
  // The cheapest two are the blocked ones: the rule runs over the answer too, because a query field the API does
  // not understand is ignored silently. An offer that names no place is kept, like one that names no RAM.
  assert.equal(choice.droppedForCountry, 2);
  assert.deepEqual(choice.candidates.map(one => one.id), [3, 4]);
  const none = chooseOffers([offer({ geolocation: 'China, CN' })], plan);
  assert.equal(emptyReason(none), 'none_in_reachable_country');
});

test('the card count drives the query, the ceiling and the RAM floor, and an unpriced count is refused', () => {
  const one = rentPlan(), two = rentPlan({ gpus: 2 });
  assert.equal(offerQuery(one).num_gpus.eq, 1);
  assert.equal(offerQuery(two).num_gpus.eq, 2);
  // $0.65 and $1.00 for the machine, plus what this plan's disk costs beside it at the measured storage rate.
  assert.equal(one.maxHour, 0.693);
  assert.equal(two.maxHour, 1.043);
  assert.equal(two.minRamGb, 64);
  assert.equal(offerQuery(two).cpu_ram.gte, 64000);
  assert.throws(() => rentPlan({ gpus: 4 }), /price ceiling/);
});

test('the ceiling carries the disk at the rate a real disk costs, not only at the kind one', () => {
  const rentable = (gpus: number, dph: number, storage: number) =>
    chooseOffers([offer({ dph_total: dph, storage_cost: storage })],
      rentPlan({ gpus })).candidates.length === 1;
  // $0.10 per GB per month is the rate commonly quoted; $0.207 is what the 60 GB rental in docs/gpu.md was billed
  // ($0.017 an hour). The quoted range for one card is $0.44-0.53 with the measured machine at $0.519, widened to
  // $0.65 on 2026-09-24, and $0.89-0.96 for two in one machine. All of it must stay rentable at 150 GB of disk on a
  // host charging either rate: against a flat ceiling the storage term alone refused the top of the range.
  for (const storage of [0.1, 0.207]) {
    const disk = `, disk at $${storage}`;
    for (const dph of [0.44, 0.519, 0.53, 0.548, 0.6, 0.65]) assert.ok(rentable(1, dph, storage), `one card at $${dph}/h${disk}`);
    assert.ok(!rentable(1, 0.7, storage), `a card above the range is still refused${disk}`);
    for (const dph of [0.89, 0.96, 1.0]) assert.ok(rentable(2, dph, storage), `two cards at $${dph}/h${disk}`);
    assert.ok(!rentable(2, 1.1, storage), `a dearer pair is still refused${disk}`);
  }
});

test('offers are ordered for a session of hours, not of minutes', () => {
  const plan = rentPlan({ gpus: 2, preferredHost: null });
  // The whole instance life is billed, not the work window inside it: work stops about a quarter of an hour before
  // teardown, and until the instance is deleted the hourly rate keeps running.
  assert.equal(plan.sessionHours, 2.5);
  // Over the 2h30 the instance is billed for, the $0.08/h the cheaper machine saves ($0.20) outweighs the $0.15 of
  // traffic it costs extra; over the 45 minutes the old weight assumed, the one-off traffic would have decided
  // instead and the order would flip.
  const { candidates } = chooseOffers([
    offer({ id: 'dear-by-the-hour', dph_total: 0.94, storage_cost: 0, inet_down_cost: 0.0026 }),
    offer({ id: 'cheap-by-the-hour', dph_total: 0.86, storage_cost: 0, inet_down_cost: 0.005 }),
  ], plan);
  assert.deepEqual(candidates.map(o => o.id), ['cheap-by-the-hour', 'dear-by-the-hour']);
  assert.ok(candidates[0].hour * 0.75 + candidates[0].download > candidates[1].hour * 0.75 + candidates[1].download,
    'the same pair in the other order for a 45-minute session');
  // A rental given its hours is billed for them and for what the guard does not count: the quarter of an hour before
  // its clock starts, and the twenty seconds of "we're done" and the five minutes of a destroy after it ends.
  assert.equal(Math.round(rentPlan({ lane: 'pictures', hours: 1 }).sessionHours * 60), 80);
});

test('the image and the host tried first are pinned, because a rental pays for a wrong one', () => {
  const plan = rentPlan();
  // The image measured in docs/gpu.md: a CUDA 13 *devel* image, because gpu/bootstrap.sh compiles llama-server on
  // the machine and a runtime image has no nvcc. The session would be paid for and build nothing.
  assert.equal(plan.image, 'vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07');
  // The host of that measurement: known driver, known ports, known link speed. Dropping the default would send
  // every rental to an unmeasured machine without anything failing.
  assert.equal(plan.preferredHost, 402342);
});

test('an offer that does not say what it costs is dropped, not taken first', () => {
  const plan = rentPlan({ gpus: 2, preferredHost: null });
  const choice = chooseOffers([
    offer({ id: 'priced', dph_total: 0.95 }),
    offer({ id: 'no-price', dph_total: undefined }),
    offer({ id: 'price-as-text', dph_total: '0.10' as unknown as number }),
    // The machine is not the only thing with a price. An offer silent about its disk looks $0.03/h cheaper than it
    // is and can pass a ceiling it would fail; one silent about its link looks like free traffic, and traffic is
    // the term that decides between offers.
    offer({ id: 'no-disk-price', storage_cost: undefined }),
    offer({ id: 'no-traffic-price', inet_down_cost: null }),
  ], plan);
  // Read as $0 each of them would have sorted ahead of every honest offer and been the first thing the script PUTs.
  assert.deepEqual(choice.candidates.map(o => o.id), ['priced']);
  assert.equal(choice.droppedForUnknownPrice, 4);
  assert.equal(choice.withinPrice, 1);
});

test('an empty list names the rule that emptied it', () => {
  const plan = rentPlan({ gpus: 2 });
  const reason = (offers: RawOffer[]) => emptyReason(chooseOffers(offers, plan));
  // A search that matched nothing is the likeliest first answer to a two-card query, and it says nothing about the
  // price: reading it as one sends the owner to raise a ceiling that was never reached.
  assert.equal(reason([]), 'none_offered');
  assert.equal(reason([offer({ dph_total: 1.4 })]), 'none_within_price');
  assert.equal(reason([offer({ cpu_cores_effective: 2 })]), 'none_with_enough_cores');
  assert.equal(reason([offer({ direct_port_count: 1 })]), 'none_with_direct_ports');
  // Affordable and reachable, but the container's share of the machine's RAM is under the floor: not a price.
  assert.equal(reason([offer({ cpu_ram: 32000 })]), 'none_with_enough_ram');
});

test('the measured host is tried first while it fits the ceiling', () => {
  const plan = rentPlan({ gpus: 2, preferredHost: 402342 });
  const { candidates } = chooseOffers([
    offer({ id: 'cheapest', host_id: 7, dph_total: 0.5 }),
    offer({ id: 'preferred', host_id: 402342, dph_total: 0.95 }),
    offer({ id: 'preferred-too-dear', host_id: 402342, dph_total: 1.5 }),
  ], plan);
  assert.deepEqual(candidates.map(o => o.id), ['preferred', 'cheapest']);
});

test('price, cores, ports and container RAM each drop offers and each says how many', () => {
  const plan = rentPlan({ gpus: 2 });
  const choice = chooseOffers([
    offer({ id: 'good' }),
    offer({ id: 'too-dear', dph_total: 1.4 }),
    offer({ id: 'too-few-cores', cpu_cores_effective: 2 }),
    offer({ id: 'proxy-only', direct_port_count: 1 }),
    // 32 GB in this offer's share: below the 64 GB floor of two cards.
    offer({ id: 'too-little-ram', cpu_ram: 32000 }),
    // An offer that does not report its RAM is not dropped for a number nobody knows.
    offer({ id: 'ram-unknown', cpu_ram: null }),
  ], plan);
  assert.deepEqual(choice.candidates.map(o => o.id).sort(), ['good', 'ram-unknown']);
  assert.equal(choice.offered, 6);
  // The core rule has its own count and is not folded into the price: five offers were affordable, one of them
  // too small to build on.
  assert.equal(choice.withinPrice, 5);
  assert.equal(choice.droppedForFewCores, 1);
  assert.equal(choice.droppedForProxyOnly, 1);
  assert.equal(choice.droppedForRam, 1);
  assert.equal(describeOffer(offer({ cpu_ram: 256000 }), plan).ramGb, 256);
});

test('the RAM of an offer is its own share as Vast answers it, and is not divided by the cards a second time', () => {
  // The measured host's offer of one card of eight on 2026-09-23: the console shows "64/516 GB" and the search
  // answers `cpu_ram` 64469 beside `gpu_frac` 0.125. Read as the machine's RAM times the share, it was 8 GB, and
  // every machine of several cards fell under the 32 GB floor.
  const measured = { host_id: 402342, cpu_ram: 64469, gpu_frac: 0.125, dph_total: 0.508, storage_cost: 0.133 };
  for (const lane of ['text', 'pictures'] as const) {
    const plan = rentPlan({ lane });
    assert.equal(describeOffer(offer(measured), plan).ramGb, 64);
    assert.deepEqual(chooseOffers([offer(measured)], plan).candidates.map(o => o.host), [402342], lane);
  }
});

test('the create body asks for direct ssh, and --print-body shows it without the key or the script', () => {
  const plan = rentPlan({ gpus: 2 });
  const onstart = "#!/bin/bash\nSIMPLE_CHAT_SSH_PUBLIC_KEY='ssh-ed25519 AAAAC3NzaC1secret owner@host'\nsleep 1\n";
  const body = createBody({ plan, onstart });
  assert.match(body.runtype, /ssh_direc/);
  assert.deepEqual(body.env, { '-p 22:22': '1' });
  assert.equal(body.use_jupyter_lab, false);
  const shown = JSON.stringify(redactedBody(body));
  assert.ok(!shown.includes('AAAAC3NzaC1secret'), 'the public key never reaches the terminal');
  assert.ok(!shown.includes('sleep 1'), 'nor does the onstart script');
  assert.ok(shown.includes('4 lines'), 'its size is shown instead');
  // Everything that decides what is rented stays visible.
  assert.ok(shown.includes(plan.image) && shown.includes('"disk":150') && shown.includes('ssh_direc'));
});

// --print-body is the review that happens before anything is set up, so it runs with no API key and, on a fresh
// machine, with no ssh key either. Both runs below stop before the search; nothing here reaches vast.ai.
test('--print-body prints the request without a key, and says so in one line when there is no ssh key', () => {
  const home = mkdtempSync(join(tmpdir(), 'simple-chat-rent-'));
  const run = (...extra: string[]) => spawnSync(process.execPath, [RENT, '--print-body', ...extra],
    { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8', timeout: 30000 });
  try {
    const missing = run();
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout.trim(), JSON.stringify({ event: 'no_public_key' }));
    assert.equal(missing.stderr, '', 'a key that was never made is an outcome, not a stack trace');

    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'simple_chat_vast_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1secret owner@host\n');
    const printed = run();
    assert.equal(printed.status, 0);
    const shown = JSON.parse(printed.stdout.trim());
    assert.equal(shown.event, 'create_request');
    assert.equal(shown.body.disk, rentPlan().diskGb);
    assert.match(shown.body.onstart, /^\[redacted: \d+ lines, \d+ bytes, ssh key inside\]$/);
    assert.ok(!printed.stdout.includes('AAAAC3NzaC1secret'), 'the key stays out of the terminal');
    // The guard deletes the machine after three hours unless the session asks for one or two, and never after more.
    // A session that gives its hours is priced by them, and the identity runbook's by Qwen's download alone.
    assert.deepEqual([shown.hours, shown.sessionHours], [3, 2.5]);
    const hour = JSON.parse(run('--lane', 'pictures', '--hours', '1', '--qwen', 'only').stdout.trim());
    assert.deepEqual([hour.hours, hour.sessionHours, hour.sessionGb], [1, 1.34, 22]);
    for (const refused of [['--hours', '4'], ['--qwen', 'only'], ['--qwen', 'true']]) {
      const longer = run(...refused);
      assert.equal(longer.status, 1);
      assert.equal(JSON.parse(longer.stdout.trim()).event, 'bad_arguments', refused.join(' '));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A canned Vast. It answers the search from STUB_OFFERS, the create request as STUB_PUT asks, a read of an instance
// with the next state of STUB_READS (the last one repeats) and a delete with STUB_DELETE's status. Its time is
// virtual: a pause takes none of the real kind and moves both clocks on by its length, and the answer that creates
// the machine takes fifty seconds. Every request is written to STUB_LOG with the second it was sent at and the bound
// its signal was given. `fetch` is replaced before gpu/rent.mjs is loaded, so no request in the test below leaves
// this machine.
const STUB = `import { appendFileSync } from 'node:fs';
const reads = (process.env.STUB_READS ?? '').split(',');
const answers = { present: [200, { instances: { id: 123, actual_status: 'running', intended_status: 'running',
  public_ipaddr: '203.0.113.7\\n', ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '41022' }] }, ssh_host: 'ssh5.vast.ai', ssh_port: 36500 } }],
  gone: [200, { instances: null }], missing: [404, {}], failing: [500, {}], empty: [200, {}], other: [200, { instances: { id: 124 } }] };
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
  appendFileSync(process.env.STUB_LOG, method + ' ' + Math.round(skew / 1000) + 's ' + bound + 'ms ' + path + '\\n');
  if (path.includes('/bundles/')) return new Response(process.env.STUB_OFFERS, { status: 200 });
  if (method === 'DELETE') return new Response('{"success":true}', { status: Number(process.env.STUB_DELETE ?? 200) });
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

test('an answer that is not certain is never taken for the outcome, of a rental or of its destroy', async () => {
  // One read of an instance: only a 404, and a 200 whose record is null, say it is gone. Of a record, two status words
  // are kept, and only while they are plain words.
  const present = { instances: { id: 123, actual_status: 'exited', intended_status: 'ssh-ed25519 AAAA' } };
  assert.deepEqual(([[404, {}], [200, { instances: null }], [200, {}], [500, { instances: null }], [0, null], [200, { instances: { id: 124 } }],
    [200, present]] as const).map(([status, body]) => instanceState('123', status, body).state),
  ['gone', 'gone', 'unknown', 'unknown', 'unknown', 'unknown', 'present']);
  assert.deepEqual(instanceState('123', 200, present), { state: 'present', status: 200, actual: 'exited', intended: null });
  // Where ssh reaches it, from the same read: an address and a port, or null for anything that is not one.
  const routed = (fields: object, id = 123) => sshRoute('123', 200, { instances: { id, ...fields } });
  assert.deepEqual(routed({ public_ipaddr: '203.0.113.7', ports: { '22/tcp': [{ HostPort: '41022' }] }, ssh_host: 'ssh5.vast.ai', ssh_port: 36500 }),
    { direct: '203.0.113.7:41022', proxy: 'ssh5.vast.ai:36500' });
  assert.deepEqual(routed({ public_ipaddr: '203.0.113.7', ports: {}, ssh_host: 'ssh5.vast.ai', ssh_port: 36500 }),
    { direct: null, proxy: 'ssh5.vast.ai:36500' }, 'a box still loading has no mapped port yet');
  assert.deepEqual(routed({ public_ipaddr: '203.0.113.7; rm -rf /', ports: { '22/tcp': [{ HostPort: '70000' }] },
    ssh_host: 'evil.example', ssh_port: '22 -o ProxyCommand=x' }), { direct: null, proxy: null });
  assert.deepEqual(routed({ public_ipaddr: '203.0.113.7', ports: { '22/tcp': [{ HostPort: '41022' }] } }, 124), { direct: null, proxy: null });

  // The destroy's own clock, virtual, against a Vast that answers every request after 19 s, one whose reads never
  // answer, one whose deletes never do, and one that answers in five seconds, which leaves a last pause to be cut. A
  // request not answered within its bound comes back empty then, as AbortSignal.timeout makes it in gpu/rent.mjs.
  // Whatever Vast does, the destroy ends five minutes after it began, nothing is sent after them and no request is
  // bounded past them, and the first delete waits out the guard's minute. Returned: how it ended, its seconds, the
  // second of the first delete, and the requests sent.
  const running = instanceState('123', 200, { instances: { id: 123, actual_status: 'running' } });
  const clocked = async (readMs: number, removeMs: number) => {
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
    assert.ok(sent.every(one => one.at < limit && Number.isInteger(one.bound) && one.bound <= Math.min(20000, limit - one.at)));
    return [end.event, clock / 1000, sent.find(one => one.method === 'DELETE')!.at / 1000, sent.length];
  };
  assert.deepEqual(await clocked(19000, 19000), ['destroy_unconfirmed', 300, 77, 13]);
  assert.deepEqual(await clocked(Infinity, 0), ['destroy_unconfirmed', 300, 80, 18]);
  assert.deepEqual(await clocked(0, Infinity), ['destroy_unconfirmed', 300, 60, 22]);
  assert.deepEqual(await clocked(5000, 5000), ['destroy_unconfirmed', 300, 65, 25]);

  const home = mkdtempSync(join(tmpdir(), 'simple-chat-rent-'));
  try {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'simple_chat_vast_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1secret owner@host\n');
    const stub = join(home, 'stub.mjs'), log = join(home, 'requests.log');
    writeFileSync(stub, STUB);
    const offers = JSON.stringify({ offers: [offer({ id: 'first' }), offer({ id: 'second', dph_total: 0.95 })] });
    const run = (env: Record<string, string>, ...args: string[]) => {
      writeFileSync(log, '');
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, RENT, ...args],
        { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH ?? '', HOME: home,
          SIMPLE_CHAT_VAST_API_KEY: 'stub-account-key', STUB_OFFERS: offers, STUB_LOG: log, ...env } });
      assert.equal(result.stderr, '', 'an answer the script cannot read is an outcome, not a stack trace');
      assert.ok(!result.stdout.includes('stub-account-key'), 'the account key is never printed');
      return { status: result.status, events: result.stdout.trim().split('\n').map(line => JSON.parse(line)),
        requests: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
    };
    // A 2xx body the script cannot read, and a request that never came back: after either one an instance may be
    // billing, so the money stops there and the owner is told where to look, instead of a second machine being
    // rented on top of the first.
    for (const [put, reason] of [['unrecognised', 'no instance named'], ['reject', 'no answer']]) {
      const { status, events } = run({ STUB_PUT: put }, '--gpus', '2');
      assert.equal(status, 1, put);
      // Both offers passed every rule, and the line the owner reads says so rather than leaving it to be computed.
      assert.deepEqual([events[0].event, events[0].offered, events[0].chosen], ['candidates', 2, 2]);
      const attempts = events.filter(event => event.event.startsWith('attempt'));
      assert.deepEqual(attempts.map(event => [event.event, event.offer, event.reason]),
        [['attempt_uncertain', 'first', reason]], 'only the first offer was asked for');
      assert.match(attempts[0].check, /vast\.ai/, 'and the owner is sent to check the instance list');
    }
    // An answer that names its instance ends the loop, with the operator's own deadline: the guard's hour and the
    // quarter of an hour the box is given to start, counted from before the request that created the machine, never
    // from its answer, which took fifty seconds here. Before it, the dry run prices each offer for the whole of that
    // rental: $0.921 and $0.971 an hour over 1 h 20 min 20 s, and $0.16 of traffic.
    const priced = run({ SIMPLE_CHAT_RENT_DRY_RUN: '1' }, '--gpus', '2', '--hours', '1').events;
    assert.deepEqual([priced[0].sessionHours, ...priced.slice(1).map(one => [one.id, one.session])], [1.34, ['first', 1.39], ['second', 1.46]]);
    const before = Math.floor(Date.now() / 1000);
    const rented = run({ STUB_PUT: 'contract' }, '--gpus', '2', '--hours', '1').events.at(-1);
    assert.deepEqual([rented.event, rented.offer, rented.instance], ['rented', 'first', 123]);
    assert.ok(rented.destroyBy >= before + 3600 + BOOT_SECONDS && rented.destroyBy <= Date.now() / 1000 + 3600 + BOOT_SECONDS);

    // The other end of a rental, by its ID and the account's key alone. Nothing is asked without an ID, or of one that
    // is not a number.
    for (const args of [['--destroy'], ['--show', '123/']]) {
      const { status, events, requests } = run({}, ...args);
      assert.deepEqual([status, events.map(event => event.event), requests], [1, ['bad_arguments'], []], args.join(' '));
    }
    const shown = run({ STUB_READS: 'present' }, '--show', '123');
    assert.deepEqual([shown.status, shown.events, shown.requests],
      [0, [{ event: 'instance', instance: '123', state: 'present', status: 200, actual: 'running', intended: 'running',
        ssh: { direct: '203.0.113.7:41022', proxy: 'ssh5.vast.ai:36500' } }], ['GET 0s 20000ms /api/v0/instances/123/']]);
    // The rest by the stub's clock: which request went out at which second.
    const timeline = (requests: string[]) => requests.map(request => request.split(' ').slice(0, 2).join(' ')).join(', ');
    const reads = (...seconds: number[]) => seconds.map(second => `GET ${second}s`).join(', ');
    // A destroy's dry run only reads, and an instance the guard deletes within its minute is read as gone and never
    // deleted with the account's key.
    for (const [env, event, seconds] of [[{ STUB_READS: 'present', SIMPLE_CHAT_RENT_DRY_RUN: '1' }, 'would_destroy', [0]],
      [{ STUB_READS: 'present,present,gone' }, 'destroy_confirmed', [0, 10, 20]]] as const) {
      const { status, events, requests } = run(env, '--destroy', '123');
      assert.deepEqual([status, events.map(one => one.event), timeline(requests)], [0, [event], reads(...seconds)]);
    }
    // One still there after the guard's minute is deleted, and read every ten seconds until a read says it is gone;
    // the delete's own `success` is no such read, and it is sent again after half a minute.
    const deleted = run({ STUB_READS: [...Array(10).fill('present'), 'missing'].join(',') }, '--destroy', '123');
    assert.deepEqual([deleted.status, deleted.events.map(event => event.event), timeline(deleted.requests)],
      [0, ['destroy_sent', 'destroy_sent', 'destroy_confirmed'], `${reads(0, 10, 20, 30, 40, 50, 60)}, DELETE 60s, ${reads(70, 80, 90)}, DELETE 90s, GET 100s`]);
    // Reads that say nothing certain end, five minutes after the first, as a deletion not confirmed, and the owner is
    // to be told; a key that may not delete ends so at once.
    const unsure = run({ STUB_READS: 'failing,empty,other' }, '--destroy', '123');
    assert.deepEqual([unsure.status, unsure.events.at(-1).event, unsure.requests.length, timeline(unsure.requests.slice(-3))],
      [1, 'destroy_unconfirmed', 30 + 8, 'DELETE 270s, GET 280s, GET 290s']);
    assert.ok(Number(unsure.requests.at(-1)!.split(' ')[2].replace('ms', '')) <= 10000, 'the last read is cut at the time left');
    assert.match(unsure.events.at(-1).tell, /owner/);
    const refused = run({ STUB_READS: 'present', STUB_DELETE: '403' }, '--destroy', '123');
    assert.deepEqual([refused.status, refused.events.map(event => event.event), timeline(refused.requests.slice(-1))],
      [1, ['destroy_sent', 'destroy_refused'], 'DELETE 60s']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the offer query asks for a driver that runs the CUDA the pinned image carries', () => {
  const plan = rentPlan({ gpus: 1 });
  const imageCuda = /cuda-(\d+)\.(\d+)/.exec(plan.image);
  assert.ok(imageCuda, 'the image name carries its CUDA version');
  const major = Number(imageCuda![1]), minor = Number(imageCuda![2]);
  // A 570 driver stops at 12.8 and would pass a 12.8 floor, and llama-server built by nvcc 13 would not start on it.
  assert.equal(offerQuery(plan).cuda_max_good.gte, major + minor / 10);
  assert.equal(offerQuery(plan).cuda_max_good.gte, 13.0);
});
