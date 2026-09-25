// The half of gpu/rent.mjs that decides rather than fetches: which offers to ask Vast for, what an offer costs over
// the whole session, in which order to try them, and the exact body that takes one. It lives here so that a change to
// any of it is checked by `npm test` instead of by renting a machine. Nothing in this file touches the network.
//
// Three numbers used to be written down more than once and drifted apart: the disk size (a constant, the offer filter
// and the storage term of the price), the bytes the session downloads (Gemma alone, though it pulls about twice that)
// and the session length the hourly price is weighted by. Each is one field of the plan below now.

// What the owner approved for the machine itself, by card count. A table, not a formula: these are the ranges the
// owner quoted from the live list when this session was planned (one 5090 $0.44-0.53, the machine measured in
// docs/gpu.md inside it at $0.519; two cards in one machine $0.89-0.96, which is cheaper per card than two
// rentals), rounded up so that the top of each range and its immediate neighbours are admitted and nothing dearer
// is. A count with no agreed rate is refused rather than guessed. One card went up to $0.65 on 2026-09-24: the only
// offer left under $0.55 was on a host whose card another tenant was already loading.
export const MAX_DPH_BY_GPUS: Record<number, number> = { 1: 0.65, 2: 1.0 };
// Vast bills the disk by the hour beside the machine and offers are judged on the two together, so the ceiling has
// to carry the disk too. Otherwise growing DISK_GB quietly lowers the card price allowed: at 60 GB the old flat
// $0.55 left room for a $0.541 card, at 150 GB the same number refuses the $0.53 top of the quoted range. The rate
// budgeted is the one this repo has actually seen, not the $0.10 per GB per month commonly quoted: the 60 GB
// rental in docs/gpu.md was billed $0.017 an hour for its disk, which is $0.207 per GB per month. At the cheaper
// rate that same $0.53 card is refused again as soon as the host charges what the measured one did.
const STORAGE_PER_GB_MONTH = 0.207;
// The machine measured in docs/gpu.md ($0.519/h) is tried first when it is in the list and still fits the ceiling.
const PREFERRED_HOST = 402342;
const IMAGE = 'vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07';
// The host driver has to run the CUDA the image carries: a 570 driver stops at 12.8, and llama-server built by the
// image's nvcc 13 would then refuse to start on a card it compiled for. `cuda_max_good` is Vast's name for the
// highest CUDA a host's driver runs; this floor moves with the image above and is tied to it by a test.
const CUDA_FLOOR = 13.0;
// The pinned files below (57.2 GB), the build tree, about 6 GB of wheels and packages, and room for the pictures
// and logs the session writes beside them. A single-card session downloads the same files and only runs the two
// lanes one after the other.
const DISK_GB = 150;
// Every byte the session pulls over the host's link, priced at its traffic rate. The summands are the exact sizes
// pinned in gpu/manifest.env (Gemma Q6 and its draft) and gpu/image-manifest.env (the fine-tune, the ComfyUI-native
// text encoder, the VAE and the comparison Turbo checkpoint), plus the wheels; a test reads both manifests so the
// two cannot drift apart. What a default run downloads is what is counted: gpu/image-bootstrap.sh fetches Turbo
// unless SIMPLE_CHAT_IMAGE_TURBO=false and the ComfyUI-native encoder and VAE unless
// SIMPLE_CHAT_IMAGE_SOURCE=official, so the gated bf16 originals are not in the sum and Turbo is. On Vast the
// traffic price differs between machines by a factor of twenty, so this term decides between offers.
// Qwen-Image 2.1 is not here on purpose: SIMPLE_CHAT_IMAGE_QWEN=true adds its 17.28 GB, and a session that means
// to run that comparison prices it by hand rather than pay for it on every rental that does not. A picture machine
// that pulls Qwen alone (SIMPLE_CHAT_IMAGE_QWEN=only, the identity runbook) is priced by its three files: `qwenOnly`.
const TEXT_BYTES = 25201484928 + 514687200, PICTURE_BYTES = 12821743396 + 5242467968 + 253806246 + 13141730784;
const QWEN_BYTES = 7256783064 + 9350798360 + 675509688;
// A session may also be two rented machines with one card and one lane each (the owner's choice, 2026-09-22):
// on the day it was priced two whole single-card machines cost less than one two-card machine with the same RAM,
// each lane keeps a machine's memory to itself, and the two downloads run over two links at once. Each machine is
// then asked for its own lane's disk and priced by its own lane's downloads. `both` is one machine for both lanes,
// with one card or two. Of the 6 GB of wheels and packages, torch is five and belongs to the picture lane. The
// language machine's 60 GB is the disk of the rental measured in docs/gpu.md; the picture machine's 100 GB holds
// the pinned files (31.5 GB), the Qwen opt-in (17.3 GB), torch and ComfyUI (about 13 GB) and the pictures.
export type Lane = 'both' | 'text' | 'pictures';
const LANES: Record<Lane, { diskGb: number; bytes: number }> = {
  both: { diskGb: DISK_GB, bytes: TEXT_BYTES + PICTURE_BYTES + 6000000000 },
  text: { diskGb: 60, bytes: TEXT_BYTES + 1000000000 },
  pictures: { diskGb: 100, bytes: PICTURE_BYTES + 5000000000 },
};
// Hugging Face and CivitAI are not reliably reachable from mainland China, and a session is mostly a download: a
// machine there can pass the speed test and still never fetch the weights. The last part of Vast's `geolocation`
// ("Zhejiang, CN") is the country code.
const BLOCKED_COUNTRIES = ['CN'];
// docs/gpu.md asks for at least 32 GB of RAM for the language lane; the image lane wants its own. This is the
// container's share, not the machine's: a container on the measured 256-core host held 30.72 cores of it. Without a
// floor there is no guarantee that SIMPLE_CHAT_GPU_CACHE_RAM has memory to live in.
const RAM_GB_PER_GPU = 32;
// Two hours and a half: the instance life the session is billed for, not the work window. Work stops about a
// quarter of an hour before teardown and Vast bills until the instance is deleted, so the shorter figure would
// weight the hourly price too lightly. The hourly price is weighted by it against the one-off traffic cost when
// offers are ordered.
const SESSION_HOURS = 2.5;
// A rental given its hours (`--hours`, the guard's) is priced by them instead, and by what the guard does not count.
// It is billed from its creation, and the guard's clock starts only once the image is pulled and the box has started,
// which the operator allows a quarter of an hour (`destroyBy` in gpu/rent.mjs); and it is billed until a destroy is
// read back as done, which gpu/rent.mjs --destroy waits five minutes for while Vast answers.
export const BOOT_SECONDS = 900, DESTROY_SECONDS = 300;
// A machine without direct ports is reachable only through Vast's proxy, and on 2026-09-20 one such rental refused
// the account's own key for its whole life. Two is the least that is useful: one carries ssh, one is spare.
const MIN_DIRECT_PORTS = 2;

export type RentPlan = {
  lane: Lane; gpus: number; maxHour: number; diskGb: number; minRamGb: number; minDirectPorts: number;
  sessionHours: number; sessionBytes: number; image: string; preferredHost: number | null;
  blockedCountries: string[];
};

export function rentPlan({ gpus = 1, lane = 'both', preferredHost = PREFERRED_HOST, hours, qwenOnly = false }:
  { gpus?: number; lane?: Lane; preferredHost?: number | null; hours?: number; qwenOnly?: boolean } = {}): RentPlan {
  const maxDph = MAX_DPH_BY_GPUS[gpus];
  if (maxDph === undefined) throw new Error(`no approved price ceiling for ${gpus} GPUs`);
  if (!Object.hasOwn(LANES, lane)) throw new Error(`no such lane: ${lane}`);
  // One lane is one card: a second card on a machine that runs one server is paid for and idle.
  if (lane !== 'both' && gpus !== 1) throw new Error('a machine for one lane has one card');
  if (qwenOnly && lane !== 'pictures') throw new Error('only a picture machine pulls Qwen alone');
  const { diskGb, bytes } = LANES[lane];
  const maxHour = Math.round((maxDph + STORAGE_PER_GB_MONTH * diskGb / 730) * 1000) / 1000;
  return {
    lane, gpus, maxHour, diskGb, minRamGb: RAM_GB_PER_GPU * gpus, minDirectPorts: MIN_DIRECT_PORTS,
    sessionHours: hours === undefined ? SESSION_HOURS : hours + (BOOT_SECONDS + DESTROY_SECONDS) / 3600,
    // Qwen's files and torch's five gigabytes, the only wheels the picture lane pulls.
    sessionBytes: qwenOnly ? QWEN_BYTES + 5000000000 : bytes, image: IMAGE, preferredHost,
    blockedCountries: BLOCKED_COUNTRIES,
  };
}

// The search is a filter on the host, so everything that can be asked for there is: a query the API does not
// understand is ignored silently, which is why the rules that matter are checked again over the answer.
export function offerQuery(plan: RentPlan) {
  return {
    gpu_name: { eq: 'RTX 5090' }, num_gpus: { eq: plan.gpus }, gpu_ram: { gte: 32000 },
    disk_space: { gte: plan.diskGb }, cpu_ram: { gte: plan.minRamGb * 1000 },
    cuda_max_good: { gte: CUDA_FLOOR }, rentable: { eq: true }, verified: { eq: true },
    rented: { eq: false }, reliability2: { gte: 0.97 }, inet_down: { gte: 300 },
    direct_port_count: { gte: plan.minDirectPorts }, geolocation: { notin: plan.blockedCountries },
    type: 'on-demand', order: [['dph_total', 'asc']], limit: 60,
  };
}

// The fields read from an offer. Vast sends many more and none of them is trusted.
export type RawOffer = {
  id?: unknown; host_id?: unknown; geolocation?: unknown; driver_version?: unknown;
  direct_port_count?: number | null; cpu_cores_effective?: number | null; cpu_ram?: number | null;
  inet_down?: number | null; reliability2?: number | null;
  dph_total?: number | null; storage_cost?: number | null; inet_down_cost?: number | null;
};
export type Offer = {
  id: unknown; host: unknown; geo: unknown; driver: unknown; directPorts: number;
  cpus: number | null; ramGb: number | null; inetDownMbps: number; reliability: number;
  hour: number; download: number;
};

const price = (rate: unknown): number => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : NaN;

// `storage_cost` is dollars per GB per month, `inet_down_cost` dollars per GB, so both are priced for this session's
// disk and this session's downloads rather than for a constant that no longer describes either.
export function describeOffer(offer: RawOffer, plan: RentPlan): Offer {
  return {
    id: offer.id, host: offer.host_id, geo: offer.geolocation, driver: offer.driver_version,
    directPorts: Number(offer.direct_port_count ?? 0),
    cpus: offer.cpu_cores_effective ? Math.round(offer.cpu_cores_effective) : null,
    // `cpu_ram` in a search answer is already this offer's own share of the machine, in MB, like
    // `cpu_cores_effective`: the measured host's one card of eight answers 64469, which the console shows as
    // "64/516 GB". Until 2026-09-23 it was multiplied by `gpu_frac` a second time, which read those 64 GB as 8 and
    // dropped every offer on a machine of several cards, the measured host included. An offer that states no RAM
    // is kept below; rounded down, because a floor is a floor.
    ramGb: typeof offer.cpu_ram === 'number' ? Math.floor(offer.cpu_ram / 1000) : null,
    inetDownMbps: Math.round(offer.inet_down ?? 0), reliability: Math.round((offer.reliability2 ?? 0) * 1000) / 1000,
    // A missing or non-numeric price -- for the machine, for the disk or for the link -- makes the whole offer NaN,
    // which no ceiling admits and chooseOffers counts. Read as zero, the one offer whose cost is unknown would look
    // like the cheapest in the list, sort to the front of the queue and be the first thing rented.
    hour: Math.round((price(offer.dph_total) + price(offer.storage_cost) * plan.diskGb / 730) * 1000) / 1000,
    download: Math.round(price(offer.inet_down_cost) * (plan.sessionBytes / 1e12) * 1000 * 100) / 100,
  };
}

export type Choice = {
  candidates: Offer[]; offered: number; withinPrice: number; droppedForUnknownPrice: number; droppedForCountry: number;
  droppedForFewCores: number; droppedForProxyOnly: number; droppedForRam: number;
};

// Every rule that drops offers reports how many it dropped, and each rule is its own step: a rule folded into
// another one has no count and cannot be named as the reason the list is empty. An unknown core count or container
// RAM is not a reason to drop an offer, only a known-too-small one is.
const countryOf = (geo: unknown) => typeof geo === 'string' ? geo.slice(geo.lastIndexOf(',') + 1).trim().toUpperCase() : '';

export function chooseOffers(offers: RawOffer[], plan: RentPlan): Choice {
  const described = offers.map(offer => describeOffer(offer, plan));
  const priced = described.filter(o => Number.isFinite(o.hour) && Number.isFinite(o.download));
  // Before the price, so that `withinPrice` counts machines the session could actually use.
  const reachable = priced.filter(o => !plan.blockedCountries.includes(countryOf(o.geo)));
  const affordable = reachable.filter(o => o.hour <= plan.maxHour);
  const withCores = affordable.filter(o => o.cpus === null || o.cpus >= 4);
  const withPorts = withCores.filter(o => o.directPorts >= plan.minDirectPorts);
  const candidates = withPorts.filter(o => o.ramGb === null || o.ramGb >= plan.minRamGb)
    // The owner's machine first; then cheapest for this session, hours and traffic together.
    .sort((a, b) => Number(b.host === plan.preferredHost) - Number(a.host === plan.preferredHost)
      || (a.hour * plan.sessionHours + a.download) - (b.hour * plan.sessionHours + b.download));
  return {
    candidates, offered: described.length, withinPrice: affordable.length,
    droppedForUnknownPrice: described.length - priced.length, droppedForCountry: priced.length - reachable.length,
    droppedForFewCores: affordable.length - withCores.length,
    droppedForProxyOnly: withCores.length - withPorts.length, droppedForRam: withPorts.length - candidates.length,
  };
}

export type EmptyReason =
  'none_offered' | 'none_in_reachable_country' | 'none_within_price' | 'none_with_enough_cores' | 'none_with_direct_ports' | 'none_with_enough_ram';

// Which rule emptied the list, for the one line the owner is left with. A search that answered with nothing at all,
// and the rules on cores, ports and RAM, all drop offers the price never judged; reporting any of them as a price
// failure sends the next attempt to change the wrong number.
export function emptyReason(choice: Choice): EmptyReason {
  if (choice.offered === 0) return 'none_offered';
  if (choice.droppedForCountry > 0 && choice.offered - choice.droppedForUnknownPrice === choice.droppedForCountry) return 'none_in_reachable_country';
  if (choice.withinPrice === 0) return 'none_within_price';
  const withCores = choice.withinPrice - choice.droppedForFewCores;
  if (withCores === 0) return 'none_with_enough_cores';
  if (withCores === choice.droppedForProxyOnly) return 'none_with_direct_ports';
  return 'none_with_enough_ram';
}

export type CreateBody = {
  client_id: string; image: string; disk: number; runtype: string; onstart: string;
  use_jupyter_lab: boolean; env: Record<string, string>;
};

// `ssh_direc ssh_proxy` is how Vast's own client asks for direct ssh while keeping the proxy as a fallback, and the
// port mapping says the same thing a second way: the empty `direct_port_start 65535 / direct_port_end -1` range of
// the 2026-09-20 rental describes the ports that rental asked for, and it asked for none. Only ssh is published;
// llama-server keeps listening on 127.0.0.1 and reaches the bot through the tunnel.
export function createBody({ plan, onstart }: { plan: RentPlan; onstart: string }): CreateBody {
  return {
    client_id: 'me', image: plan.image, disk: plan.diskGb, runtype: 'ssh_direc ssh_proxy',
    onstart, use_jupyter_lab: false, env: { '-p 22:22': '1' },
  };
}

// What --print-body shows: every field that decides what is rented, and in place of the onstart script its size
// alone. That script carries the account's public key and the trial guard, neither of which belongs in a terminal
// the owner may paste from.
export function redactedBody(body: CreateBody): CreateBody {
  const lines = body.onstart === '' ? 0 : body.onstart.split('\n').length;
  return { ...body, onstart: `[redacted: ${lines} lines, ${Buffer.byteLength(body.onstart)} bytes, ssh key inside]` };
}

// One read of a rental by its ID (GET /api/v0/instances/ID/, gpu/rent.mjs --show and --destroy), and whether it says
// the instance is gone. Two answers do: a 404, and a 200 whose `instances` is null. Vast documents neither for a
// destroyed instance (docs/illustrations-plan.md, "Not verified without a card"), so everything else is `unknown`, a
// destroy never ends on it, and the operator hears that the deletion is not confirmed rather than that it is done:
// no answer, another status, a body without `instances`, or the record of another ID. A record carries the machine's
// address and ports as well; of it only two status words are kept, and a value that is not a plain word is dropped.
export type InstanceState = { state: 'present' | 'gone' | 'unknown'; status: number; actual: string | null; intended: string | null };
export function instanceState(id: string, status: number, body: unknown): InstanceState {
  const record = status === 200 && typeof body === 'object' && body !== null && 'instances' in body ? body.instances : undefined;
  if (status === 404 || record === null) return { state: 'gone', status, actual: null, intended: null };
  if (typeof record !== 'object' || String((record as { id?: unknown }).id) !== id) {
    return { state: 'unknown', status, actual: null, intended: null };
  }
  const word = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : null;
  const { actual_status: actual, intended_status: intended } = record as { actual_status?: unknown; intended_status?: unknown };
  return { state: 'present', status, actual: word(actual), intended: word(intended) };
}
