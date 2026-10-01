// A minimal in-process stand-in for everything the crank talks to, on one loopback port: a
// Chainweb node's Pact endpoints (/local, /send, /poll), a drand relay, and a heartbeat URL.
// Nothing here touches a network. It answers exactly the reads crank.mjs makes, from a small
// state the test sets, and counts what it was asked.
//
//   const fake = await startFake({ lagMs, raffles, relay, mined });
//   fake.url          the node            (DEVNET_HOST)
//   fake.relayUrl     the drand relay     (DRAND_RELAYS)
//   fake.beatUrl      the heartbeat URL   (HEARTBEAT_URL)
//   fake.count(re)    how many /local reads had code matching `re`
//   fake.sends, fake.pings
import { createServer } from 'node:http';

export const NS = 'free';
export const MOD = `${NS}.prize-draw`;
export const DRAND_CHAIN = '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
// Any 43 characters of the hash alphabet: the crank only checks the deployed code and the deployed
// verifier agree on it.
export const DRAND_PIN = 'A'.repeat(43);
export const SIG = 'ab'.repeat(64);
const EPOCH = '1970-01-01T00:00:00Z';

const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const time = (ms) => ({ time: iso(ms) });

/** `lagMs`: how far the node's chain time sits behind this machine's clock.
 *  `raffles`: { id: { nextDrawsIn?: ms from chain now (negative = lapsed; omitted = unscheduled),
 *                     rounds?: [{ beaconDueIn: ms from chain now (negative = already due) }] } }
 *  `relay`: 'ok' answers every beacon, 'missing' answers 404.
 *  `mined`: 'success' or 'failure' — what a sent draw does once mined. */
export async function startFake({ lagMs = 30000, raffles = {}, relay = 'ok', mined = 'success' } = {}) {
  const chainNow = () => Date.now() - lagMs;
  const t0 = chainNow();
  const world = Object.fromEntries(Object.entries(raffles).map(([id, r]) => [id, {
    nextDrawsAt: r.nextDrawsIn === undefined ? EPOCH : iso(t0 + r.nextDrawsIn),
    rounds: (r.rounds ?? []).map((rd, i) => ({
      state: 'selling', tickets: 3, drand: 1000 + i,
      closesAt: iso(t0 + rd.beaconDueIn - 180000), beaconAt: iso(t0 + rd.beaconDueIn),
      escapeFrom: iso(t0 + rd.beaconDueIn + 90 * 86400000),
    })),
  }]));
  const fake = { reads: [], sends: 0, pings: 0, world, count: (re) => fake.reads.filter((c) => re.test(c)).length };
  const pending = new Map();   // request key -> the code that was sent

  const ok = (data, gas = 100) => ({ gas, result: { status: 'success', data }, reqKey: 'local', logs: '', metaData: { blockHeight: 1 }, continuation: null, txId: null, events: [] });
  const fail = (message) => ({ gas: 0, result: { status: 'failure', error: { message } }, reqKey: 'local', logs: '', metaData: { blockHeight: 1 }, continuation: null, txId: null, events: [] });
  const round = (code) => { const m = code.match(/"([^"]+)" (\d+)/); return [world[m[1]], world[m[1]]?.rounds[Number(m[2]) - 1]]; };

  /** One Pact expression, answered as the contract would for the state above. */
  function answer(code) {
    if (code.includes(`(at 'code (describe-module "${MOD}"))`)) return ok(`(module prize-draw G (use ${NS}.drand "${DRAND_PIN}" [verify]))`);
    if (code.includes(`(at 'hash (describe-module "${NS}.drand"))`)) return ok(DRAND_PIN);
    if (code === `${NS}.drand.CHAIN-HASH`) return ok(DRAND_CHAIN);
    if (code.includes('coin.get-balance')) return ok(true);
    if (code.startsWith('{"ids":')) return ok({ ids: Object.keys(world), now: time(chainNow()) });
    if (code === `(${MOD}.list-raffles)`) return ok(Object.keys(world));
    if (code === `(at 'block-time (chain-data))`) return ok(time(chainNow()));
    if (code.startsWith(`(${MOD}.get-raffle `)) {
      const [r] = round(`${code.match(/"[^"]+"/)[0]} 1`);
      return ok({ 'next-draws-at': { time: r.rounds.length ? EPOCH : r.nextDrawsAt }, 'round-seq': { int: r.rounds.length } });
    }
    if (code.startsWith(`(${MOD}.get-round `)) {
      const [, rd] = round(code);
      return ok({ state: rd.state, tickets: { int: rd.tickets }, 'closes-at': { time: rd.closesAt } });
    }
    if (code.startsWith(`(${MOD}.draw-status `)) {
      const [, rd] = round(code);
      return ok({ 'drand-round': { int: rd.drand }, 'beacon-at': { time: rd.beaconAt }, 'escape-from': { time: rd.escapeFrom } });
    }
    if (code.startsWith(`(${MOD}.preview `)) {
      const [, rd] = round(code);
      return rd.state === 'selling' ? ok({ 'drand-round': { int: rd.drand }, ranks: [{ int: 1 }], amounts: [{ decimal: '1.0' }] }) : fail('this round is settled — nothing to preview');
    }
    if (code.startsWith(`(${MOD}.draw `)) {
      const [, rd] = round(code);
      return rd.state === 'selling' ? ok('drawn', 4000) : fail('this round is already settled');
    }
    return fail(`fake chain: no answer for ${code.slice(0, 80)}`);
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname;
      const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (path === '/beat') { fake.pings++; return json(200, {}); }
      if (path.startsWith('/relay/')) {
        const n = Number(path.split('/').pop());
        return relay === 'ok' ? json(200, { round: n, signature: SIG, randomness: 'unused' }) : json(404, {});
      }
      if (path.endsWith('/api/v1/local')) {
        const code = JSON.parse(JSON.parse(body).cmd).payload.exec.code;
        fake.reads.push(code);
        return json(200, answer(code));
      }
      if (path.endsWith('/api/v1/send')) {
        const { hash, cmd } = JSON.parse(body).cmds[0];
        pending.set(hash, JSON.parse(cmd).payload.exec.code);
        fake.sends++;
        return json(200, { requestKeys: [hash] });
      }
      if (path.endsWith('/api/v1/poll')) {
        const out = {};
        for (const rk of JSON.parse(body).requestKeys) {
          const code = pending.get(rk);
          if (!code) continue;
          const r = mined === 'success' ? answer(code) : fail('fake chain: the draw failed when it was mined');
          if (r.result.status === 'success' && code.startsWith(`(${MOD}.draw `)) round(code)[1].state = 'drawn';
          out[rk] = { ...r, reqKey: rk };
        }
        return json(200, out);
      }
      return json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return Object.assign(fake, {
    url: base, relayUrl: `${base}/relay`, beatUrl: `${base}/beat`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  });
}
