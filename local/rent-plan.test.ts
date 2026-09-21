import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chooseOffers, createBody, describeOffer, emptyReason, offerQuery, redactedBody, rentPlan } from './rent-plan.ts';
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
  cpu_cores_effective: 30.72, cpu_ram: 256000, gpu_frac: 0.5, inet_down: 900, reliability2: 0.99,
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
});

test('the card count drives the query, the ceiling and the RAM floor, and an unpriced count is refused', () => {
  const one = rentPlan(), two = rentPlan({ gpus: 2 });
  assert.equal(offerQuery(one).num_gpus.eq, 1);
  assert.equal(offerQuery(two).num_gpus.eq, 2);
  // $0.55 and $1.00 for the machine, plus what this plan's disk costs beside it at the measured storage rate.
  assert.equal(one.maxHour, 0.593);
  assert.equal(two.maxHour, 1.043);
  assert.equal(two.minRamGb, 64);
  assert.equal(offerQuery(two).cpu_ram.gte, 64000);
  assert.throws(() => rentPlan({ gpus: 4 }), /price ceiling/);
});

test('the ceiling carries the disk at the rate a real disk costs, not only at the kind one', () => {
  const rentable = (gpus: number, dph: number, storage: number) =>
    chooseOffers([offer({ dph_total: dph, storage_cost: storage, gpu_frac: gpus / 8, cpu_ram: 1024000 })],
      rentPlan({ gpus })).candidates.length === 1;
  // $0.10 per GB per month is the rate commonly quoted; $0.207 is what the 60 GB rental in docs/gpu.md was billed
  // ($0.017 an hour). The quoted range for one card is $0.44-0.53 with the measured machine at $0.519, and
  // $0.89-0.96 for two in one machine. All of it must stay rentable at 150 GB of disk on a host charging either
  // rate: against a flat ceiling the storage term alone refused the top of the range.
  for (const storage of [0.1, 0.207]) {
    const disk = `, disk at $${storage}`;
    for (const dph of [0.44, 0.519, 0.52, 0.53]) assert.ok(rentable(1, dph, storage), `one card at $${dph}/h${disk}`);
    assert.ok(!rentable(1, 0.6, storage), `a card above the range is still refused${disk}`);
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
  assert.equal(reason([offer({ cpu_ram: 64000, gpu_frac: 0.5 })]), 'none_with_enough_ram');
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
    // 64 GB of RAM on the machine, half of it in this offer's share: below the 64 GB floor.
    offer({ id: 'too-little-ram', cpu_ram: 64000, gpu_frac: 0.5 }),
    // An offer that does not report its share is not dropped for a number nobody knows.
    offer({ id: 'ram-unknown', gpu_frac: null }),
  ], plan);
  assert.deepEqual(choice.candidates.map(o => o.id).sort(), ['good', 'ram-unknown']);
  assert.equal(choice.offered, 6);
  // The core rule has its own count and is not folded into the price: five offers were affordable, one of them
  // too small to build on.
  assert.equal(choice.withinPrice, 5);
  assert.equal(choice.droppedForFewCores, 1);
  assert.equal(choice.droppedForProxyOnly, 1);
  assert.equal(choice.droppedForRam, 1);
  assert.equal(describeOffer(offer({ cpu_ram: 256000, gpu_frac: 0.5 }), plan).ramGb, 128);
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
  const run = () => spawnSync(process.execPath, [RENT, '--print-body'],
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A canned Vast for the attempt loop: it answers the search from STUB_OFFERS and the create request as STUB_PUT
// asks. `fetch` is replaced before gpu/rent.mjs is loaded, so no request in the test below leaves this machine.
const STUB = `globalThis.fetch = async (url) => {
  if (String(url).includes('/bundles/')) return new Response(process.env.STUB_OFFERS, { status: 200 });
  if (process.env.STUB_PUT === 'reject') throw new TypeError('fetch failed');
  return new Response('{"success":true}', { status: 200 });
};
`;

test('an answer that names no instance stops the loop instead of renting the next offer too', () => {
  const home = mkdtempSync(join(tmpdir(), 'simple-chat-rent-'));
  try {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'simple_chat_vast_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1secret owner@host\n');
    const stub = join(home, 'stub.mjs');
    writeFileSync(stub, STUB);
    const offers = JSON.stringify({ offers: [offer({ id: 'first' }), offer({ id: 'second', dph_total: 0.95 })] });
    const run = (put: string) => spawnSync(process.execPath,
      ['--import', pathToFileURL(stub).href, RENT, '--gpus', '2'],
      { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH ?? '', HOME: home,
        SIMPLE_CHAT_VAST_API_KEY: 'stub', STUB_OFFERS: offers, STUB_PUT: put } });
    // A 2xx body the script cannot read, and a request that never came back: after either one an instance may be
    // billing, so the money stops there and the owner is told where to look, instead of a second machine being
    // rented on top of the first.
    for (const [put, reason] of [['unrecognised', 'no instance named'], ['reject', 'no answer']]) {
      const result = run(put);
      assert.equal(result.status, 1, put);
      assert.equal(result.stderr, '', 'an answer the script cannot read is an outcome, not a stack trace');
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      // Both offers passed every rule, and the line the owner reads says so rather than leaving it to be computed.
      assert.deepEqual([events[0].event, events[0].offered, events[0].chosen], ['candidates', 2, 2]);
      const attempts = events.filter(event => event.event.startsWith('attempt'));
      assert.deepEqual(attempts.map(event => [event.event, event.offer, event.reason]),
        [['attempt_uncertain', 'first', reason]], 'only the first offer was asked for');
      assert.match(attempts[0].check, /vast\.ai/, 'and the owner is sent to check the instance list');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
