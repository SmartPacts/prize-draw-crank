// Prize Draw — the draw bot. Watches every raffle and settles its rounds. Each
// round is decided by ONE drand beacon, pinned when its first ticket was bought:
// the drand evmnet round published a fixed margin after the round's draw
// instant. Once the chain's clock passes that beacon's publish time, this bot
// fetches the beacon's signature from a drand relay, checks it with a free
// /local `preview` — which verifies it on chain exactly as `draw` will and says
// who wins — then dry-runs the exact draw and sends it only if that passes,
// with a gas limit sized from the dry run. If no relay can supply the beacon, it keeps
// trying; only when the round's escape has opened on the CHAIN's clock (90 days
// after the beacon was due) does it escape the round and push every refund.
// Anyone may run this; it holds no privilege and cannot choose an outcome —
// every call it makes is permissionless, and the winner is a pure function of
// the round's key and of a beacon nobody can choose or predict. Run at least
// two of these, on separate machines.
//
//   node crank.mjs              (add --once to do a single pass)
//
// THE FLOW, PER ROUND. A round runs on the CALENDAR: the operator scheduled it
// (opens-at, closes-at, draws-at — chain time, the PARENT block's stamp), and
// the round EXISTS ONLY FROM ITS FIRST TICKET, which freezes those instants,
// the raffle's terms and the drand round that will decide it. `draw-status`
// reports that drand round, when drand publishes it (`beacon-at`), and from
// when the round could escape (`escape-from`).
//   no round          ...  nothing to do: a round is started by a buyer, never
//                          by this bot
//   selling           ...  nothing to do, until closes-at
//   sales closed      ...  nothing to do, until beacon-at
//   beacon due        ...  fetch the pinned round's signature, preview it
//                          (free), send the draw (this bot is the draw-share
//                          payee)
//   no beacon to be had  retry, backing off; escape ONLY once the chain's clock
//                          is past escape-from, then refund every buyer
//
// WHY A RELAY NEED NOT BE TRUSTED. The contract verifies the signature against
// drand's public key, pinned in a sealed module, and a signature for any other
// round, or a forged one, aborts. So a relay cannot change a winner; the worst
// one can do is stay silent or answer nonsense, which costs a relay, not a
// round: the bot asks the next relay, and only ever sends a signature the chain
// has already accepted in a /local preview.
//
// Every raffle runs in its OWN loop, so one raffle waiting on a relay never
// holds up another's draw.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pact, createClient, createSignWithKeypair } from '@kadena/client';

const HOST_URL = process.env.DEVNET_HOST ?? 'http://localhost:8090';
const NETWORK = process.env.DEVNET_NETWORK_ID ?? 'recap-development';
const CH = process.env.CHAIN_ID ?? '2';
const NS = process.env.DRAW_NS ?? 'free';
const MOD = `${NS}.prize-draw`;
const POLL = Number(process.env.POLL_MS ?? 2500);
// 🔴 THE BOT SLEEPS UNTIL THE NEXT THING THAT COULD NEED DOING, and polls at POLL only when that
// thing is close. It waits for CLOCK INSTANTS it already knows: a round's close, and the moment
// drand publishes the round's pinned beacon — both frozen into the round at its first ticket.
// Everything else is dead air, and polling through it taught us nothing at the cost of ~35k reads
// a day per idle raffle against a node we do not own.
// MAX_SLEEP bounds how stale a long sleep can make us: the operator can re-schedule a round to
// draw EARLIER while we sleep, and this is what caps how late that can leave us.
const MAX_SLEEP = Number(process.env.MAX_SLEEP_MS ?? 300000);
// Wake this early, so the first tight pass happens just BEFORE the instant rather than after it.
const LEAD = Number(process.env.LEAD_MS ?? 5000);
const TIGHT = { tight: true };
const ONCE = process.argv.includes('--once');
const GAS_PRICE = 0.00000001;
// 🔴 EVERY CALL TO THE NODE HAS A DEADLINE. A connection that hangs would otherwise stall its
// raffle's loop forever while everything else looked fine. A /local or a submit gets this long; the
// wait for a send to be mined gets its own timeout plus this. A timed-out call is a NODE failure,
// never a contract answer: it is not logged as a refusal, and the pass it happened in does not
// count as healthy.
const NODE_TIMEOUT = (() => { const v = Number(process.env.NODE_TIMEOUT_MS ?? 30000); return Number.isFinite(v) && v > 0 ? v : 30000; })();
const HERE = new URL('.', import.meta.url).pathname;
const ACCTS = process.env.DRAW_ACCOUNTS ?? `${HERE}.accounts.json`;
const WHO = process.env.DRAW_BOT ?? 'admin';   // any funded persona; the bot needs no privilege

// ---- MAINNET INTERLOCKS. Real keys and real KDA. Every check here runs before a
// file is read or a byte is sent, and each names exactly what is missing. None of
// them can be satisfied by a default: running against mainnet01 must be a series
// of deliberate choices, never an inherited devnet setting.
const MAINNET = NETWORK === 'mainnet01';
const refuse = (why) => { console.error(`refusing mainnet01: ${why}`); process.exit(1); };
if (MAINNET) {
  if (process.env.DRAW_MAINNET !== 'armed')
    refuse('set DRAW_MAINNET=armed to run against real money');
  if (!process.env.DEVNET_HOST || /localhost|127\.0\.0\.1|\[::1\]/.test(HOST_URL))
    refuse('DEVNET_HOST must name a mainnet node, not the local devnet');
  if (!/^n_[0-9a-f]{40}$/.test(NS))
    refuse(`DRAW_NS must be a principal namespace (n_ + 40 hex), got "${NS}"`);
  if (!process.env.DRAW_ACCOUNTS)
    refuse('DRAW_ACCOUNTS must name a key file OUTSIDE this repository; the default .accounts.json holds devnet genesis keys');
  if (resolve(ACCTS).startsWith(resolve(HERE)))
    refuse(`the key file must live outside this checkout, not at ${ACCTS}`);
  if (!process.env.DRAW_BOT)
    refuse('DRAW_BOT must name the signing account explicitly; there is no default on mainnet');
  console.error(`ARMED for mainnet01 chain ${CH}: signing as ${WHO}, namespace ${NS}`);
}


if (!existsSync(ACCTS)) { console.error(`no personas at ${ACCTS}`); process.exit(1); }
const BOT = JSON.parse(readFileSync(ACCTS, 'utf8'))[WHO];
if (!BOT) { console.error(`no persona "${WHO}" in ${ACCTS}`); process.exit(1); }

// ---- WHERE THE EARNINGS GO. Settling a round pays the drawer's share of that
// raffle's fee to an account THE DRAW NAMES, and the contract accepts any
// ordinary account — so this bot never has to hold what it earns. Point it at a
// cold account you control and the hot key on this machine only ever holds gas.
// The default is the bot's own account, which is what a fresh operator expects:
// earnings accumulate where the gas is paid from, and nothing is lost by not
// setting it.
const PAYEE = process.env.DRAW_PAYEE ?? BOT.account;
// The module refuses a module account here (every raffle pool is one), and its
// refusal would abort the whole draw. Fail at startup instead, where it is a
// configuration message and not a settled round that will not settle.
if (PAYEE.startsWith('m:')) {
  console.error(`DRAW_PAYEE must not be a module account: ${PAYEE}`);
  process.exit(1);
}
if (PAYEE.length < 3 || /[\s"]/.test(PAYEE)) {
  console.error(`DRAW_PAYEE does not look like an account name: ${JSON.stringify(PAYEE)}`);
  process.exit(1);
}
const client = createClient(({ chainId, networkId }) =>
  `${HOST_URL}/chainweb/0.0/${networkId}/chain/${chainId}/pact`);

const unwrap = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(unwrap);
  if ('int' in v) { const n = Number(v.int); return Number.isSafeInteger(n) ? n : String(v.int); }
  if ('decimal' in v) return Number(v.decimal);
  // Pact 5 encodes a time as {"time": "…Z"} on a whole second and {"timep":
  // "….%vZ"} otherwise (pact-5 LegacyCodec.hs, timeCodec). Only a one-key object
  // is a time, so a row that has a field named `time` stays an object.
  if ('timep' in v) return v.timep;
  if ('time' in v && Object.keys(v).length === 1) return v.time;
  const o = {}; for (const [k, x] of Object.entries(v)) o[k] = unwrap(x); return o;
};
const stamp = () => new Date().toLocaleTimeString();
const say = (m) => console.log(`${stamp()}  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- BEACONS, PACING AND SENDING. Pure except for `fetch` and `local`, and kept together between
// these two markers so a test can load exactly these bytes (both cranks carry them byte for byte).
// ==== BEGIN BEACON ====
// An instant as milliseconds; Pact's high-precision form carries microseconds,
// which Date.parse does not take, so the fraction is cut to milliseconds first.
const toMs = (iso) => Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1'));

// drand evmnet — the ONLY network Pact can verify (it is the only BN254 one), and the one the
// contract's sealed verifier pins.
const DRAND_CHAIN = '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
// Independent relays of the SAME chain. A hostile relay cannot forge a beacon the
// contract will accept, so this covers silence — which is the only real risk.
const RELAYS = (process.env.DRAND_RELAYS ??
  'https://api.drand.sh,https://api2.drand.sh,https://api3.drand.sh,https://drand.cloudflare.com'
).split(',').map((s) => s.trim()).filter(Boolean);
// The first retry after a beacon could not be had. Later retries back off with how late the
// beacon already is (a tenth of it), up to MAX_SLEEP: a relay outage of minutes is retried in
// seconds, and a drand outage of days does not cost four relay requests every few seconds.
const BEACON_RETRY_MS = Number(process.env.BEACON_RETRY_MS ?? 15000);

// 🔴 A RELAY ANSWER IS UNTRUSTED INPUT, AND ONE OF ITS FIELDS ENDS UP INSIDE A
// SIGNED TRANSACTION. Exactly TWO fields are ever read, and both are checked.
// `round` must be the round asked for: a relay answering a different round is
// answering a different question. `signature` must be 128 hex characters, which
// is the CONTRACT'S OWN bound (`g1-from-hex`): a short, long or non-hex answer is
// refused on chain whatever this bot does, and checking it here refuses it before
// anything is signed. `randomness` is deliberately NOT read: the contract derives
// its seed from the verified signature, so a relay's idea of the randomness
// cannot move any outcome. The signature travels in transaction DATA, never in
// the code.
const SIG_HEX = /^[0-9a-fA-F]{128}$/;

// Every relay's answer, one at a time: a caller that finds an answer REFUSED in a dry run asks the
// next relay instead of giving up on the round.
async function* beacons(round) {
  for (const base of RELAYS) {
    try {
      const res = await fetch(`${base}/${DRAND_CHAIN}/public/${round}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (Number(j?.round) !== round) { say(`  relay ${base} answered round ${j?.round} for ${round} — skipped`); continue; }
      const sig = j?.signature;
      if (typeof sig !== 'string' || !SIG_HEX.test(sig)) {
        say(`  relay ${base} answered round ${round} with a signature that is not 128 hex characters (${typeof sig === 'string' ? `${sig.length} chars, starts ${JSON.stringify(sig.slice(0, 24))}` : `type ${typeof sig}`}) — skipped, trying the next relay`);
        continue;
      }
      yield { base, sig };
    } catch { /* try the next relay */ }
  }
}

// 🔴 A SEND THAT ABORTS STILL PAYS ITS GAS. Each relay's signature is dry-run first with the
// round's `preview` over /local (free): it verifies the signature on chain exactly as `draw` will
// and returns who wins. The first one the chain accepts is returned with that preview; an
// identical signature from a second relay is not dry-run twice. Returns { sig, base, pv }, or
// { none: true } when no relay answered at all, or { refused, answered } when every answer was
// refused, or { settled } when the chain says the round is already settled — an answer about the
// ROUND, which no other relay can change, so the search ends there. A NODE failure (an error
// carrying `node`) is no answer at all and is thrown, never counted as a relay being refused.
async function acceptedBeacon(round, previewCode) {
  const tried = new Set();
  let answered = 0, lastWhy = '';
  for await (const { base, sig } of beacons(round)) {
    answered++;
    const key = sig.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    try { return { sig, base, pv: await local(previewCode, { sig }) }; }
    catch (e) {
      if (e?.node) throw e;
      if (SETTLED.test(String(e?.message))) return { settled: String(e.message) };
      lastWhy = String(e.message);
      say(`  relay ${base}: beacon ${round} refused in a preview, trying the next relay (${lastWhy.slice(0, 120)})`);
    }
  }
  return answered === 0 ? { none: true } : { refused: lastWhy, answered };
}

/** What a selling round needs next, from the chain's clock `nowMs` and the round's own instants
 *  (draw-status). Every comparison is the module's own: the beacon is due at `beacon-at` (>=), and
 *  the escape opens strictly after `escape-from` (>). */
function plan(nowMs, closesAt, st) {
  if (nowMs < toMs(closesAt)) return { do: 'wait', at: closesAt, why: 'selling' };
  if (nowMs < toMs(st['beacon-at'])) return { do: 'wait', at: st['beacon-at'], why: 'beacon' };
  return { do: 'draw', escapeOpen: nowMs > toMs(st['escape-from']) };
}

/** When to try a beacon again after no relay produced one the chain accepts: BEACON_RETRY_MS at
 *  first, then a tenth of how late the beacon already is, never more than MAX_SLEEP, and never
 *  past the moment the escape opens (a second after it). Chain-clock milliseconds in, out. */
function beaconRetryAt(nowMs, beaconAtMs, escapeFromMs) {
  const late = Math.max(0, nowMs - beaconAtMs);
  const wait = Math.min(Math.max(BEACON_RETRY_MS, late / 10), MAX_SLEEP);
  return nowMs <= escapeFromMs ? Math.min(nowMs + wait, escapeFromMs + 1000) : nowMs + wait;
}

// ---- THE DRAW ITSELF. 🔴 A SEND THAT ABORTS STILL PAYS ITS WHOLE GAS LIMIT. The preview above
// proves the BEACON; it is not the draw. So the exact draw — same code, same signer and coin.GAS
// capability, same signature in the same data, the same payee — is dry-run over /local first, and
// only a draw the chain accepts there is sent. Two cranks racing, or anything that makes `draw` fail
// while `preview` passes, then costs a free /local instead of a mined failure every pass
// (roulette's two bots, 2026-09-25: lost races at a fixed 30,000 were 93 % of all gas spent).
//
// The contract's refusal of a round that is no longer selling: `draw` says "this round is already
// settled", `preview` and `draw-status` say "this round is settled — …". Either one means another
// crank got there first: nothing is sent.
const SETTLED = /this round is (already )?settled/;
// The CAP, and the limit the dry run itself runs under, so a draw that would not fit fails there,
// for free. A draw verifies the beacon on chain and pays up to ten winners, the drawer and the
// revenue account: 4,175 gas at that worst case in the Pact 5.4 REPL (prize-draw's worst-case suite),
// and the drand module's notes budget up to ~21,000 for the verification if the pairing cost is
// ever re-benched. 30,000 covers that and still packs beside other transactions.
const DRAW_GAS = 30000;
// The limit a send asks for: three times what the dry run measured, never under 5,000, never over
// DRAW_GAS — the baccarat crank's rule. The margin covers what a /local without preflight does not
// charge (the transaction's size) and a block that lands between the dry run and the send. A dry
// run that reported no usable gas figure keeps the cap.
const limitFrom = (gas) => (Number.isFinite(gas) && gas > 0 ? Math.min(DRAW_GAS, Math.max(5000, Math.ceil(3 * gas))) : DRAW_GAS);

/** Dry-run, then send. `dryRun()` resolves to the node's WHOLE /local answer ({ result, gas }) and
 *  throws only on a node failure, which is passed on and sends nothing. `sendAt(limit)` sends the
 *  same transaction with that gas limit. Returns { settled } or { refused } (nothing was sent), or
 *  { sent, gas, limit }. A failed dry run reports the whole limit as its gas, so its gas is never
 *  read. */
async function drawSized(dryRun, sendAt) {
  const full = await dryRun();
  const res = full?.result;
  if (res?.status !== 'success') {
    const why = String(res?.error?.message ?? JSON.stringify(res?.error ?? 'the dry run returned no result'));
    return SETTLED.test(why) ? { settled: why } : { refused: why };
  }
  const gas = Number(full.gas), limit = limitFrom(gas);
  return { sent: await sendAt(limit), gas, limit };
}

// ---- TWO CRANKS, ONE LEADER. Run as a pair, both would see a beacon in the same second and both
// would act. A FOLLOWER (CRANK_FOLLOWER_MS > 0) lets a round sit this long, from the moment THIS
// process first sees it drawable (or escapable), before it does anything at all — and the round's
// state is read again after the wait, so a round the leader settled meanwhile costs the follower
// one read. The leader runs at 0, the default. Counted on this machine's clock from its own first
// sight, so a backlog met at a restart is left to the leader too.
const FOLLOWER_MS = (() => { const v = Number(process.env.CRANK_FOLLOWER_MS ?? 0); return Number.isFinite(v) && v > 0 ? v : 0; })();
/** How much longer a follower waits before touching a round it first saw drawable at
 *  `firstSeenMs`; 0 means act now (and always 0 for a leader). */
const followerWait = (firstSeenMs, nowMs) => Math.max(0, firstSeenMs + FOLLOWER_MS - nowMs);

// ---- EVERY UNSETTLED ROUND, NOT THE NEWEST FEW. A raffle's rounds are seq 1..round-seq, and a
// round can wait days for a draw (a crank outage, a drand outage) while newer rounds open on top of
// it; a window over the newest rounds would forget it for good. So each raffle keeps every round
// not yet PROVEN settled, with the chain instant it next needs looking at: a round whose next
// instant has not come costs no read at all, and a round proven drawn (or escaped and refunded)
// leaves the set and is never read again by this process. Work per pass is bounded: at most
// ROUNDS_PER_PASS rounds are read, the ones waiting longest first (a round never read yet counts
// as waiting since the epoch, newest of those first), so a long history is worked through over
// several quick passes and no round can be starved by the others.
const ROUNDS_PER_PASS = 20;
/** Which rounds to read this pass. `open` maps seq -> the chain-clock ms it is next due (0 = never
 *  read); returns { batch, more } — `more` when rounds due now were left for the next pass. */
function dueRounds(open, nowMs) {
  const due = [...open].filter(([, at]) => at <= nowMs).sort((a, b) => a[1] - b[1] || b[0] - a[0]);
  return { batch: due.slice(0, ROUNDS_PER_PASS).map(([s]) => s), more: due.length > ROUNDS_PER_PASS };
}
// ---- A SCHEDULE THAT HAS LAPSED IS NO SCHEDULE. A raffle's `next-draws-at` is where its NEXT round
// will draw, and it stands only until that round's first ticket. Once the chain's clock is at or
// past it and nobody bought, no ticket can be sold into it any more (sales close at or before the
// draw instant), so nothing can happen until the operator schedules again: it is "nothing due", not
// an instant to poll towards. EPOCH means unscheduled.
/** The raffle's own schedule as a pacing hint: { at } while `nextDrawsAt` is still ahead of the
 *  chain's clock `nowMs`, otherwise nothing. */
const scheduleHint = (nextDrawsAt, nowMs) =>
  (nextDrawsAt && !nextDrawsAt.startsWith('1970-01-01') && toMs(nextDrawsAt) > nowMs ? { at: nextDrawsAt } : undefined);

// ---- A ROUND THAT SHOULD HAVE BEEN DRAWN BY NOW. A round is drawable from its beacon's publish
// time. A healthy crank settles it within a block or two, so one still unsettled STUCK_MS later, on
// the chain's clock, means something a completed pass does not show: no relay has the beacon, every
// dry run is refused, or the draws keep failing. A follower gets its own wait on top, because it
// leaves the round to the leader for that long on purpose. A draw that passed its dry run and then
// failed when mined paid gas for nothing; STUCK_FAILS of those on one round is the same alarm
// without waiting for the clock.
const STUCK_MS = 15 * 60000;
const STUCK_FAILS = 2;
/** Why a drawable, unsettled round `o` ({ what, beaconAt, dueMs, fails }) counts as stuck at the
 *  chain-clock instant `chainNowMs`, or '' while it does not. The text is the same on every call
 *  for the same reason, so a caller can say it once. */
const stuckWhy = (o, chainNowMs) =>
  (o.fails >= STUCK_FAILS ? `${o.what} is drawable and its draw has failed on chain ${STUCK_FAILS} times or more`
    : chainNowMs - o.dueMs > FOLLOWER_MS + STUCK_MS
      ? `${o.what} has been drawable since ${o.beaconAt} and is still not settled more than ${Math.round((FOLLOWER_MS + STUCK_MS) / 60000)} min later`
      : '');

// ---- A NODE WHOSE CLOCK HAS STOPPED. The chain's clock is the parent block's time, so it normally
// sits a block or so behind the wall clock, and a slow stretch of blocks can stretch that to a few
// minutes. A node that has fallen behind the network answers every read normally, with an OLD
// chain time — and a bot pacing itself by that clock would wait for instants that have long
// passed. NODE_LAG_MS behind this machine's clock is past anything a healthy node shows. A chain
// time that cannot be read as a number counts as lagging: nothing was established.
const NODE_LAG_MS = 10 * 60000;
const nodeLags = (chainMs, wallMs) => !(wallMs - chainMs <= NODE_LAG_MS);
// ==== END BEACON ====

// ---- THE DEAD-MAN'S SWITCH. Set HEARTBEAT_URL to a ping URL from any uptime
// service that alerts when pings STOP (healthchecks.io's free tier, Better
// Stack, your own endpoint). This bot pings it every 15 s while every raffle's
// last pass COMPLETED with every read and send answered, no drawable round is
// stuck and the node's clock is current (see `unhealthy`), so silence means the
// process, the machine, the network or the node is gone or lagging, a raffle's
// loop is stuck, or a round that should have been drawn has not been — and you
// hear about it from something that is not running on the machine that died. Nothing tells you otherwise: a crank
// that stops settling delays draws until someone notices.
//
// It never throws and never waits long: monitoring that can break the thing it
// monitors is worse than no monitoring. Be honest about what it proves — the
// bot is alive, reads a chain whose clock is current, and has no round stuck
// past the thresholds below; NOT that a particular round settled on time.
const HEARTBEAT_URL = process.env.HEARTBEAT_URL ?? '';
let beatFailed = false;
async function beat() {
  if (!HEARTBEAT_URL) return;
  try {
    await fetch(HEARTBEAT_URL, { signal: AbortSignal.timeout(10000) });
    beatFailed = false;
  } catch (e) {
    // Said once per outage, not once per pass: a heartbeat that cannot be sent
    // is worth knowing about, but it is not what this bot is for.
    if (!beatFailed) say(`heartbeat ping failed (${String(e.message).slice(0, 80)}) — the bot keeps running`);
    beatFailed = true;
  }
}

// `data` is how untrusted strings reach the chain: a relay's signature is read with
// (read-string "sig"), never written into `code`.
//
// 🔴 TWO FAILURES, KEPT APART. The contract refusing something is an ANSWER and is thrown as a plain
// Error carrying the contract's message. The node not answering — a timeout, a refused connection,
// a reset — is NO answer: it is thrown with `node: true`, so no caller can log it as the contract
// saying no, and the pass it happened in is not reported healthy.
const nodeFailure = (what, e) =>
  Object.assign(new Error(`node ${HOST_URL} ${what}: ${String(e?.cause?.message ?? e?.message ?? e).slice(0, 160)}`), { node: true });
/** One transaction, as the draw sends it or as a read: code, then data, then — for a send — the
 *  bot's signer with coin.GAS alone and a nonce. Unsigned. */
const txFor = (code, gasLimit, data = {}, nonce) => {
  let b = Object.entries(data).reduce((b, [k, v]) => b.addData(k, v), Pact.builder.execution(code));
  if (nonce !== undefined) b = b.addSigner(BOT.publicKey, (wc) => [wc('coin.GAS')]);
  b = b.setMeta({ chainId: CH, senderAccount: BOT.account, gasLimit, gasPrice: GAS_PRICE }).setNetworkId(NETWORK);
  if (nonce !== undefined) b = b.addData('n', nonce);
  return b.createTransaction();
};
/** The node's WHOLE /local answer — `gas` sits beside `result`, not inside it. Signatures are not
 *  checked, so an unsigned copy of a send dry-runs exactly as the signed one would execute. */
async function localCmd(tx) {
  try { return await client.local(tx, { preflight: false, signatureVerification: false, signal: AbortSignal.timeout(NODE_TIMEOUT) }); }
  catch (e) { throw nodeFailure('/local', e); }
}
async function local(code, data = {}) {
  const r = await localCmd(txFor(code, 150000, data));
  if (r?.result?.status !== 'success') throw new Error(JSON.stringify(r?.result?.error ?? r));
  return unwrap(r.result.data);
}
// `timeout` is how long to wait for the transaction to be MINED. Giving up early
// only produces a false "refused" for a draw that is still pending (a re-sent
// duplicate is refused by the module, never paid twice).
async function send(code, label, gasLimit = 20000, timeout = 120000, data = {}) {
  const signed = await createSignWithKeypair(BOT)(txFor(code, gasLimit, data, `${label}-${Date.now()}`));
  let desc, r;
  try { desc = await client.submit(signed, { signal: AbortSignal.timeout(NODE_TIMEOUT) }); }
  catch (e) { throw nodeFailure(`send of ${label}`, e); }
  // pollOne keeps its own overall timeout; the signal also aborts a single poll that hangs.
  try { r = await client.pollOne(desc, { timeout, interval: 2000, signal: AbortSignal.timeout(timeout + NODE_TIMEOUT) }); }
  catch (e) { throw nodeFailure(`waiting ${Math.round(timeout / 1000)}s for ${label} (${desc.requestKey}) to be mined`, e); }
  if (r.result.status !== 'success') throw new Error(JSON.stringify(r.result.error).slice(0, 180));
  say(`  ${label} ok (gas ${r.gas} of limit ${gasLimit}, block ${r?.metaData?.blockHeight})`);
  return unwrap(r.result.data);
}
// The chain's clock, exactly as the module reads it: (chain-data)'s block-time
// over /local — the PARENT block's stamp, the value every calendar gate in the
// contract compares against. Never the wall clock: a devnet's chain time can sit
// hours behind it, and a transaction mined in the next block sees a time at or
// past this one, so "the chain says it is past X" means a send now lands past X.
async function chainTime() {
  return String(await local(`(at 'block-time (chain-data))`));
}

// ---- THE BEACON VERIFIER, CHECKED BEFORE ANYTHING ELSE. The contract names the drand verifier it
// uses, and the code hash it is pinned to, in its own `(use <ns>.drand "<hash>" …)` line. This bot
// ships no copy of the contract, so it reads that line from the DEPLOYED code, then checks the
// verifier on chain has exactly that hash — and refuses to start otherwise. A contract without that
// line is not the drand version (the previous version drew from block hashes and takes different
// arguments), and a crank run against it would only send transactions that fail.
const CODE = await local(`(at 'code (describe-module "${MOD}"))`).catch((e) => {
  console.error(`cannot read ${MOD} from ${HOST_URL}: ${String(e.message).slice(0, 160)}`);
  console.error('the contract must be deployed on this chain before a crank can run against it');
  process.exit(1);
});
const USE = String(CODE).match(/\(use ([\w.-]+\.drand) "([A-Za-z0-9_-]{43})"/);
if (!USE) {
  console.error(`${MOD} on chain does not name a drand verifier — this crank settles only the drand version of the contract`);
  process.exit(1);
}
const [, DRAND, DRAND_PIN] = USE;
{
  const onChain = await local(`(at 'hash (describe-module "${DRAND}"))`).catch((e) => {
    console.error(`cannot read the drand verifier ${DRAND} on chain ${CH}: ${String(e.message).slice(0, 160)}`);
    process.exit(1);
  });
  if (onChain !== DRAND_PIN) {
    console.error(`${DRAND} on chain ${CH} has hash ${onChain}, but ${MOD} pins ${DRAND_PIN} — refusing to start`);
    process.exit(1);
  }
  // And the drand CHAIN this bot fetches beacons from must be the one that verifier pins
  // (its CHAIN-HASH constant). A wrong DRAND_CHAIN is harmless to the contract — every beacon from
  // it would be refused in the preview — but then no round would ever be drawn, and after 90 days
  // every one would escape. Refuse now instead.
  const pinnedChain = await local(`${DRAND}.CHAIN-HASH`).catch((e) => {
    console.error(`cannot read ${DRAND}.CHAIN-HASH on chain ${CH}: ${String(e.message).slice(0, 160)}`);
    process.exit(1);
  });
  if (pinnedChain !== DRAND_CHAIN) {
    console.error(`this bot fetches beacons from drand chain ${DRAND_CHAIN}, but ${DRAND} verifies chain ${pinnedChain} — refusing to start`);
    process.exit(1);
  }
}

// The payee must ALREADY EXIST on this chain. A round pays every party with
// `transfer`, not `transfer-create`, so naming an account that has never been
// funded does not create it — it aborts the draw, every time, for every raffle.
// That failure would look like a broken contract and is really a typo, so it is
// caught here, once, before the bot claims to be settling anything.
{
  const known = await local(`(try false (and (!= "" "${PAYEE}") (>= (coin.get-balance "${PAYEE}") 0.0)))`);
  if (known !== true && PAYEE !== BOT.account) {
    // A payee someone TYPED. Almost always a typo or an account that was never funded, and the
    // cost of guessing wrong is every draw aborting, so this is a refusal, not a warning.
    console.error(`DRAW_PAYEE ${PAYEE} does not exist on chain ${CH} of ${NETWORK}.`);
    console.error('Earnings are paid with a plain transfer, so an account that does not exist yet would');
    console.error('abort every draw. Create or fund it first, then start the crank again.');
    process.exit(1);
  }
  if (known !== true) {
    // The payee is this bot's own account and it holds nothing yet: that is an unfunded new crank,
    // not a mistake. It cannot pay for a transaction anyway, so say so plainly and carry on
    // reading — refusing here would only replace a clear message with a confusing one.
    say(`this bot's account does not exist on chain ${CH} yet: fund ${BOT.account} before it can settle anything`);
  }
}

/** Push every unpaid buyer's refund out of an escaped round. A node failure is thrown on. */
async function refund(id, seq, tickets) {
  // the buyers are the ticket rows themselves — complete, and from the chain
  const accounts = [...new Set(await local(
    `(map (lambda (i:integer) (at 'account (${MOD}.get-ticket "${id}" ${seq} i))) (enumerate 0 ${tickets - 1}))`))];
  let open = 0;
  for (const a of accounts) {
    const hd = await local(`(${MOD}.get-holding "${id}" ${seq} "${a}")`);
    if (hd.paid) continue;
    open++;
    try { await send(`(${MOD}.claim-escape "${id}" ${seq} "${a}")`, `${id} refund ${a.slice(0, 14)}…`); open--; }
    catch (e) { if (e.node) throw e; say(`  refund refused: ${e.message}`); }
  }
  return open === 0;
}

const reported = new Set();   // things already announced, so a poll loop says each once
const finished = new Set();   // rounds this bot has nothing left to do for
const firstDrawable = new Map();   // round key -> when THIS process first saw it drawable (the follower clock)
const overdue = new Map();   // round key -> { what, beaconAt, dueMs, fails } of a round drawable and not settled (see stuckWhy)

/** Say a thing once per key, however many times the loop comes round. */
function once(key, msg) {
  if (reported.has(key)) return;
  reported.add(key);
  say(msg);
}

/** Escape a round nobody could draw, then push every buyer's refund. */
async function escapeAndRefund(id, seq, why, tickets, key) {
  try { say(`  ${await send(`(${MOD}.escape "${id}" ${seq})`, `${id} ESCAPE (${why})`)}`); }
  catch (e) { if (e.node) throw e; say(`  escape refused: ${e.message}`); return; }
  if (await refund(id, seq, tickets)) { finished.add(key); say(`${id} round ${seq}: every buyer refunded`); }
}

/** One round, wherever it stands. Returns when to look again: TIGHT, or { at: <chain instant> },
 *  or nothing when this round needs no further attention (it is then in `finished`). A node
 *  failure is thrown; a contract refusal is logged and retried later. */
async function handleRound(id, seq, rd, key) {
  if (rd.state !== 'selling') overdue.delete(key);   // settled one way or the other: no longer drawable
  if (rd.state === 'drawn') { finished.add(key); return; }
  if (rd.state === 'escaped') {
    if (rd.tickets === 0) { finished.add(key); return; }
    if (await refund(id, seq, rd.tickets)) { finished.add(key); say(`${id} round ${seq}: every buyer refunded`); return; }
    return TIGHT;
  }
  // A round row from an earlier generation comes back exactly as it was
  // written, and this module settles only a "selling" round that holds at least
  // one ticket (a round exists only from its first ticket). Nothing here can
  // move any other row; say so once instead of failing every poll.
  if (rd.state !== 'selling' || !(rd.tickets > 0)) {
    once(key, `${id} round ${seq} is in state "${rd.state}" with ${rd.tickets} ticket(s) — a row from an earlier generation that no path settles. Skipping.`);
    finished.add(key);
    return;
  }

  // Every comparison below is against the CHAIN's clock, the one the module's
  // own gates read. The round's instants and its drand round were frozen by its
  // first ticket; draw-status reports them.
  const now = await chainTime();
  const nowMs = toMs(now);
  const st = await local(`(${MOD}.draw-status "${id}" ${seq})`);
  const dr = st['drand-round'];
  // Only the drand version of the module reports these; anything else is the wrong contract.
  if (!(dr > 0) || !st['beacon-at'] || !st['escape-from']) throw new Error(`draw-status of ${id} round ${seq} has no drand round — is this the drand version of ${MOD}?`);
  const p = plan(nowMs, rd['closes-at'], st);
  if (p.do === 'wait') {
    once(`${key}|${p.why}`, p.why === 'selling'
      ? `${id} round ${seq}: selling until ${rd['closes-at']} (${rd.tickets} ticket(s) so far); drand round ${dr} decides it, published at ${st['beacon-at']}`
      : `${id} round ${seq}: sales closed with ${rd.tickets} ticket(s) — drand round ${dr} decides it, published at ${st['beacon-at']}; this bot draws it then`);
    return { at: p.at };
  }
  // From here the round is DRAWABLE, and stays on record as such until it is settled: the
  // heartbeat is withheld for a round that sits here too long, or whose draws keep failing.
  if (!overdue.has(key)) overdue.set(key, { what: `${id} round ${seq}`, beaconAt: st['beacon-at'], dueMs: toMs(st['beacon-at']), fails: 0 });

  // A follower leaves a round it has just seen become drawable to the leader. The next look reads
  // the round's state afresh, so a round the leader settled meanwhile ends there.
  if (!firstDrawable.has(key)) firstDrawable.set(key, Date.now());
  const follow = followerWait(firstDrawable.get(key), Date.now());
  if (follow > 0) {
    once(`${key}|follow`, `${id} round ${seq}: drawable — this bot is a follower (CRANK_FOLLOWER_MS ${FOLLOWER_MS}), leaving it to the leader for ${Math.ceil(follow / 1000)}s`);
    return { at: new Date(nowMs + follow + LEAD).toISOString() };
  }

  // The beacon is due. Fetch it, have the chain verify it in a free preview, then dry-run the exact
  // draw and send it only if that passes.
  const previewCode = `(${MOD}.preview "${id}" ${seq} (read-string "sig"))`;
  const got = await acceptedBeacon(dr, previewCode);
  if (got.settled) { say(`${id} round ${seq}: already settled by someone else — nothing sent`); return TIGHT; }
  if (got.sig) {
    const pv = got.pv;
    say(`${id} round ${seq}: drand round ${pv['drand-round']} decides it (beacon from ${got.base}) — preview: ranks ${JSON.stringify(pv.ranks)} pay ${JSON.stringify(pv.amounts)}`);
    const drawCode = `(${MOD}.draw "${id}" ${seq} "${PAYEE}" (read-string "sig"))`;
    const data = { sig: got.sig };
    let d;
    try {
      d = await drawSized(() => localCmd(txFor(drawCode, DRAW_GAS, data, `${id}-dry-${Date.now()}`)),
        (limit) => send(drawCode, `${id} DRAW`, limit, 300000, data));
    } catch (e) { if (e.node) throw e; d = { failed: String(e.message) }; overdue.get(key).fails++; }
    if (d.settled) { say(`  the draw's dry run says the round is already settled — nothing sent`); return TIGHT; }
    if ('sent' in d) { say(`  ${d.sent} (dry run ${d.gas} gas, sent with limit ${d.limit})`); finished.add(key); return; }
    if (d.refused) say(`  the draw was refused in a dry run, so it was NOT sent (${d.refused.slice(0, 160)})`);
    else say(`  draw refused: ${d.failed}`);
  } else if (got.none) {
    say(`${id} round ${seq}: beacon ${dr} is due (chain time ${now}) but no relay answered for it`);
  } else {
    say(`${id} round ${seq}: every relay's answer for beacon ${dr} was refused in a preview (${got.answered}), not sent (${String(got.refused).slice(0, 120)})`);
  }

  // No draw this pass. Escape ONLY when no relay produced a beacon the chain accepts AND the
  // chain's clock is past escape-from: until then the round can still be drawn, and a draw is the
  // answer every buyer bought. A draw that was refused WITH a verified beacon (another crank got
  // there first, a node hiccup) is retried, never turned into an escape.
  if (p.escapeOpen && !got.sig) {
    once(`${key}|escape`, `!!! ${id} round ${seq}: nobody could draw it and its escape opened at ${st['escape-from']} (chain time ${now}).`
      + ` Escaping it now: every buyer gets their stake back.`);
    await escapeAndRefund(id, seq, 'no beacon for 90 days', rd.tickets, key);
    return TIGHT;
  }
  return { at: new Date(beaconRetryAt(nowMs, toMs(st['beacon-at']), toMs(st['escape-from']))).toISOString() };
}

const sooner = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if (a.tight || b.tight) return TIGHT;
  return toMs(a.at) <= toMs(b.at) ? a : b;
};
// Per raffle: the highest round seq enumerated, and every round not yet proven settled with the
// chain instant (ms) it is next due — see dueRounds.
const tracked = new Map();

/** One raffle. Returns when to look at it again — see `loop`. Sets `pass.ok` false when any part of
 *  the pass could not be read or failed. */
async function handle(id, pass) {
  // The chain's clock is read BEFORE the raffle: a schedule found lapsed against a time read first
  // can have gained no ticket since, so the raffle row read after it is the final word on it.
  let r, nowMs;
  try { nowMs = toMs(await chainTime()); r = await local(`(${MOD}.get-raffle "${id}")`); }
  catch (e) { pass.ok = false; say(`${id}: cannot read the raffle (${String(e.message).slice(0, 140)})`); return TIGHT; }
  // The raffle's own pace, used when no live round has anything sooner: a round that does not
  // exist yet will draw at the instant the operator scheduled, because its first ticket freezes
  // exactly these three instants into it. Unscheduled, or a schedule that lapsed with no ticket
  // sold — nothing can happen until the operator schedules, so wait out a full MAX_SLEEP.
  const raffleHint = scheduleHint(String(r['next-draws-at'] ?? ''), nowMs);
  // Every round from 1 to round-seq enters the set once; a round proven settled leaves it and is
  // never read again. No round at all: nothing here can start one — a round exists only because
  // somebody bought its first ticket, which is a buyer, never this bot.
  const t = tracked.get(id) ?? { known: 0, open: new Map() };
  tracked.set(id, t);
  const seq = Number(r['round-seq']) || 0;
  for (let s = t.known + 1; s <= seq; s++) t.open.set(s, 0);
  if (seq > t.known) t.known = seq;
  if (t.open.size === 0) return raffleHint;

  const { batch, more } = dueRounds(t.open, nowMs);
  for (const s of batch) {
    const key = `${id}|${s}`;
    try {
      const rd = await local(`(${MOD}.get-round "${id}" ${s})`);
      const h = await handleRound(id, s, rd, key);
      if (finished.has(key)) { t.open.delete(s); firstDrawable.delete(key); overdue.delete(key); continue; }
      t.open.set(s, !h ? nowMs + MAX_SLEEP : h.tight ? nowMs : toMs(h.at) - LEAD);
    } catch (e) {
      // The round stays in the set, due, so the next pass tries it again.
      pass.ok = false;
      say(`${id} round ${s}: ${String(e.message).slice(0, 160)}`);
    }
  }
  if (more) return TIGHT;              // rounds due now were left for the next pass
  if (t.open.size === 0) return raffleHint;
  const soonest = Math.min(...t.open.values());
  return sooner(soonest <= nowMs ? TIGHT : { at: new Date(soonest + LEAD).toISOString() }, raffleHint);
}

// One independent loop per raffle, started as raffles appear. Each sleeps until its own next
// instant, so a raffle drawing next Tuesday costs a handful of reads a day and a raffle whose
// beacon is about to be published is polled every POLL.
const loops = new Map();
/** How long to wait, given what the pass said it was waiting for. */
async function waitFor(id, hint) {
  if (!hint) return sleep(MAX_SLEEP);                       // nothing scheduled: a slow heartbeat
  if (hint.tight) return sleep(POLL);
  // The target is an instant of the CHAIN's clock, which lags the wall clock by about a block, so
  // the wait is measured from the chain's own reading: sleeping (target - chainNow) from now lands
  // exactly when the chain reaches the target, whatever the lag is.
  let delta;
  try { delta = toMs(hint.at) - toMs(await chainTime()) - LEAD; }
  catch { return sleep(POLL); }
  const ms = Math.min(Math.max(delta, POLL), MAX_SLEEP);
  if (ms > 60000) once(`${id}|sleep|${hint.at}`, `${id}: nothing to do before ${hint.at} — checking back every ${Math.round(MAX_SLEEP / 1000)}s until it is close`);
  return sleep(ms);
}
// 🔴 THE HEARTBEAT FOLLOWS COMPLETED PASSES, NOT THE MAIN LOOP. Each raffle records its last pass
// that FINISHED, and whether every read and send in it got an answer. The ping goes out only while
// every watched raffle's last pass finished cleanly and recently — a raffle stuck on a node that
// stopped answering must silence the switch, not hide behind a list read that still works.
// "Recently": its longest sleep plus a generous bound on one pass (every node call has a deadline,
// so a pass does end; the longest legitimate ones push refunds or wait for a draw to be mined).
//
// 🔴 AND A COMPLETED PASS IS NOT A SETTLED ROUND. A pass in which no relay had the beacon, or the
// draw was refused, or was sent and failed when mined, still got an answer to everything it asked.
// So the ping is also withheld while any round is stuck (see stuckWhy), and while the node's clock
// has fallen behind this machine's (see nodeLags) — a bot waiting on a stopped clock looks idle,
// not broken.
const health = new Map();   // raffle id -> { ok, at } of its last completed pass
const PASS_STALE = MAX_SLEEP + 15 * 60000;
const LAGGING = `the node's chain time is more than ${NODE_LAG_MS / 60000} min behind this machine's clock`;
/** The first stuck round, as a reason, or ''. */
function stuck(chainNowMs) {
  for (const o of overdue.values()) { const why = stuckWhy(o, chainNowMs); if (why) return why; }
  return '';
}
function unhealthy(ids, chainNowMs) {
  for (const id of ids) {
    const h = health.get(id);
    if (!h) return `${id} has not completed a pass yet`;
    if (!h.ok) return `${id}'s last pass could not read or send everything it needed`;
    if (Date.now() - h.at > PASS_STALE) return `${id} has not completed a pass for ${Math.round((Date.now() - h.at) / 60000)} min`;
  }
  return stuck(chainNowMs);
}
async function loop(id) {
  for (;;) {
    const pass = { ok: true };
    let hint;
    try { hint = await handle(id, pass); } catch (e) { pass.ok = false; say(`${id}: ${String(e.message).slice(0, 140)}`); }
    health.set(id, { ok: pass.ok, at: Date.now() });
    await waitFor(id, hint);
  }
}

say(`Prize Draw draw bot — ${HOST_URL} chain ${CH} ${MOD} (beacon verifier ${DRAND}, hash ${DRAND_PIN}, drand chain ${DRAND_CHAIN.slice(0, 12)}… — checked on chain)`);
say(`signing as ${WHO} ${BOT.account.slice(0, 16)}…  poll ${POLL}ms when a beacon is close, otherwise up to ${Math.round(MAX_SLEEP / 1000)}s${ONCE ? '  (single pass)' : ''}`);
say(`earnings go to ${PAYEE}${PAYEE === BOT.account ? ' (this bot\'s own account — set DRAW_PAYEE to send them elsewhere)' : ''}`
  + `  ·  heartbeat ${HEARTBEAT_URL ? 'ON' : 'OFF (set HEARTBEAT_URL and nothing will tell you when this bot dies)'}`);
say(`${FOLLOWER_MS ? `FOLLOWER: waits ${FOLLOWER_MS / 1000}s after a round becomes drawable before touching it` : 'LEADER: acts on a round as soon as it is drawable (CRANK_FOLLOWER_MS 0)'}`
  + `  ·  every draw is dry-run first and sent with 3x its measured gas (at most ${DRAW_GAS})  ·  node timeout ${NODE_TIMEOUT / 1000}s`);
say(`each round is decided by the drand evmnet beacon pinned at its first ticket: the bot draws it once the chain's clock passes that beacon's publish time,`
  + ` from relays ${RELAYS.join(' ')}; a round nobody could draw is escaped only after its escape-from, on the chain's clock`);
if (ONCE) {
  const ids = await local(`(${MOD}.list-raffles)`);
  const oks = await Promise.all(ids.map(async (id) => {
    const pass = { ok: true };
    try { await handle(id, pass); } catch (e) { pass.ok = false; say(`${id}: ${e.message}`); }
    return pass.ok;
  }));
  // A single pass pings too, so `--once` also proves the heartbeat URL works rather than leaving
  // you to find out from the alert that never came — but only a pass that completed cleanly, on a
  // node whose clock is current, that left no round stuck.
  if (!oks.every(Boolean)) { say('the pass did not complete cleanly (see above) — no heartbeat sent'); process.exit(1); }
  const now = await chainTime().catch(() => '');
  const why = nodeLags(toMs(now), Date.now()) ? `${LAGGING} (chain time ${now || 'unreadable'})` : stuck(toMs(now));
  if (!why) { await beat(); process.exit(0); }
  say(`no heartbeat sent: ${why}`);
  process.exit(1);
}
let withheld = '';
for (;;) {
  try {
    // The list of raffles and the chain's clock, in ONE read.
    const { ids, now } = await local(`{"ids": (${MOD}.list-raffles), "now": (at 'block-time (chain-data))}`);
    for (const id of ids) {
      if (!loops.has(id)) { say(`watching ${id}`); loops.set(id, loop(id)); }
    }
    // Only when the list read SUCCEEDED, the node's clock is current, every raffle's last pass
    // completed and no round is stuck: an unreachable or lagging node must make the pings stop, or
    // the switch reports health it has not established.
    const why = nodeLags(toMs(now), Date.now()) ? LAGGING : unhealthy(ids, toMs(now));
    if (!why) {
      if (withheld) say('heartbeat on: nothing is withholding it any more');
      withheld = '';
      await beat();
    } else if (why !== withheld) {
      withheld = why;
      say(`heartbeat withheld: ${why}${why === LAGGING ? ` (chain time ${now})` : ''}`);
    }
  } catch (e) { say(`list error: ${String(e.message).slice(0, 140)}`); }
  await sleep(15000);
}
