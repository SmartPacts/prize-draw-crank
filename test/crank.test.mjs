// Tests for the three things the heartbeat and the pacing must get right:
//   - a drawable round that stays undrawn silences the heartbeat (too late, or its draws keep failing)
//   - a schedule that lapsed with no ticket sold is "nothing due", not an instant to poll towards
//   - a node whose chain time has fallen behind this machine's clock silences the heartbeat
//
// The decisions are pure functions between crank.mjs's BEACON markers and are tested from those
// exact bytes. The behaviour is tested by running crank.mjs itself against test/fake-chain.mjs, an
// in-process node + relay + heartbeat on loopback, signing with a key generated for the run.
// CRANK_FILE points the same tests at another copy of the crank.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { genKeyPair } from '@kadena/cryptography-utils';
import { startFake } from './fake-chain.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CRANK = process.env.CRANK_FILE ?? join(ROOT, 'crank.mjs');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const MIN = 60000;

// ---- the pure decisions, loaded from the bytes the crank runs
function load(env = {}) {
  const s = readFileSync(CRANK, 'utf8');
  const a = s.indexOf('// ==== BEGIN BEACON ===='), b = s.indexOf('// ==== END BEACON ====');
  assert.ok(a >= 0 && b > a, 'the BEACON markers are missing');
  const ctx = vm.createContext({ process: { env }, MAX_SLEEP: 300000, AbortSignal, Date, Number, String, JSON, Math, Set, say: () => {} });
  return vm.runInContext(`${s.slice(a, b)}\n;({ toMs, scheduleHint, stuckWhy, STUCK_MS, STUCK_FAILS, NODE_LAG_MS, nodeLags })`, ctx);
}

describe('the decisions', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z');

  test('a schedule still ahead of the chain clock is a hint; one at or behind it, or none, is not', () => {
    const { scheduleHint } = load();
    assert.deepEqual({ ...scheduleHint('2026-10-01T12:00:01Z', NOW) }, { at: '2026-10-01T12:00:01Z' });
    assert.equal(scheduleHint('2026-10-01T12:00:00Z', NOW), undefined);
    assert.equal(scheduleHint('2026-10-01T11:00:00Z', NOW), undefined);
    assert.equal(scheduleHint('1970-01-01T00:00:00Z', NOW), undefined);
    assert.equal(scheduleHint('', NOW), undefined);
  });

  test('a leader calls a round stuck strictly after 15 minutes drawable, or at two failed draws', () => {
    const { stuckWhy } = load();
    const o = { what: 'r round 1', beaconAt: '2026-10-01T12:00:00Z', dueMs: NOW, fails: 0 };
    assert.equal(stuckWhy(o, NOW), '');
    assert.equal(stuckWhy(o, NOW + 15 * MIN), '');
    assert.match(stuckWhy(o, NOW + 15 * MIN + 1), /r round 1 has been drawable since 2026-10-01T12:00:00Z .* 15 min/);
    assert.equal(stuckWhy({ ...o, fails: 1 }, NOW), '');
    assert.match(stuckWhy({ ...o, fails: 2 }, NOW), /r round 1 .* failed on chain 2 times or more/);
    // the reason is the same text on every call, so it can be said once
    assert.equal(stuckWhy(o, NOW + 16 * MIN), stuckWhy(o, NOW + 600 * MIN));
  });

  test('a follower gets its own wait on top of the 15 minutes', () => {
    const { stuckWhy } = load({ CRANK_FOLLOWER_MS: '90000' });
    const o = { what: 'r round 1', beaconAt: '2026-10-01T12:00:00Z', dueMs: NOW, fails: 0 };
    assert.equal(stuckWhy(o, NOW + 15 * MIN + 1), '');
    assert.equal(stuckWhy(o, NOW + 15 * MIN + 90000), '');
    assert.notEqual(stuckWhy(o, NOW + 15 * MIN + 90001), '');
    assert.notEqual(stuckWhy({ ...o, fails: 2 }, NOW), '');
  });

  test('a node lags strictly past 10 minutes behind the wall clock; an unreadable chain time lags', () => {
    const { nodeLags } = load();
    assert.equal(nodeLags(NOW - 3 * MIN, NOW), false);
    assert.equal(nodeLags(NOW - 10 * MIN, NOW), false);
    assert.equal(nodeLags(NOW - 10 * MIN - 1, NOW), true);
    assert.equal(nodeLags(NOW + 5 * MIN, NOW), false);
    assert.equal(nodeLags(NaN, NOW), true);
  });

  test('the thresholds are the ones the README states', () => {
    const { STUCK_MS, STUCK_FAILS, NODE_LAG_MS } = load();
    assert.equal(STUCK_MS, 900000);
    assert.equal(STUCK_FAILS, 2);
    assert.equal(NODE_LAG_MS, 600000);
    for (const said of ['for more than 15 minutes', 'failed twice', 'more than 10 minutes behind'])
      assert.ok(README.includes(said), `the README no longer says "${said}"`);
  });
});

// ---- the crank itself, against the fake
const dir = mkdtempSync(join(tmpdir(), 'crank-test-'));
const keys = genKeyPair();
const ACCOUNTS = join(dir, 'accounts.json');
writeFileSync(ACCOUNTS, JSON.stringify({ admin: { account: `k:${keys.publicKey}`, ...keys } }), { mode: 0o600 });
const running = new Set();
after(async () => {
  for (const r of running) await r.stop();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Run the crank against a fake. Resolves to { fake, out(), exit, stop }. */
async function run(world, { args = [], env = {} } = {}) {
  const fake = await startFake(world);
  const child = spawn(process.execPath, [CRANK, ...args], {
    // Nothing is inherited: a mainnet setting in the caller's environment must never reach this run.
    env: {
      PATH: process.env.PATH, DEVNET_HOST: fake.url, DEVNET_NETWORK_ID: 'recap-development', CHAIN_ID: '2', DRAW_NS: 'free',
      DRAW_ACCOUNTS: ACCOUNTS, DRAND_RELAYS: fake.relayUrl, HEARTBEAT_URL: fake.beatUrl,
      POLL_MS: '100', BEACON_RETRY_MS: '200', NODE_TIMEOUT_MS: '5000', ...env,
    },
  });
  let text = '';
  child.stdout.on('data', (c) => { text += c; });
  child.stderr.on('data', (c) => { text += c; });
  const exit = new Promise((r) => child.on('exit', (code) => r(code)));
  const r = {
    fake, out: () => text, exit,
    stop: async () => { running.delete(r); child.kill('SIGKILL'); await exit; await fake.close(); },
  };
  running.add(r);
  return r;
}
/** Wait until `cond()` holds; fail with the crank's own log if it never does. */
async function until(r, cond, what, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(50); }
  assert.fail(`timed out waiting for: ${what}\n--- crank log ---\n${r.out()}`);
}
const withheldLines = (r) => r.out().split('\n').filter((l) => l.includes('heartbeat withheld:'));

describe('the crank against a fake node', { concurrency: true }, () => {
  before(() => assert.ok(readFileSync(CRANK, 'utf8').length > 0));

  test('a schedule that lapsed with no ticket sold is read once, then slept on — not polled', async () => {
    const r = await run({ raffles: { lapsed: { nextDrawsIn: -60 * MIN } } });
    await until(r, () => r.fake.count(/get-raffle "lapsed"/) >= 1, 'the first read of the raffle');
    await sleep(3000);   // 30 polls' worth at POLL_MS 100
    const reads = r.fake.count(/get-raffle "lapsed"/);
    assert.equal(reads, 1, `the raffle was read ${reads} times in 3 s\n${r.out()}`);
    await r.stop();
  });

  test('a schedule still ahead is kept as the instant to wake for', async () => {
    const r = await run({ raffles: { ahead: { nextDrawsIn: 30 * MIN } } });
    await until(r, () => /ahead: nothing to do before /.test(r.out()), 'the crank saying what it is waiting for');
    await r.stop();
  });

  test('a drawable round is drawn at once, whatever the raffle schedule says', async () => {
    const r = await run({ raffles: { live: { rounds: [{ beaconDueIn: -MIN }] } } });
    await until(r, () => r.fake.world.live.rounds[0].state === 'drawn', 'the draw to be sent and mined', 15000);
    assert.equal(r.fake.sends, 1);
    // and with the round settled and nothing stuck, the heartbeat goes out
    await until(r, () => r.fake.pings > 0, 'a heartbeat ping after the draw');
    assert.deepEqual(withheldLines(r).filter((l) => !l.includes('has not completed a pass yet')), []);
    await r.stop();
  });

  test('a round drawable for more than 15 minutes with no beacon to be had withholds the heartbeat', async () => {
    const r = await run({ relay: 'missing', raffles: { late: { rounds: [{ beaconDueIn: -16 * MIN }] } } });
    await until(r, () => r.fake.pings > 0 || /heartbeat withheld: late round 1 has been drawable since/.test(r.out()),
      'a ping, or the heartbeat being withheld for the late round');
    assert.equal(r.fake.pings, 0, `the heartbeat was sent while a round sat undrawn\n${r.out()}`);
    assert.match(r.out(), /no relay answered/);
    await r.stop();
  });

  test('control: the same round, drawable for one minute, does not withhold it', async () => {
    const r = await run({ relay: 'missing', raffles: { fresh: { rounds: [{ beaconDueIn: -MIN }] } } });
    await until(r, () => r.fake.pings > 0, 'a heartbeat ping');
    assert.match(r.out(), /no relay answered/);
    assert.doesNotMatch(r.out(), /has been drawable since/);
    await r.stop();
  });

  test('two draws that pass the dry run and fail when mined withhold the heartbeat', async () => {
    const r = await run({ mined: 'failure', raffles: { failing: { rounds: [{ beaconDueIn: -MIN }] } } });
    await until(r, () => r.fake.pings > 0 || /heartbeat withheld: failing round 1 is drawable and its draw has failed on chain/.test(r.out()),
      'a ping, or the heartbeat being withheld for the failing round');
    assert.equal(r.fake.pings, 0, `the heartbeat was sent while a round's draws kept failing\n${r.out()}`);
    assert.ok(r.fake.sends >= 2, `only ${r.fake.sends} draw(s) were sent`);
    await r.stop();
  });

  test('a node whose chain time is 11 minutes behind withholds the heartbeat, and says so once', async () => {
    const r = await run({ lagMs: 11 * MIN });
    // two full rounds of the 15 s main loop, so a second "withheld" line would have been written
    await until(r, () => r.fake.pings > 0 || r.fake.count(/^\{"ids":/) >= 3, 'three list reads, or a ping');
    assert.equal(r.fake.pings, 0, `the heartbeat was sent on a lagging node\n${r.out()}`);
    const lines = withheldLines(r);
    assert.equal(lines.length, 1, `said ${lines.length} times\n${r.out()}`);
    assert.match(lines[0], /the node's chain time is more than 10 min behind this machine's clock \(chain time /);
    await r.stop();
  });

  test('control: a node one minute behind keeps the heartbeat on', async () => {
    const r = await run({ lagMs: MIN });
    await until(r, () => r.fake.pings > 0, 'a heartbeat ping');
    assert.deepEqual(withheldLines(r), []);
    await r.stop();
  });

  test('--once: exits 0 and pings on a healthy node; exits 1 and does not ping on a lagging one or with a stuck round', async () => {
    const good = await run({ raffles: { idle: {} } }, { args: ['--once'] });
    assert.equal(await good.exit, 0, good.out());
    assert.equal(good.fake.pings, 1);
    await good.stop();

    const lagging = await run({ lagMs: 11 * MIN, raffles: { idle: {} } }, { args: ['--once'] });
    assert.equal(await lagging.exit, 1, lagging.out());
    assert.equal(lagging.fake.pings, 0);
    assert.match(lagging.out(), /no heartbeat sent: the node's chain time is more than 10 min behind/);
    await lagging.stop();

    const stuck = await run({ relay: 'missing', raffles: { late: { rounds: [{ beaconDueIn: -16 * MIN }] } } }, { args: ['--once'] });
    assert.equal(await stuck.exit, 1, stuck.out());
    assert.equal(stuck.fake.pings, 0);
    assert.match(stuck.out(), /no heartbeat sent: late round 1 has been drawable since/);
    await stuck.stop();
  });
});
