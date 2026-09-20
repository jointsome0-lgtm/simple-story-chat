// Rents one RTX 5090 at or below $0.55/h, preferring host 402342 (the machine measured in docs/gpu.md, $0.519/h).
// Vast re-issues offer ids every few minutes, so a price agreed from a list goes stale before it can be taken: the
// offers are looked up live and the candidates tried in order until one is actually taken. Run it with
// SIMPLE_CHAT_RENT_DRY_RUN=1 first -- that names the offers it would take, at their present prices, which is what
// the owner is agreeing to, and it spends nothing. Renting is theirs to approve; this script only carries it out.
// The API key and the public key are never printed.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFERRED_HOST = 402342;
// The owner approved $0.52/h. This ceiling admits that machine and its immediate neighbours, and refuses to spend
// more than was agreed if every cheap offer has gone.
const MAX_HOUR = 0.55;
const IMAGE = 'vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07';
const DISK = 60;
const ATTEMPTS = 4;

const key = process.env.SIMPLE_CHAT_VAST_API_KEY?.trim();
if (!key) { console.log(JSON.stringify({ event: 'no_key' })); process.exit(1); }
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };

const publicKey = (await readFile(join(homedir(), '.ssh', 'simple_chat_vast_ed25519.pub'), 'utf8')).trim();
if (!publicKey.startsWith('ssh-ed25519 ') || publicKey.includes('\n') || publicKey.includes("'")) {
  console.log(JSON.stringify({ event: 'bad_public_key' })); process.exit(1);
}
// Beside this file, not below the working directory: the script is run from wherever the owner happens to be.
const script = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'trial-onstart.sh'), 'utf8');
const lines = script.split('\n');
// The key is set as a shell variable ahead of the script's own body, so installing it does not depend on Vast
// passing environment variables through.
const onstart = [lines[0], `SIMPLE_CHAT_SSH_PUBLIC_KEY='${publicKey}'`, ...lines.slice(1)].join('\n');

// Direct ports are asked for, and asked for again below. A machine without them is reachable only through vast's
// proxy, and on 2026-09-20 one such rental refused the account's own key for its whole life, with nothing about it
// repairable from outside (docs/gpu.md, "Preparing the server"). It cost half an hour and produced no scene. Two
// ports is the least that is useful: one carries ssh, one is spare.
const MIN_DIRECT_PORTS = 2;
const query = {
  gpu_name: { eq: 'RTX 5090' }, num_gpus: { eq: 1 }, gpu_ram: { gte: 32000 },
  disk_space: { gte: 60 }, cuda_max_good: { gte: 12.8 }, rentable: { eq: true }, verified: { eq: true },
  rented: { eq: false }, reliability2: { gte: 0.97 }, inet_down: { gte: 300 },
  direct_port_count: { gte: MIN_DIRECT_PORTS },
  type: 'on-demand', order: [['dph_total', 'asc']], limit: 60,
};
const search = await fetch('https://console.vast.ai/api/v0/bundles/?q=' + encodeURIComponent(JSON.stringify(query)), { headers });
if (!search.ok) { console.log(JSON.stringify({ event: 'search_failed', status: search.status })); process.exit(1); }

const WEIGHTS_TB = 25201484928 / 1e12;
const offered = ((await search.json()).offers ?? [])
  .map(o => ({
    id: o.id, host: o.host_id, geo: o.geolocation, driver: o.driver_version,
    directPorts: Number(o.direct_port_count ?? 0),
    cpus: o.cpu_cores_effective ? Math.round(o.cpu_cores_effective) : null,
    inetDownMbps: Math.round(o.inet_down ?? 0), reliability: Math.round((o.reliability2 ?? 0) * 1000) / 1000,
    hour: Math.round(((o.dph_total ?? 0) + (o.storage_cost ?? 0) * 60 / 730) * 1000) / 1000,
    download: Math.round((o.inet_down_cost ?? 0) * WEIGHTS_TB * 1000 * 100) / 100,
  }));
// The port count is checked here too: a query field the API does not know is ignored silently, and this rule is
// worth more than a rental.
const affordable = offered.filter(o => o.hour <= MAX_HOUR && (o.cpus === null || o.cpus >= 4));
const candidates = affordable.filter(o => o.directPorts >= MIN_DIRECT_PORTS)
  // The owner's machine first; then cheapest total for a 45-minute session.
  .sort((a, b) => (b.host === PREFERRED_HOST) - (a.host === PREFERRED_HOST)
    || (a.hour * 0.75 + a.download) - (b.hour * 0.75 + b.download));

// A rule that drops offers says so: silence would read as "nothing was excluded".
console.log(JSON.stringify({ event: 'candidates', withinPrice: candidates.length, maxHour: MAX_HOUR,
  droppedForProxyOnly: affordable.length - candidates.length, minDirectPorts: MIN_DIRECT_PORTS }));
if (!candidates.length) { console.log(JSON.stringify({ event: 'none_within_price' })); process.exit(1); }

// SIMPLE_CHAT_RENT_DRY_RUN=1 shows what would be taken and spends nothing. Checking a change to this script by
// running it would otherwise mean renting a machine, and the offers it would have chosen are what the owner is
// being asked to approve anyway.
if (process.env.SIMPLE_CHAT_RENT_DRY_RUN === '1') {
  for (const offer of candidates.slice(0, ATTEMPTS)) console.log(JSON.stringify({ event: 'would_try', ...offer }));
  process.exit(0);
}

for (const offer of candidates.slice(0, ATTEMPTS)) {
  const response = await fetch(`https://console.vast.ai/api/v0/asks/${offer.id}/`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'me', image: IMAGE, disk: DISK, runtype: 'ssh', onstart, use_jupyter_lab: false }),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* status alone describes a non-JSON body */ }
  const ok = response.ok && body?.success !== false && body?.new_contract;
  console.log(JSON.stringify({
    event: ok ? 'rented' : 'attempt_failed', offer: offer.id, host: offer.host, geo: offer.geo,
    hour: offer.hour, download: offer.download, driver: offer.driver, cpus: offer.cpus,
    inetDownMbps: offer.inetDownMbps, reliability: offer.reliability, directPorts: offer.directPorts,
    instance: body?.new_contract ?? null,
    reason: ok ? null : typeof body?.msg === 'string' && body.msg.length <= 200 ? body.msg : `status ${response.status}`,
  }));
  if (ok) process.exit(0);
}
console.log(JSON.stringify({ event: 'all_attempts_failed' }));
process.exit(1);
