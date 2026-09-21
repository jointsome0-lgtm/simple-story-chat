import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chooseOffers, createBody, describeOffer, emptyReason, offerQuery, redactedBody, rentPlan } from './rent-plan.ts';
import type { RawOffer } from './rent-plan.ts';

const RENT = fileURLToPath(new URL('../gpu/rent.mjs', import.meta.url));

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

test('the traffic term counts both model sets, not Gemma alone', () => {
  const plan = rentPlan({ gpus: 2 });
  // Gemma is 25.2 GB of the download; the session pulls about 54 GB. At a cent per GB that is $0.54, not $0.25.
  assert.ok(plan.sessionBytes > 2 * 25201484928, 'the draft model, the image stack and the wheels are counted');
  assert.equal(describeOffer(offer({ inet_down_cost: 0.01 }), plan).download, 0.54);
});

test('the card count drives the query, the ceiling and the RAM floor, and an unpriced count is refused', () => {
  const one = rentPlan(), two = rentPlan({ gpus: 2 });
  assert.equal(offerQuery(one).num_gpus.eq, 1);
  assert.equal(offerQuery(two).num_gpus.eq, 2);
  // $0.55 and $1.00 for the machine, plus what this plan's disk costs beside it.
  assert.equal(one.maxHour, 0.571);
  assert.equal(two.maxHour, 1.021);
  assert.equal(two.minRamGb, 64);
  assert.equal(offerQuery(two).cpu_ram.gte, 64000);
  assert.throws(() => rentPlan({ gpus: 4 }), /price ceiling/);
});

test('the ceiling carries the disk, so a bigger disk does not demand a cheaper card', () => {
  const rentable = (gpus: number, dph: number) =>
    chooseOffers([offer({ dph_total: dph, storage_cost: 0.1, gpu_frac: gpus / 8, cpu_ram: 1024000 })], rentPlan({ gpus })).candidates.length === 1;
  // The quoted range for one card is $0.44-0.53 and the measured machine sits at $0.519. All of it must stay
  // rentable at 150 GB of disk: against a flat $0.55 the storage term alone refused the top of the range.
  for (const dph of [0.44, 0.519, 0.52, 0.53]) assert.ok(rentable(1, dph), `one card at $${dph}/h`);
  assert.ok(!rentable(1, 0.6), 'and a card above the range is still refused');
  // Two in one machine: $0.89-0.96 quoted, $1.00 approved.
  for (const dph of [0.89, 0.96, 1.0]) assert.ok(rentable(2, dph), `two cards at $${dph}/h`);
  assert.ok(!rentable(2, 1.1), 'and a dearer pair is still refused');
});

test('offers are ordered for a session of hours, not of minutes', () => {
  const plan = rentPlan({ gpus: 2, preferredHost: null });
  // Over 2h15 the $0.08/h the cheaper machine saves ($0.18) outweighs the $0.13 of traffic it costs extra; over the
  // 45 minutes the old weight assumed, the one-off traffic would have decided instead and the order would flip.
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
  ], plan);
  // Read as $0 both would have sorted ahead of every honest offer and been the first thing the script PUTs.
  assert.deepEqual(choice.candidates.map(o => o.id), ['priced']);
  assert.equal(choice.droppedForUnknownPrice, 2);
  assert.equal(choice.withinPrice, 1);
});

test('an empty list names the rule that emptied it', () => {
  const plan = rentPlan({ gpus: 2 });
  const reason = (offers: RawOffer[]) => emptyReason(chooseOffers(offers, plan));
  assert.equal(reason([offer({ dph_total: 1.4 })]), 'none_within_price');
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

test('price, ports and container RAM each drop offers and each says how many', () => {
  const plan = rentPlan({ gpus: 2 });
  const choice = chooseOffers([
    offer({ id: 'good' }),
    offer({ id: 'too-dear', dph_total: 1.4 }),
    offer({ id: 'proxy-only', direct_port_count: 1 }),
    // 64 GB of RAM on the machine, half of it in this offer's share: below the 64 GB floor.
    offer({ id: 'too-little-ram', cpu_ram: 64000, gpu_frac: 0.5 }),
    // An offer that does not report its share is not dropped for a number nobody knows.
    offer({ id: 'ram-unknown', gpu_frac: null }),
  ], plan);
  assert.deepEqual(choice.candidates.map(o => o.id).sort(), ['good', 'ram-unknown']);
  assert.equal(choice.withinPrice, 4);
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
