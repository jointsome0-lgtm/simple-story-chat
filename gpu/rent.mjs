// Rents one machine with RTX 5090s -- one card by default, `--gpus 2` for the session that runs the language lane
// and the image lane side by side, or with `--lane small` the cheapest card of 16 GB for simple-serving's rehearsal --
// at or below the price the owner approved for that many cards, preferring host
// 402342 (the machine measured in docs/knowledge/gpu-measurements.md#costs-and-downloads, $0.519/h). Vast re-issues
// offer ids every few minutes, so a price agreed from a list goes stale before it can be taken: the offers are looked
// up live and the candidates tried in order until one is actually taken. Run it with SIMPLE_CHAT_RENT_DRY_RUN=1 or
// --print-body first -- that names the offers it would take, at their present prices, and the exact request that
// takes one, which is what the owner is agreeing to, and it spends nothing. Renting is theirs to approve; this script
// only carries it out.
// `--show ID`, `--start ID` and `--destroy ID` are the other end of a rental, and `--find LABEL HOST` looks for what a
// create not known to have made nothing made, below. The API key, the public key and the onstart script are never
// printed.
//
// What to ask for and what an offer costs is in local/rent-plan.ts, with tests; this file does the fetching.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOT_SECONDS, MAX_DPH_BY_GPUS, ONSTART_MAX_BYTES, REQUEST_MS, chooseOffers, createBody, createdBy, destroyInstance, emptyReason,
  instanceState, offerQuery, readList, redactedBody, rentPlan, sessionCost, sshRoute, startInstance } from '../local/rent-plan.ts';

const ATTEMPTS = 4;
// After a create whose answer named no instance: four reads of the account's list, ten seconds apart.
const LOOKS = 4, LOOK_MS = 10000;
// Every request carries a deadline. A search that never answers would hang with the owner watching; a create
// request that never answers is worse, because the machine it asked for may be billing already.
const SEARCH_TIMEOUT_MS = 30000;
const RENT_TIMEOUT_MS = 60000;

const args = process.argv.slice(2);
const key = process.env.SIMPLE_CHAT_VAST_API_KEY?.trim();
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
const dryRun = process.env.SIMPLE_CHAT_RENT_DRY_RUN === '1';

// One page of the account's instances, as `readList` in local/rent-plan.ts asks for it: Vast's v1 list, 25 a page, the
// most it gives, in the order of their IDs, as vast-cli asks for them. A page after the first waits a second and a
// tenth first, since Vast refuses requests to one endpoint more often than once a second (429, "threshold=1.0").
// `status: 0` is no answer, and the body is never printed.
const page = async after => {
  if (after !== null) await new Promise(done => setTimeout(done, 1100));
  const query = `limit=25&order_by=${encodeURIComponent(JSON.stringify([{ col: 'id', dir: 'asc' }]))}`
    + (after === null ? '' : `&after_token=${encodeURIComponent(after)}`);
  try {
    const response = await fetch(`https://console.vast.ai/api/v1/instances/?${query}`, { headers, signal: AbortSignal.timeout(REQUEST_MS) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
};
// A create's label is `simple-chat-LANE-MS`, MS the moment before its request in epoch milliseconds (below).
const LABEL = /^simple-chat-(both|text|pictures|small)-([1-9]\d{12})$/;

// `--find LABEL HOST` reads the account's list once through and names what the create of that label on that host made
// (`createdBy`), for the runbook's sweeper of a create not known to have made nothing: `listed` with the IDs, none
// if the list holds none of it, or `list_unclear` if the list cannot be read or cannot tell. It only reads, dry run
// or not.
if (args[0] === '--find') {
  const [, label, host] = args;
  if (args.length !== 3 || !LABEL.test(label) || !/^[1-9]\d{0,11}$/.test(host)) {
    console.log(JSON.stringify({ event: 'bad_arguments', usage: 'rent.mjs --find LABEL HOST, as `attempt_uncertain` printed them' }));
    process.exit(1);
  }
  if (!key) { console.log(JSON.stringify({ event: 'no_key' })); process.exit(1); }
  const records = await readList(page);
  const found = records && createdBy(records, label, host, Number(LABEL.exec(label)[2]) / 1000);
  console.log(JSON.stringify(found ? { event: 'listed', label, found: found.map(Number), instances: records.length }
    : { event: 'list_unclear', label, reason: records ? 'cannot tell' : 'unreadable' }));
  process.exit(found ? 0 : 1);
}

// `--show ID` and `--destroy ID` reach one rental with the account's key and nothing on the machine: not its ssh, not
// the key Vast gave the container, not its guard (trial-onstart.sh), any of which may be what failed. They end every
// rental of the identity runbook (docs/identity-experiment.md#termination). Nothing picks an instance by
// itself: the ID is always given, the one `rented` printed. `--show` reads it once. `--destroy` keeps to five minutes
// on its own clock, whatever Vast answers: the guard's minute of reads, then deletes with the account's key until a
// read says the instance is gone (`destroyInstance`, which keeps the time; this file only fetches). So a key that may
// not delete raises no alarm over a machine the guard has deleted. The delete's own `success` is no read, and a
// stopped instance is not gone either, since its disk is kept and billed. A key without the right to delete is not
// answered by asking again: the owner deletes it in the console. With SIMPLE_CHAT_RENT_DRY_RUN=1 it reads once and
// deletes nothing. `--start` resumes a stopped rental with the same key, for simple-serving's first rental when the
// card's own key cannot (`startInstance`, which keeps its twenty minutes); its dry run reads once and asks nothing.
if (args[0] === '--show' || args[0] === '--start' || args[0] === '--destroy') {
  const [mode, id] = args;
  if (args.length !== 2 || !/^[1-9]\d{0,11}$/.test(id)) {
    console.log(JSON.stringify({ event: 'bad_arguments', usage: 'rent.mjs --show ID | --start ID | --destroy ID, the ID `rented` printed' }));
    process.exit(1);
  }
  if (!key) { console.log(JSON.stringify({ event: 'no_key' })); process.exit(1); }
  const url = `https://console.vast.ai/api/v0/instances/${id}/`;
  // One request of `ms` at most: the signal cuts the answer's body as well as the wait for it. `status: 0` is no
  // answer, as below. The body is never printed, only what `instanceState` keeps of it.
  const ask = async (method, ms, sent) => {
    try {
      const response = await fetch(url, { method, signal: AbortSignal.timeout(ms), ...(sent
        ? { headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(sent) } : { headers }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch { return { status: 0, body: null }; }
  };
  const read = async ms => { const { status, body } = await ask('GET', ms); return instanceState(id, status, body); };
  const outcome = async (method, ms, sent) => {
    const { status, body } = await ask(method, ms, sent);
    return { status, success: typeof body?.success === 'boolean' ? body.success : null };
  };
  // `--show` adds where ssh reaches the instance (`sshRoute`): an address and a port, nothing else of the record.
  if (mode === '--show' || dryRun) {
    const { status, body } = await ask('GET', REQUEST_MS);
    const seen = instanceState(id, status, body);
    const event = { '--show': 'instance', '--start': 'would_start', '--destroy': 'would_destroy' }[mode];
    console.log(JSON.stringify({ event, instance: id, ...seen, ...(mode === '--show' ? { ssh: sshRoute(id, status, body) } : {}) }));
    process.exit(seen.state === 'unknown' ? 1 : 0);
  }
  const clock = { now: () => performance.now(), sleep: ms => new Promise(done => setTimeout(done, ms)),
    log: event => console.log(JSON.stringify({ ...event, instance: id })) };
  if (mode === '--start') {
    const end = await startInstance({ read, resume: ms => outcome('PUT', ms, { state: 'running' }), ...clock });
    console.log(JSON.stringify({ ...end, instance: id }));
    process.exit(end.event === 'start_confirmed' ? 0 : 1);
  }
  const end = await destroyInstance({ read, remove: ms => outcome('DELETE', ms), ...clock });
  const confirmed = end.event === 'destroy_confirmed';
  console.log(JSON.stringify({ ...end, instance: id,
    ...(confirmed ? {} : { tell: 'the owner, now: the deletion is not confirmed, and the instance may still be billing' }) }));
  process.exit(confirmed ? 0 : 1);
}

const printBody = args.includes('--print-body');
const rest = args.filter(argument => argument !== '--print-body');
// `--lane text` and `--lane pictures` rent one single-card machine for one lane: a session on two machines runs
// this script twice. Without it the machine is for both lanes, with one card or two. `--lane small` is any
// Blackwell card of 16 GB or more, the 5090's architecture, for Gemma 4 E2B on vLLM.
// `--avoid-host ID[,ID...]` leaves out hosts: the second machine of a two-machine session must not be the first one's
// twin on the same box, or the "two independent machines" the owner asked for share a link, a disk and a failure.
// A replacement names two: the host it replaces and the other lane's. On 2026-09-23 the measured text host drew
// 525 W on a card our idle server did not touch, and with one ID the next in line was the picture machine's host.
// `--hours 1|2|3` is when trial-onstart.sh's guard deletes the machine, three hours unless a session asks for less;
// the guard never extends it, and ends it sooner when told to (docs/identity-experiment.md#termination,
// "we're done"). A session that gives its hours is priced by them (`rentPlan`), and `--qwen only` prices a picture
// machine by Qwen's files alone, which is what SIMPLE_CHAT_IMAGE_QWEN=only pulls. `--max-session DOLLARS` holds a rent
// to the quote its budget was checked against: an offer whose session (below) costs more is not tried, whatever the
// search returns by then. `--upload-gb GB` is what the session brings back from the machine, which each offer's
// session prices at its host's outbound rate; a quote and its rent give the same. `--traffic-factor N` prices N times
// the traffic expected both ways, for a download begun again. `--pending DIR` keeps a record of each create in DIR
// from before its request (below).
const options = { '--gpus': '1', '--lane': 'both', '--avoid-host': '', '--hours': '', '--qwen': '', '--max-session': null, '--upload-gb': '0',
  '--traffic-factor': '1', '--pending': '' };
let known = rest.length % 2 === 0;
for (let at = 0; known && at < rest.length; at += 2) {
  if (Object.hasOwn(options, rest[at])) options[rest[at]] = rest[at + 1]; else known = false;
}
const gpus = Number(options['--gpus']), lane = options['--lane'], hours = Number(options['--hours'] || 3);
const avoidHosts = options['--avoid-host'] === '' ? [] : options['--avoid-host'].split(',');
if (!avoidHosts.every(host => /^[1-9]\d*$/.test(host)) || !/^[123]?$/.test(options['--hours'])
  || !/^(only)?$/.test(options['--qwen'])
  || (options['--max-session'] !== null && !(/^\d+(\.\d{1,2})?$/.test(options['--max-session']) && Number(options['--max-session']) > 0))
  || !/^\d+(\.\d{1,3})?$/.test(options['--upload-gb']) || !/^([1-9]|10)$/.test(options['--traffic-factor'])
  || (options['--pending'] !== '' && !options['--pending'].startsWith('/'))) known = false;
const maxSession = options['--max-session'] === null ? null : Number(options['--max-session']);
const pending = options['--pending'] || null;
let plan = null;
try {
  if (known && MAX_DPH_BY_GPUS[gpus]) {
    plan = rentPlan({ gpus, lane, ...(options['--hours'] ? { hours } : {}), qwenOnly: options['--qwen'] === 'only',
      uploadGb: Number(options['--upload-gb']), trafficFactor: Number(options['--traffic-factor']) });
  }
} catch { /* reported below */ }
if (!plan) {
  console.log(JSON.stringify({ event: 'bad_arguments', usage: 'rent.mjs [--gpus 1|2] [--lane both|text|pictures|small] [--avoid-host ID[,ID...]] '
    + '[--hours 1|2|3] [--qwen only] [--max-session DOLLARS] [--upload-gb GB] [--traffic-factor 1-10] [--pending DIR] [--print-body] '
    + '| --show ID | --start ID | --destroy ID | --find LABEL HOST' }));
  process.exit(1);
}
// --print-body is reviewed before a rental, so it must not need the API key to be exported.
if (!key && !printBody) { console.log(JSON.stringify({ event: 'no_key' })); process.exit(1); }
// The hours the session is priced by, and what an offer costs over them, the hours and the traffic together.
const sessionHours = Math.round(plan.sessionHours * 100) / 100;
const session = offer => sessionCost(offer, plan);

// The key is read before --print-body prints anything, because the body carries it. A key that has not been made
// yet is an ordinary outcome of this script, not a crash: --print-body is run on a machine where nothing is set up.
const publicKey = await readFile(join(homedir(), '.ssh', 'simple_chat_vast_ed25519.pub'), 'utf8')
  .then(text => text.trim())
  .catch(() => null);
if (publicKey === null) { console.log(JSON.stringify({ event: 'no_public_key' })); process.exit(1); }
if (!publicKey.startsWith('ssh-ed25519 ') || publicKey.includes('\n') || publicKey.includes("'")) {
  console.log(JSON.stringify({ event: 'bad_public_key' })); process.exit(1);
}
// Beside this file, not below the working directory: the script is run from wherever the owner happens to be.
const script = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'trial-onstart.sh'), 'utf8');
const lines = script.split('\n');
// The key and the rental's length are set as shell variables ahead of the script's own body, so neither depends on
// Vast passing environment variables through.
const onstart = [lines[0], `SIMPLE_CHAT_SSH_PUBLIC_KEY='${publicKey}'`, `SIMPLE_CHAT_TRIAL_SECONDS=${hours * 3600}`, ...lines.slice(1)].join('\n');
if (Buffer.byteLength(onstart) > ONSTART_MAX_BYTES) {
  console.log(JSON.stringify({ event: 'onstart_too_long', bytes: Buffer.byteLength(onstart), limit: ONSTART_MAX_BYTES }));
  process.exit(1);
}
const body = createBody({ plan, onstart });

// The request that spends the money, with the key and the script left out of it. It is printed before the search so
// that it can be reviewed even on a day when no offer fits, and the search is skipped without an API key.
if (printBody) {
  console.log(JSON.stringify({ event: 'create_request', method: 'PUT', url: 'https://console.vast.ai/api/v0/asks/<offer>/',
    gpus: plan.gpus, lane: plan.lane, hours, maxHour: plan.maxHour, minRamGb: plan.minRamGb, sessionHours,
    sessionGb: Math.round(plan.sessionBytes / 1e9), body: redactedBody(body) }));
  if (!key) process.exit(0);
}

// `status: 0` is no answer at all: a timeout, a refused connection, or a body that is not the JSON it claims.
let offers = null, searchStatus = 0;
try {
  const search = await fetch('https://console.vast.ai/api/v0/bundles/?q=' + encodeURIComponent(JSON.stringify(offerQuery(plan))),
    { headers, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  searchStatus = search.status;
  if (search.ok) offers = (await search.json()).offers ?? [];
} catch { /* offers stays null; nothing was rented, so the search can simply be reported and repeated */ }
if (offers === null) { console.log(JSON.stringify({ event: 'search_failed', status: searchStatus })); process.exit(1); }

// The port count and the container's share of the machine's RAM are checked here too: a query field the API does not
// know is ignored silently, and those two rules are each worth more than a rental.
const choice = chooseOffers(offers, plan);
const { offered, withinPrice, droppedForUnknownPrice, droppedForCountry, droppedForFewCores,
  droppedForProxyOnly, droppedForRam } = choice;
const avoided = choice.candidates.filter(offer => !avoidHosts.includes(String(offer.host)));
const droppedForHost = choice.candidates.length - avoided.length;
const candidates = maxSession === null ? avoided : avoided.filter(offer => session(offer) <= maxSession);
const droppedForSession = avoided.length - candidates.length;
// A rule that drops offers says so: silence would read as "nothing was excluded". The counts are a chain -- what
// the search returned, what the price left, then each later rule -- and `chosen` is what is left to try, which is
// not `withinPrice`: the price is only the first rule of four.
console.log(JSON.stringify({ event: 'candidates', offered, withinPrice, chosen: candidates.length,
  maxHour: plan.maxHour, gpus: plan.gpus, lane: plan.lane, sessionHours, droppedForUnknownPrice, droppedForCountry, droppedForFewCores, droppedForProxyOnly,
  minDirectPorts: plan.minDirectPorts, droppedForRam, minRamGb: plan.minRamGb, droppedForHost, avoidHost: avoidHosts.join(',') || null,
  droppedForSession, maxSession, uploadGb: plan.uploadBytes / 1e9, trafficFactor: plan.trafficFactor }));
// Which rule emptied the list, so that a session lost to an empty search, to cores, to ports or to RAM is not read
// as a price to raise.
if (!candidates.length) {
  console.log(JSON.stringify({ event: avoided.length ? 'none_within_max_session' : choice.candidates.length ? 'only_the_avoided_host' : emptyReason(choice) }));
  process.exit(1);
}

// SIMPLE_CHAT_RENT_DRY_RUN=1 shows what would be taken and spends nothing. Checking a change to this script by
// running it would otherwise mean renting a machine, and the offers it would have chosen are what the owner is
// being asked to approve anyway. `session` is that approval's sum for each: the offer's hour over the session's
// hours, and its traffic.
if (dryRun || printBody) {
  for (const { exact, ...offer } of candidates.slice(0, ATTEMPTS)) console.log(JSON.stringify({ event: 'would_try', ...offer, session: session({ exact }) }));
  process.exit(0);
}

// With `--pending DIR`, each create has a record there from before its request, `LABEL HOST DESTROYBY` in
// DIR/pending-LABEL, written whole or not at all, so that a create this script cannot resolve, or does not outlive, is
// found by the runbook's sweeper (`--find` above). Only a refusal, which made nothing, removes it here; the runbook
// removes a rented card's once the card's watchdog holds, and one not known to have made nothing stays for the sweeper.
// A record that cannot be written stops the rent before its request.
const record = async (label, host, destroyBy) => {
  const file = join(pending, `pending-${label}`), draft = join(pending, `.pending-${label}`);
  await writeFile(draft, `${label} ${host} ${destroyBy}\n`, { mode: 0o600 });
  await rename(draft, file);
  return file;
};

for (const offer of candidates.slice(0, ATTEMPTS)) {
  const machine = {
    offer: offer.id, host: offer.host, gpu: offer.gpu, geo: offer.geo, hour: offer.hour, download: offer.download, upload: offer.upload,
    driver: offer.driver, cpus: offer.cpus, ramGb: offer.ramGb, inetDownMbps: offer.inetDownMbps,
    reliability: offer.reliability, directPorts: offer.directPorts,
  };
  // A machine whose host is not a number could not be looked for on its host after an uncertain answer.
  if (!/^[1-9]\d{0,11}$/.test(String(offer.host))) {
    console.log(JSON.stringify({ event: 'attempt_failed', ...machine, instance: null, reason: 'no host id' }));
    continue;
  }
  let status = 0, parsed = null;
  // The moment before the request that may create the machine: none of it exists before, so a deadline counted from
  // here is never late, however long the answer takes. The label, this request's own, finds the machine in the
  // account's list if the answer does not name it. `destroyBy` is the operator's own deadline on this machine's clock,
  // in epoch seconds: the guard's hours and the quarter of an hour allowed for the box to start. Whatever the box says,
  // the rental's termination begins then at the latest (docs/identity-experiment.md#one-hour), and a machine found in
  // the list after an uncertain answer keeps it, since it was asked for at the same moment.
  const asked = Date.now(), label = `simple-chat-${plan.lane}-${asked}`;
  const destroyBy = Math.floor(asked / 1000) + hours * 3600 + BOOT_SECONDS;
  let file = null;
  if (pending) {
    try { file = await record(label, offer.host, destroyBy); } catch {
      console.log(JSON.stringify({ event: 'pending_unwritable', ...machine, instance: null }));
      process.exit(1);
    }
  }
  try {
    const response = await fetch(`https://console.vast.ai/api/v0/asks/${offer.id}/`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, label }),
      signal: AbortSignal.timeout(RENT_TIMEOUT_MS),
    });
    status = response.status;
    const text = await response.text();
    try { parsed = JSON.parse(text); } catch { /* status alone describes a non-JSON body */ }
  } catch { /* status stays 0: the request may have reached Vast all the same */ }
  const rented = status >= 200 && status < 300 && parsed?.success !== false && parsed?.new_contract;
  if (rented) {
    console.log(JSON.stringify({ event: 'rented', ...machine, instance: parsed.new_contract, reason: null, label, destroyBy, session: session(offer) }));
    process.exit(0);
  }
  // A refusal is a 4xx whose body says what was refused, and only a refusal is safe to answer by renting the next
  // offer. Anything else -- no answer at all, a 5xx, or an answer that names no contract -- may have created an
  // instance that is billing now, and a second PUT would leave it running unwatched. So the account's list is read for
  // it (`readList`, `createdBy`), and the one instance found is this rental, printed as `rented` so that its watchdog
  // starts like any other's. None found, more than one, or a list that cannot be read or cannot tell, and the create
  // stays unresolved: nothing more is rented, the owner looks, and the runbook's sweeper takes its record (exit 3).
  const refused = status >= 400 && status < 500 && typeof parsed === 'object' && parsed !== null
    && (typeof parsed.error === 'string' || typeof parsed.msg === 'string' || parsed.success === false);
  if (!refused) {
    let found = null, listed = 0;
    for (let look = 0; look < LOOKS && !found?.length; look++) {
      if (look) await new Promise(done => setTimeout(done, LOOK_MS));
      const records = await readList(page);
      const seen = records && createdBy(records, label, offer.host, asked / 1000);
      if (seen) { listed++; found = seen; }
    }
    if (found?.length === 1) {
      console.log(JSON.stringify({ event: 'rented', ...machine, instance: Number(found[0]), reason: null, adopted: true, status,
        label, destroyBy, session: session(offer) }));
      process.exit(0);
    }
    console.log(JSON.stringify({ event: 'attempt_uncertain', ...machine, status,
      reason: status === 0 ? 'no answer' : status >= 200 && status < 300 ? 'no instance named' : `status ${status}`,
      listed, found: (found ?? []).map(Number), label, destroyBy, pending: file, check: 'the instance list on console.vast.ai' }));
    process.exit(3);
  }
  if (file) await rm(file, { force: true }).catch(() => undefined);
  console.log(JSON.stringify({ event: 'attempt_failed', ...machine, instance: null,
    reason: typeof parsed?.msg === 'string' && parsed.msg.length <= 200 ? parsed.msg : `status ${status}` }));
}
console.log(JSON.stringify({ event: 'all_attempts_failed' }));
process.exit(1);
