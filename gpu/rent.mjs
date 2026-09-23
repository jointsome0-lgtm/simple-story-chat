// Rents one machine with RTX 5090s -- one card by default, `--gpus 2` for the session that runs the language lane
// and the image lane side by side -- at or below the price the owner approved for that many cards, preferring host
// 402342 (the machine measured in docs/gpu.md, $0.519/h). Vast re-issues offer ids every few minutes, so a price
// agreed from a list goes stale before it can be taken: the offers are looked up live and the candidates tried in
// order until one is actually taken. Run it with SIMPLE_CHAT_RENT_DRY_RUN=1 or --print-body first -- that names the
// offers it would take, at their present prices, and the exact request that takes one, which is what the owner is
// agreeing to, and it spends nothing. Renting is theirs to approve; this script only carries it out.
// The API key, the public key and the onstart script are never printed.
//
// What to ask for and what an offer costs is in local/rent-plan.ts, with tests; this file does the fetching.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_DPH_BY_GPUS, chooseOffers, createBody, emptyReason, offerQuery, redactedBody, rentPlan } from '../local/rent-plan.ts';

const ATTEMPTS = 4;
// Every request carries a deadline. A search that never answers would hang with the owner watching; a create
// request that never answers is worse, because the machine it asked for may be billing already.
const SEARCH_TIMEOUT_MS = 30000;
const RENT_TIMEOUT_MS = 60000;

const args = process.argv.slice(2);
const printBody = args.includes('--print-body');
const rest = args.filter(argument => argument !== '--print-body');
// `--lane text` and `--lane pictures` rent one single-card machine for one lane: a session on two machines runs
// this script twice. Without it the machine is for both lanes, with one card or two.
// `--avoid-host ID[,ID...]` leaves out hosts: the second machine of a two-machine session must not be the first one's
// twin on the same box, or the "two independent machines" the owner asked for share a link, a disk and a failure.
// A replacement names two: the host it replaces and the other lane's. On 2026-09-23 the measured text host drew
// 525 W on a card our idle server did not touch, and with one ID the next in line was the picture machine's host.
const options = { '--gpus': '1', '--lane': 'both', '--avoid-host': '' };
let known = rest.length % 2 === 0;
for (let at = 0; known && at < rest.length; at += 2) {
  if (Object.hasOwn(options, rest[at])) options[rest[at]] = rest[at + 1]; else known = false;
}
const gpus = Number(options['--gpus']), lane = options['--lane'];
const avoidHosts = options['--avoid-host'] === '' ? [] : options['--avoid-host'].split(',');
if (!avoidHosts.every(host => /^[1-9]\d*$/.test(host))) known = false;
let plan = null;
try { if (known && MAX_DPH_BY_GPUS[gpus]) plan = rentPlan({ gpus, lane }); } catch { /* reported below */ }
if (!plan) {
  console.log(JSON.stringify({ event: 'bad_arguments', usage: 'rent.mjs [--gpus 1|2] [--lane both|text|pictures] [--avoid-host ID[,ID...]] [--print-body]' }));
  process.exit(1);
}
// --print-body is reviewed before a rental, so it must not need the API key to be exported.
const key = process.env.SIMPLE_CHAT_VAST_API_KEY?.trim();
if (!key && !printBody) { console.log(JSON.stringify({ event: 'no_key' })); process.exit(1); }
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };

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
// The key is set as a shell variable ahead of the script's own body, so installing it does not depend on Vast
// passing environment variables through.
const onstart = [lines[0], `SIMPLE_CHAT_SSH_PUBLIC_KEY='${publicKey}'`, ...lines.slice(1)].join('\n');
const body = createBody({ plan, onstart });

// The request that spends the money, with the key and the script left out of it. It is printed before the search so
// that it can be reviewed even on a day when no offer fits, and the search is skipped without an API key.
if (printBody) {
  console.log(JSON.stringify({ event: 'create_request', method: 'PUT', url: 'https://console.vast.ai/api/v0/asks/<offer>/',
    gpus: plan.gpus, lane: plan.lane, maxHour: plan.maxHour, minRamGb: plan.minRamGb, sessionHours: plan.sessionHours,
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
const candidates = choice.candidates.filter(offer => !avoidHosts.includes(String(offer.host)));
const droppedForHost = choice.candidates.length - candidates.length;
// A rule that drops offers says so: silence would read as "nothing was excluded". The counts are a chain -- what
// the search returned, what the price left, then each later rule -- and `chosen` is what is left to try, which is
// not `withinPrice`: the price is only the first rule of four.
console.log(JSON.stringify({ event: 'candidates', offered, withinPrice, chosen: candidates.length,
  maxHour: plan.maxHour, gpus: plan.gpus, lane: plan.lane, droppedForUnknownPrice, droppedForCountry, droppedForFewCores, droppedForProxyOnly,
  minDirectPorts: plan.minDirectPorts, droppedForRam, minRamGb: plan.minRamGb, droppedForHost, avoidHost: avoidHosts.join(',') || null }));
// Which rule emptied the list, so that a session lost to an empty search, to cores, to ports or to RAM is not read
// as a price to raise.
if (!candidates.length) {
  console.log(JSON.stringify({ event: choice.candidates.length ? 'only_the_avoided_host' : emptyReason(choice) }));
  process.exit(1);
}

// SIMPLE_CHAT_RENT_DRY_RUN=1 shows what would be taken and spends nothing. Checking a change to this script by
// running it would otherwise mean renting a machine, and the offers it would have chosen are what the owner is
// being asked to approve anyway.
if (process.env.SIMPLE_CHAT_RENT_DRY_RUN === '1' || printBody) {
  for (const offer of candidates.slice(0, ATTEMPTS)) console.log(JSON.stringify({ event: 'would_try', ...offer }));
  process.exit(0);
}

for (const offer of candidates.slice(0, ATTEMPTS)) {
  const machine = {
    offer: offer.id, host: offer.host, geo: offer.geo, hour: offer.hour, download: offer.download,
    driver: offer.driver, cpus: offer.cpus, ramGb: offer.ramGb, inetDownMbps: offer.inetDownMbps,
    reliability: offer.reliability, directPorts: offer.directPorts,
  };
  let status = 0, parsed = null;
  try {
    const response = await fetch(`https://console.vast.ai/api/v0/asks/${offer.id}/`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RENT_TIMEOUT_MS),
    });
    status = response.status;
    const text = await response.text();
    try { parsed = JSON.parse(text); } catch { /* status alone describes a non-JSON body */ }
  } catch { /* status stays 0: the request may have reached Vast all the same */ }
  const rented = status >= 200 && status < 300 && parsed?.success !== false && parsed?.new_contract;
  if (rented) {
    console.log(JSON.stringify({ event: 'rented', ...machine, instance: parsed.new_contract, reason: null }));
    process.exit(0);
  }
  // A refusal is a status outside 2xx or Vast's own `success: false`, and only a refusal is safe to answer by
  // renting the next offer. Anything else -- no answer at all, or an answer that names no contract -- may have
  // created an instance that is billing now, and a second PUT would leave it running unwatched.
  const refused = (status !== 0 && (status < 200 || status >= 300)) || parsed?.success === false;
  if (!refused) {
    console.log(JSON.stringify({ event: 'attempt_uncertain', ...machine, status,
      reason: status === 0 ? 'no answer' : 'no instance named', check: 'the instance list on console.vast.ai' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ event: 'attempt_failed', ...machine, instance: null,
    reason: typeof parsed?.msg === 'string' && parsed.msg.length <= 200 ? parsed.msg : `status ${status}` }));
}
console.log(JSON.stringify({ event: 'all_attempts_failed' }));
process.exit(1);
