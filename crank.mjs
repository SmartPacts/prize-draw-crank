// Prize Draw — the draw bot. Watches every raffle and settles its rounds. At each
// round's DRAW INSTANT it OPENS THE DRAW, which fixes the round's candidate
// blocks as the next ones on the chain; it then RECORDS them into block-history
// itself and, the moment ANY candidate is on record, sends the draw. If none of
// the candidates is ever recorded it escapes the round as soon as that is
// certain and pushes every refund. Anyone may run this; it holds no privilege
// and cannot choose an outcome — every call it makes is permissionless, and the
// winner is a pure function of the round's key and of a block hash nobody
// picked. Run at least two of these, on separate machines.
//
//   cd site && node crank.mjs              (add --once to do a single pass)
//   DRAW_ATTEST=off node crank.mjs        settle only: never record a block
//
// THE FLOW, PER ROUND. A round runs on the CALENDAR: the operator scheduled it
// (opens-at, closes-at, draws-at — chain time, the PARENT block's stamp), and
// the round EXISTS ONLY FROM ITS FIRST TICKET, which freezes those instants and
// the raffle's terms into it. Nothing about the draw exists until draws-at:
// then ANYONE may send `open-draw`, which fixes the round's CANDIDATE blocks as
// decide-height = that block + DECIDE-DELAY and the DECIDE-WINDOW - 1 after it
// (three, read from the module). The deciding block is the LOWEST RECORDED of
// them; the module reports it as draw-status's `deciding-block`, -1 while none
// is. The seed is that block's hash mixed with the round key — public, pure.
//   no round          ...  nothing to do: a round is started by a buyer, never
//                          by this bot
//   selling           ...  nothing to do, until closes-at
//   sales closed      ...  nothing to do, until draws-at
//   draw instant      ...  send open-draw (gas only) and, in the SAME pass, go
//                          straight to the window it just named
//   window open       ...  attest, shot after shot, from decide-height - 1 until
//                          ANY candidate is on record or the last one's chance is gone
//   a block decides   ...  send the draw AT ONCE (this bot is the draw-share
//                          payee) — no confirmations wait, nothing to publish
//   none recorded     ...  the round can never be drawn: escape it the moment
//                          the window has closed and refund every buyer
//   never opened      ...  should NEVER happen while a bot runs: if the draw is
//                          still unopened OPEN-DRAW-GRACE-SECONDS past draws-at,
//                          the bot says so LOUDLY, still tries to open it (a
//                          late-opened draw is a fair draw), and only if the
//                          module refuses escapes it — every stake returned
//
// WHY IT ATTESTS THE WINDOW ITSELF. block-history's `attest` takes no arguments:
// a transaction mined in block N writes down block N-1 from values the engine
// handed it, so a recorder chooses neither the height nor the hash — only
// whether to speak. Candidate c can be recorded only by a transaction mined in
// block c+1, and on mainnet about one block in twelve gets no recording at all
// because miners refresh their block template only every ~15 s — which is why a
// round has three candidates. A miss is not a failure: the next candidate is
// what the window is for. "already recorded" is the good answer — another
// recorder got there first.
//
// WHY MORE THAN ONE RECORDER MATTERS. A recorder that is ALONE sees each
// candidate's outcome as it is mined and can decline to record one it dislikes
// and take the next — a best of three at most. An independent recorder removes
// that: it records whatever it sees. So this bot records every candidate it
// can, and the design asks for at least two of it on separate machines.
//
// WHY SHOT AFTER SHOT. A transaction sent while the tip is at H is mined one or
// two blocks later, so any single send is a coin flip for a given block. The bot
// signs a fresh shot (its own nonce) every SHOT_MS while the tip is between
// decide-height - 1 and the last candidate, and stops the moment any candidate
// is recorded. A shot that lands late records some later block, which is harmless.
//
// DRAW_ATTEST=off makes this a settler only: it opens draws, draws, escapes
// and refunds, and records nothing. That is how a crank runs beside independent
// recorders — and how a devnet proof forces candidates to be missed, because
// with no recorder running nothing can record them.
//
// Every raffle runs in its OWN loop. Two rounds that opened near each other have
// windows near each other, and a bot busy firing at one would walk straight past
// the other's.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pact, createClient, createSignWithKeypair } from '@kadena/client';

const HOST_URL = process.env.DEVNET_HOST ?? 'http://localhost:8090';
const NETWORK = process.env.DEVNET_NETWORK_ID ?? 'recap-development';
// Chain 2 by default, like the site: on the casino devnet, chains 0 and 1 hold
// OLDER immutable block-history versions and the pinned module never loads there.
const CH = process.env.CHAIN_ID ?? '2';
const NS = process.env.DRAW_NS ?? 'free';
const MOD = `${NS}.prize-draw`;
const POLL = Number(process.env.POLL_MS ?? 2500);
// 🔴 THE BOT SLEEPS UNTIL THE NEXT THING THAT COULD NEED DOING, and polls at POLL only when that
// thing is close. It waits for exactly two kinds of event: a CLOCK INSTANT it already knows (a
// round's draw instant, frozen into the round at its first ticket and readable from the raffle
// row before the round even exists), and a CANDIDATE BLOCK being recorded, which can only happen
// inside a window it can see coming. Everything else is dead air, and polling through it taught
// us nothing at the cost of ~35k reads a day per idle raffle against a node we do not own.
// MAX_SLEEP bounds how stale a long sleep can make us: the operator can re-schedule a round to
// draw EARLIER while we sleep, and this is what caps how late that can leave us.
const MAX_SLEEP = Number(process.env.MAX_SLEEP_MS ?? 300000);
// Wake this early, so the first tight pass happens just BEFORE the instant rather than after it.
const LEAD = Number(process.env.LEAD_MS ?? 5000);
const TIGHT = { tight: true };
const SHOT_MS = Number(process.env.SHOT_MS ?? 1500);
// On mainnet the bot attests only when told to: whether ops records the raffle's
// chain at all is a decision, not a default (see STATUS.md), so DRAW_ATTEST=on is
// required there and the devnet default of 'on' does not carry over.
const ATTEST = (process.env.DRAW_ATTEST ?? (NETWORK === 'mainnet01' ? 'off' : 'on')) !== 'off';
const ONCE = process.argv.includes('--once');
const GAS_PRICE = 0.00000001;
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
  console.error(`ARMED for mainnet01 chain ${CH}: signing as ${WHO}, attest ${ATTEST ? 'ON' : 'off'}, namespace ${NS}`);
}


if (!existsSync(ACCTS)) { console.error(`no personas at ${ACCTS}`); process.exit(1); }
const BOT = JSON.parse(readFileSync(ACCTS, 'utf8'))[WHO];
if (!BOT) { console.error(`no persona "${WHO}" in ${ACCTS}`); process.exit(1); }
const client = createClient(({ chainId, networkId }) =>
  `${HOST_URL}/chainweb/0.0/${networkId}/chain/${chainId}/pact`);

const unwrap = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(unwrap);
  if ('int' in v) { const n = Number(v.int); return Number.isSafeInteger(n) ? n : String(v.int); }
  if ('decimal' in v) return Number(v.decimal);
  // Pact 5 encodes a time as {"time": "…Z"} on a whole second and {"timep":
  // "….%vZ"} otherwise (pact-5 LegacyCodec.hs, timeCodec). Only a one-key object
  // is a time: block-history's {hash, time, by} rows must stay objects.
  if ('timep' in v) return v.timep;
  if ('time' in v && Object.keys(v).length === 1) return v.time;
  const o = {}; for (const [k, x] of Object.entries(v)) o[k] = unwrap(x); return o;
};
// An instant as milliseconds; Pact's high-precision form carries microseconds,
// which Date.parse does not take, so the fraction is cut to milliseconds first.
const toMs = (iso) => Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1'));
const stamp = () => new Date().toLocaleTimeString();
const say = (m) => console.log(`${stamp()}  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function local(code) {
  const tx = Pact.builder.execution(code)
    .setMeta({ chainId: CH, senderAccount: BOT.account, gasLimit: 150000, gasPrice: GAS_PRICE })
    .setNetworkId(NETWORK).createTransaction();
  const r = await client.local(tx, { preflight: false, signatureVerification: false });
  if (r.result.status !== 'success') throw new Error(JSON.stringify(r.result.error));
  return unwrap(r.result.data);
}
const build = (code, gasLimit, nonce) => {
  const tx = Pact.builder.execution(code)
    .addSigner(BOT.publicKey, (wc) => [wc('coin.GAS')])
    .setMeta({ chainId: CH, senderAccount: BOT.account, gasLimit, gasPrice: GAS_PRICE })
    .setNetworkId(NETWORK).addData('n', nonce).createTransaction();
  return createSignWithKeypair(BOT)(tx);
};
// `timeout` is how long to wait for the transaction to be MINED. A draw was
// measured taking up to ~27 blocks to be included on the devnet when it carried
// a whole-block gas limit, so it gets a longer window than the small cranks;
// giving up early only produces a false "refused" for a draw that is still
// pending (a re-sent duplicate is refused by the module, never paid twice).
async function send(code, label, gasLimit = 20000, timeout = 120000) {
  const signed = await build(code, gasLimit, `${label}-${Date.now()}`);
  const r = await client.pollOne(await client.submit(signed), { timeout, interval: 2000 });
  if (r.result.status !== 'success') throw new Error(JSON.stringify(r.result.error).slice(0, 180));
  say(`  ${label} ok (gas ${r.gas}, block ${r?.metaData?.blockHeight})`);
  return unwrap(r.result.data);
}
async function height() {
  const r = await fetch(`${HOST_URL}/chainweb/0.0/${NETWORK}/cut`);
  return Number((await r.json()).hashes[CH].height);
}
// The chain's clock, exactly as the module reads it: (chain-data)'s block-time
// over /local — the PARENT block's stamp, the value every calendar gate in the
// contract compares against. Never the wall clock: a devnet's chain time can sit
// hours behind it, and a transaction mined in the next block sees a time at or
// past this one, so "the chain says it is past X" means a send now lands past X.
async function chainTime() {
  return String(await local(`(at 'block-time (chain-data))`));
}

// Read from the module, never assumed: how many candidates decide a round. A
// crank that guessed this could escape a round that is still decidable; one
// that cannot read it should not run.
// The block record the contract reads, taken from the CONTRACT ITSELF, on chain: its `(use <name>
// "<hash>" …)` line names the record FULLY (free.block-history), not relative to DRAW_NS. Reading
// it from the deployed code rather than from a local file means this bot cannot attest to a
// different record than the one the contract settles from, and needs no copy of the contract.
const CODE = await local(`(at 'code (describe-module "${MOD}"))`).catch((e) => {
  console.error(`cannot read ${MOD} from ${HOST_URL}: ${String(e.message).slice(0, 160)}`);
  console.error('the contract must be deployed on this chain before a crank can run against it');
  process.exit(1);
});
const USE = String(CODE).match(/\(use ([\w.-]+\.block-history) "[A-Za-z0-9_-]{43}"/);
if (!USE) { console.error(`${MOD} on chain does not name a block-history record — is this the right module?`); process.exit(1); }
const BH = USE[1];

const W = await local(`${MOD}.DECIDE-WINDOW`);
// Seconds of chain time past a round's draw instant after which a draw nobody
// opened lets the round escape. This bot opens draws, so reaching it means no
// bot was running; it is read so the bot can say how far past it a round is.
const OPEN_GRACE = Number(await local(`${MOD}.OPEN-DRAW-GRACE-SECONDS`));

const ORD = ['first', 'second', 'third', 'fourth', 'fifth'];
/** Which candidate decided, in words, and which ones before it were missed. */
function whichCandidate(d, dh) {
  if (d === dh) return `the first candidate`;
  const missed = Array.from({ length: d - dh }, (_, i) => dh + i).join(', ');
  return `the ${ORD[d - dh] ?? `#${d - dh + 1}`} candidate — block(s) ${missed} never recorded`;
}

/** Record one of a round's candidate blocks. Fires a freshly signed attest every
 *  SHOT_MS while the tip sits between dh-1 and the last candidate, and stops as
 *  soon as ANY candidate is on record — from then on nothing changes which one
 *  decides. Returns the deciding block, or -1 if none is recorded (yet). Shots
 *  still in flight are left to land on their own, so the draw is not held up. */
async function attestWindow(id, seq, dh) {
  const last = dh + W - 1;
  say(`${id} round ${seq}: candidate blocks ${dh}..${last} — attesting from height ${dh - 1} until one is on record`);
  let n = 0, lastFire = 0;
  for (;;) {
    const h = await height();
    if ((await local(`(${MOD}.decided-height ${dh})`)) >= 0 || h > last) break;
    if (h >= dh - 1 && Date.now() - lastFire >= SHOT_MS) {
      const i = ++n; lastFire = Date.now(); const sentAt = h;
      const signed = await build(`(${BH}.attest)`, 400, `attest-${id}-${seq}-${dh}-${i}-${Date.now()}`);
      client.submit(signed)
        .then((rk) => client.pollOne(rk, { timeout: 90000, interval: 1000 }))
        .then((r) => {
          const at = r?.metaData?.blockHeight;
          const ok = r?.result?.status === 'success';
          say(`  ${id} shot ${i} sent at ${sentAt}, mined in block ${at}: ${ok ? r.result.data : 'FAILED'}`
            + (at - 1 >= dh && at - 1 <= last ? `  <- the block that can record candidate ${at - 1}` : ''));
        })
        .catch((e) => say(`  ${id} shot ${i} lost: ${String(e.message).slice(0, 100)}`));
    }
    await sleep(700);
  }
  return local(`(${MOD}.decided-height ${dh})`);
}

/** Push every unpaid buyer's refund out of an escaped round. */
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
    catch (e) { say(`  refund refused: ${e.message}`); }
  }
  return open === 0;
}

const reported = new Set();   // things already announced, so a poll loop says each once
const finished = new Set();   // rounds this bot has nothing left to do for

/** Say a thing once per key, however many times the loop comes round. */
function once(key, msg) {
  if (reported.has(key)) return;
  reported.add(key);
  say(msg);
}

/** Escape a round that can never be drawn, then push every buyer's refund. */
async function escapeAndRefund(id, seq, why, tickets, key) {
  try { say(`  ${await send(`(${MOD}.escape "${id}" ${seq})`, `${id} ESCAPE (${why})`)}`); }
  catch (e) { say(`  escape refused: ${e.message}`); return; }
  if (await refund(id, seq, tickets)) { finished.add(key); say(`${id} round ${seq}: every buyer refunded`); }
}

/** One round, wherever it stands. Returns when to look again: TIGHT, or { at: <chain instant> },
 *  or nothing when this round needs no further attention and the raffle decides the pace. */
async function handleRound(id, seq, rd, key) {
  if (rd.state === 'drawn') { finished.add(key); return; }
  if (rd.state === 'escaped') {
    if (rd.tickets === 0) { finished.add(key); return; }
    if (await refund(id, seq, rd.tickets)) { finished.add(key); say(`${id} round ${seq}: every buyer refunded`); return; }
    return TIGHT;
  }
  // A round row from an earlier generation comes back exactly as it was
  // written — Pact adds no fields a later schema declared and removes none an
  // older one had — and this module settles only a "selling" round that holds
  // at least one ticket (a round now exists only from its first ticket).
  // Nothing here can move any other row; say so once instead of failing every poll.
  if (rd.state !== 'selling' || !(rd.tickets > 0)) {
    once(key, `${id} round ${seq} is in state "${rd.state}" with ${rd.tickets} ticket(s) — a row from an earlier generation that no path settles. Skipping.`);
    finished.add(key);
    return;
  }

  // Every calendar comparison below is against the CHAIN's clock, the one the
  // module's own gates read. The round's three instants were frozen by its first
  // ticket; a `time` comes back as an ISO string once unwrapped.
  const now = await chainTime();
  const ca = rd['closes-at'], da = rd['draws-at'];
  if (toMs(now) < toMs(ca)) {                                        // still selling
    once(`${key}|selling`, `${id} round ${seq}: selling until ${ca} (${rd.tickets} ticket(s) so far); the draw opens at ${da}`);
    // Nothing for this bot to do while a round sells: buyers open it, and the bot's first move is
    // open-draw at the draw instant. Sleep to it.
    return { at: da };
  }

  // 0. OPEN THE DRAW. Between close and draw nothing exists that could decide
  //    the round: no candidate block is named until somebody sends open-draw at
  //    or after draws-at, and that somebody is this bot. Permissionless, gas
  //    only, and whoever sends it chooses nothing — the heights it fixes are
  //    DECIDE-DELAY blocks in the future. The window it names starts two blocks
  //    after the transaction lands, so the bot goes straight to the window in
  //    this same pass rather than waiting a poll.
  let dh = rd['decide-height'];
  if (dh === 0) {
    if (toMs(now) < toMs(da)) {
      once(`${key}|drawwait`, `${id} round ${seq}: sales closed at ${ca} with ${rd.tickets} ticket(s) — the draw opens at ${da}, and this bot will open it then`);
      return { at: da };
    }
    const lateBy = (toMs(now) - toMs(da)) / 1000;
    if (lateBy > OPEN_GRACE) {
      // Should never be reached while a bot runs: the draw instant is a day or
      // more behind and nobody opened it. Say so loudly. A draw opened late is
      // still a fair draw — the candidates are still future blocks — so open it
      // anyway, and escape only if the module refuses.
      once(`${key}|neveropened`, `!!! ${id} round ${seq}: its draw instant ${da} passed ${Math.round(lateBy / 3600)} h ago and NOBODY opened the draw`
        + ` — no bot was running. The round is past the module's ${OPEN_GRACE}-second open grace and could be escaped; trying to open the draw`
        + ` first, because a late draw is still a fair one. If the module refuses, it escapes: every stake goes home.`);
    }
    try {
      say(`  ${await send(`(${MOD}.open-draw "${id}" ${seq})`, `${id} OPEN-DRAW round ${seq}`, 5000)}`);
    } catch (e) {
      say(`  open-draw refused: ${e.message}`);
      if (lateBy > OPEN_GRACE) await escapeAndRefund(id, seq, 'the draw was never opened', rd.tickets, key);
      return;
    }
    const opened = await local(`(${MOD}.get-round "${id}" ${seq})`);
    dh = opened['decide-height'];
    if (!(dh > 0)) { say(`  ${id} round ${seq}: open-draw landed but decide-height still reads 0 — checking again next poll`); return TIGHT; }
    say(`  ${id} round ${seq}: draw opened at chain time ${now} — candidate blocks ${dh}..${dh + W - 1}`);
  }

  // From here every step is keyed on decide-height: the candidates, which of
  // them (if any) is on record, and whether the window is over.
  const last = dh + W - 1;              // the last candidate block
  let h = await height();
  let status = await local(`(${MOD}.draw-status "${id}" ${seq})`);

  // 1. no candidate is on record and one still can be: be a recorder
  if (!status['block-recorded'] && h <= last) {
    if (!ATTEST) {
      once(`${key}|window`, `${id} round ${seq}: candidate blocks ${dh}..${last} — this bot records nothing`
        + ` (DRAW_ATTEST=off) and waits for another recorder`);
      return TIGHT;
    }
    const d0 = await attestWindow(id, seq, dh);
    if (d0 < 0) { say(`  ${id} no candidate of round ${seq} on record yet — checking again`); return TIGHT; }
    say(`  ${id} block ${d0} decides round ${seq}: ${whichCandidate(d0, dh)}`);
    status = await local(`(${MOD}.draw-status "${id}" ${seq})`);   // and draw in this same pass
    h = await height();
  }
  const d = status['deciding-block'];

  // 2. a candidate is on record: the outcome is public and final, so settle it
  //    NOW. There is no confirmations wait and nothing left to publish — the
  //    deciding block is the lowest recorded candidate, final the moment it
  //    exists, and `draw` is allowed from that moment.
  if (d >= 0) {
    try {
      const pv = await local(`(${MOD}.preview "${id}" ${seq})`);
      say(`${id} round ${seq}: block ${pv['deciding-block']} decides it (${whichCandidate(pv['deciding-block'], dh)}; hash`
        + ` ${pv['block-hash']}) — preview: ranks ${JSON.stringify(pv.ranks)} pay ${JSON.stringify(pv.amounts)}`);
    } catch (e) { say(`${id} round ${seq}: preview refused: ${e.message}`); }
    try { say(`  ${await send(`(${MOD}.draw "${id}" ${seq} "${BOT.account}")`, `${id} DRAW`, 8000, 300000)}`); finished.add(key); return; }
    catch (e) { say(`  draw refused: ${e.message}`); }
    return TIGHT;
  }
  // 3. no candidate yet, and the last one's single recording block (dh + W) is
  //    not mined yet: one could still land
  if (h < dh + W) return TIGHT;
  // 4. none of the candidates was recorded, and from here none ever can be: the
  //    module lets the round escape at once, and the refund is every buyer's own
  //    stake plus its share of any bonus
  once(`${key}|dead`, `!!! ${id} round ${seq}: none of blocks ${dh}..${last} was recorded — this round can never be drawn.`
    + ` Escaping it now: every buyer gets their stake back.`);
  await escapeAndRefund(id, seq, 'no candidate recorded', rd.tickets, key);
  return TIGHT;
}

/** One raffle. Returns when to look at it again — see `loop`. */
async function handle(id) {
  let r;
  try { r = await local(`(${MOD}.get-raffle "${id}")`); } catch { return TIGHT; }
  // The raffle's own pace, used when no live round has anything sooner: a round that does not
  // exist yet will draw at the instant the operator scheduled, because its first ticket freezes
  // exactly these three instants into it. EPOCH means unscheduled — nothing can happen until the
  // operator schedules, so wait out a full MAX_SLEEP.
  const nda = String(r['next-draws-at'] ?? '');
  const raffleHint = nda && !nda.startsWith('1970-01-01') ? { at: nda } : undefined;
  // No round at all: nothing here can start one. A round exists only because
  // somebody bought its first ticket, which is a buyer, never this bot.
  if (!r.current) return raffleHint;
  // The most recent round, and any EARLIER one still unsettled: the operator may
  // schedule the next round to open as soon as the current one closes, and that
  // round's first ticket then moves `current` on while the previous one is still
  // waiting for its draw instant. Walk back until a settled row (everything
  // below it is older still), a few rounds at most.
  const seq = r['round-seq'];
  let hint;
  const sooner = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    if (a.tight || b.tight) return TIGHT;
    return toMs(a.at) <= toMs(b.at) ? a : b;
  };
  for (let s = seq; s >= 1 && s > seq - 3; s--) {
    const key = `${id}|${s}`;
    if (finished.has(key)) break;
    let rd;
    try { rd = await local(`(${MOD}.get-round "${id}" ${s})`); } catch { break; }
    hint = sooner(hint, await handleRound(id, s, rd, key));
    if (rd.state !== 'selling') break;
  }
  return hint ?? raffleHint;
}

// One independent loop per raffle, started as raffles appear. Each sleeps until its own next
// instant, so a raffle drawing next Tuesday costs a handful of reads a day and a raffle whose
// window is open is polled every POLL.
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
async function loop(id) {
  for (;;) {
    let hint;
    try { hint = await handle(id); } catch (e) { say(`${id}: ${String(e.message).slice(0, 140)}`); }
    await waitFor(id, hint);
  }
}

say(`Prize Draw draw bot — ${HOST_URL} chain ${CH} ${MOD} (block record ${BH})`);
say(`signing as ${WHO} ${BOT.account.slice(0, 16)}…  poll ${POLL}ms when a draw is close, otherwise up to ${Math.round(MAX_SLEEP / 1000)}s  ${ATTEST ? `attest a shot every ${SHOT_MS}ms across the window` : 'NOT attesting (DRAW_ATTEST=off)'}${ONCE ? '  (single pass)' : ''}`);
say(`rounds run on the calendar (chain time) and exist from their first ticket: this bot opens each draw at its draw instant, which names ${W} candidate blocks;`
  + ` the lowest recorded decides, and the draw goes out the moment one is on record; a draw still unopened ${OPEN_GRACE} s past its instant is reported LOUDLY`);
if (ONCE) {
  const ids = await local(`(${MOD}.list-raffles)`);
  await Promise.allSettled(ids.map((id) => handle(id).catch((e) => say(`${id}: ${e.message}`))));
  process.exit(0);
}
for (;;) {
  try {
    for (const id of await local(`(${MOD}.list-raffles)`)) {
      if (!loops.has(id)) { say(`watching ${id}`); loops.set(id, loop(id)); }
    }
  } catch (e) { say(`list error: ${String(e.message).slice(0, 140)}`); }
  await sleep(15000);
}
