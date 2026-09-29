# prize-draw-crank

A bot that settles Prize Draw rounds on Kadena. Each round is decided by one
[drand](https://drand.love) beacon, fixed when the round's first ticket is bought: the beacon drand
publishes three minutes after the round's advertised draw instant. Once that beacon is out, the bot fetches
it and sends the draw. If a round can never be drawn, it triggers the refund and pushes every
buyer's money back.

**It holds no privilege, and that is the point.** Every call it makes — `draw`, `escape`,
`claim-escape` — is permissionless: anybody can make them, and the contract gives the sender no say
in the outcome. Under the contract's rules the winners follow from the round's key and that beacon.
Nobody can choose the beacon or know it before drand publishes it — not the house, not a miner,
not this bot; that would take a threshold of drand's own independent operators colluding. The
contract checks it against drand's public key, so a forged or wrong one is refused. drand can only
stop publishing; if nobody can draw a round for 90 days after its beacon was due, anyone can trigger
the refunds. Until the contract is frozen, its admin keys can override those rules
([details](https://github.com/SmartPacts/prize-draw#readme)). A crank pays gas and gets
the drawer's share of the round's fee, if the game sets one.

**So run one.** More independent cranks means a draw cannot be delayed by one operator's bot dying,
and none of them can steer a result. This repository exists so that anyone can.

## How it decides when to act

It follows no blocks. Its only fixed-interval read is the list of raffles, once every 15 seconds,
so it notices a new raffle. Each raffle then runs in its own loop: a round's instants — when sales
close, and when drand publishes the round's beacon — are frozen into it by its first ticket, so the
bot reads them from the chain and **sleeps until the next moment that could need it** (at most
`MAX_SLEEP_MS`, 5 minutes), polling every `POLL_MS` only when that moment is close.

It looks after **every round that is not settled yet**, not just the newest. A raffle's rounds are
numbered from 1, and the bot enters each one once. A round it has seen drawn, or escaped and
refunded, is never read again. An older round still waiting for its draw, after a crank outage or
a drand outage, is handled like the newest one. It reads at most 20 rounds per raffle in one pass,
the ones waiting longest first, so a long history is worked through over a few quick passes.

When the beacon is due it asks drand's public relays for it (`api.drand.sh`, `api2`, `api3`,
`drand.cloudflare.com`; set `DRAND_RELAYS` to change the list). An answer for any other round, or
one that is not a 128-hex-character signature, is skipped. Before sending anything it runs the
contract's own `preview` with the signature over `/local` — free, and checked on chain exactly as
the draw will be — and logs who wins. A relay whose answer is refused costs nothing: the bot asks
the next one. If no relay has the beacon, it retries, backing off the longer drand is late.

Then it **dry-runs the exact draw** it is about to send: the same code, the same signature in the
same data, the same payee, and the same signer with the `coin.GAS` capability, over `/local`. It
sends only if that passes. A draw that fails on chain still pays its whole gas limit, so:

- if the dry run says the round is already settled (another crank got there first), nothing is sent;
- if the dry run is refused for any other reason, nothing is sent, and the bot tries again later;
- if it passes, the draw is sent with a gas limit of three times what the dry run measured, at
  least 5,000 and at most 30,000. A draw that would need more than 30,000 fails its dry run and
  is never sent.

Every call to the node has a deadline (`NODE_TIMEOUT_MS`, 30 seconds; the wait for a draw to be
mined gets its own 5 minutes on top). A node that stops answering makes that pass fail. It never
hangs the bot, and it is never logged as the contract refusing something.

It reads time from the chain (the parent block's timestamp), never the wall clock, because that is
what the contract's own calendar checks compare against.

## Installing it, and updating it

One command does both, on a fresh Ubuntu machine or an existing one:

    curl -fsSLo provision-crank.sh \
      https://raw.githubusercontent.com/SmartPacts/prize-draw-crank/<commit>/provision-crank.sh
    bash provision-crank.sh <commit>

To update, run the same thing with a newer commit. It checks out that exact commit, reinstalls from
the lockfile, replaces the unit, and **restarts the service if it was running** — replacing files
does not replace the process, so without that you get new code on disk and the old bot still
running. It never touches your key or your settings, and never starts a bot that was not already
started.

## Running it by hand

    npm ci --omit=dev
    DRAW_MAINNET=armed \
    DEVNET_NETWORK_ID=mainnet01 \
    DEVNET_HOST=https://chainweb.eckowallet.com \
    CHAIN_ID=2 \
    DRAW_NS=<the contract's namespace> \
    DRAW_ACCOUNTS=/path/to/your-key.json \
    DRAW_BOT=crank \
    node crank.mjs

Add `--once` for a single pass. If the contract is not deployed on that chain it stops at
`cannot read <namespace>.prize-draw`. It ships no copy of the contract: at startup it reads the
deployed contract's code to learn which drand verifier module it uses and the code hash it is pinned
to, checks that the verifier on chain has exactly that hash, and refuses to start if not — or if the
deployed contract is not the drand version at all. It also reads that verifier's `CHAIN-HASH` and
refuses to start unless it is the drand chain the bot fetches beacons from. With the wrong chain
every beacon would be refused, no round would ever be drawn, and after 90 days every round would be
refunded. Generate a key with:

    node crank-keygen.mjs /etc/prize-draw/crank-key.json

which writes it at mode 0600 in a 0700 directory, refuses to overwrite an existing file, and prints
only the public key and the account. **Fund that account** on the raffle's chain — a few KDA lasts
months. A draw verifies the beacon on chain and pays everyone in one transaction. The bot gives it
three times the gas its dry run measured, at most 30,000.

### Settings

| variable | meaning |
|---|---|
| `DRAW_MAINNET` | must be `armed` to touch mainnet at all |
| `DEVNET_NETWORK_ID` / `DEVNET_HOST` / `CHAIN_ID` | the network, a node, and the chain the contract lives on |
| `DRAW_NS` | the contract's namespace; on mainnet it must be a principal namespace |
| `DRAW_ACCOUNTS` / `DRAW_BOT` | a JSON file of `{ "<name>": { account, publicKey, secretKey } }`, and which entry to sign with. **Must live outside this checkout.** |
| `DRAND_RELAYS` | comma-separated drand relays to fetch beacons from. A dishonest relay cannot change a winner, only fail to answer |
| `DRAW_PAYEE` | **where your earnings go.** Any ordinary account — point it at a cold wallet and the hot key here only ever holds gas. Defaults to the bot's own account |
| `HEARTBEAT_URL` | a ping URL that alerts when the pings STOP. Without one, nothing tells you this bot has died |
| `POLL_MS` / `MAX_SLEEP_MS` | the tight interval near an instant, and the cap on a long sleep |
| `CRANK_FOLLOWER_MS` | `0` (the default) makes this crank a **leader**. Set it on the second crank of a pair, e.g. `90000`, to make it a **follower** (see below) |
| `NODE_TIMEOUT_MS` | how long one call to the node may take before it counts as failed. Default 30000 |

**Set these in `/etc/prize-draw/crank.env`, not in the unit file** — an update replaces the unit and
never touches that file. `crank.env.example` is a commented copy to start from.

### Running two: one leader, one follower

Run two cranks on separate machines, so that one of them dying does not delay a draw. Left alone,
both would see a beacon in the same second and both would act. The one that lost would pay for a
draw the chain refuses, or at best a wasted dry run. So give them different roles:

- the **leader** keeps `CRANK_FOLLOWER_MS=0` and acts on a round as soon as it can be drawn;
- the **follower** sets `CRANK_FOLLOWER_MS=90000` in its `/etc/prize-draw/crank.env`. When a
  round becomes drawable (or refundable), the follower waits that long, counted from when it first
  sees the round, reads the round again, and acts only if it is still unsettled.

90 seconds is longer than a typical block interval (about 30 s on average), so the leader's draw has
normally been mined by then. The longest gap measured on chain 2 is 136 s. If the leader's draw has
not landed yet, the follower's dry run passes and it sends too. Then one of the two draws fails on
chain, at a gas limit sized from the dry run rather than the full 30,000. If the leader is down, the
follower draws the round 90 seconds late.

**The mainnet interlocks are deliberate.** Against `mainnet01` the bot refuses to start unless every
one of them is set on purpose: armed, a real node, a principal namespace, and a key file outside the
checkout. None of them has a default that a devnet session could leave behind.

## Running it as a service

`prize-draw-crank.service` is a systemd unit with those interlocks pinned, an unprivileged user, a
read-only file system and a memory cap. Installing it does not start it — enabling it is what starts
sending transactions:

    systemctl enable --now prize-draw-crank
    journalctl -u prize-draw-crank -f

What to watch for: a round that stays unsettled a few minutes past its draw instant. Anyone can
settle it by hand, so a missing crank only delays a draw. A round turns into a refund only if nobody
draws it for 90 days after its beacon was due.

## What it cannot do

It cannot choose a winner, change a raffle, or move money anywhere the contract would not send it
anyway. It never holds the contract's admin or operator authority. A stolen crank key costs what
its own account holds: with `DRAW_PAYEE` unset (the default) that is the gas **and every drawer's
share it has earned** and not moved out; with `DRAW_PAYEE` set, it is the gas alone.

It sends only a beacon the contract has already accepted in a free `/local` preview, inside a draw
that has already passed a `/local` dry run, and the contract verifies it again when the draw lands, so a bad relay can waste the bot's time but not
change a result.

## Your earnings

Settling a round pays the drawer's share of that raffle's fee to an account **the draw names**, and
the contract takes any ordinary account. Left unset, `DRAW_PAYEE` names the bot's own account, so
everything it earns piles up on the hot key here, and a stolen or lost key takes all of it. Set
`DRAW_PAYEE` to somewhere you control and this machine never holds what it earns — the key here
stays a gas key, and the worst a stolen one costs is the gas in it.

🔴 **The payee must already exist on the raffle's chain.** Payouts use a plain transfer, which does
not create an account, so an unfunded one would abort every draw. The bot checks at startup and
refuses to run rather than find out mid-round.

## Back up the key

The key is generated here and never leaves, which is what keeps it safe — and also what makes this
machine a single point of failure. There is no seed phrase to fall back on: a dead disk takes the
key's balance with it — the gas, and everything it earned unless `DRAW_PAYEE` sends that elsewhere.

    node key-backup.mjs save  /etc/prize-draw/crank-key.json  crank-key.backup
    node key-backup.mjs check crank-key.backup

Then copy the file somewhere else and delete the copy here — a backup on the disk it protects is
not a backup. It is encrypted with a passphrase you type (scrypt + AES-256-GCM, no dependencies);
the passphrase is never taken from an argument or a pipe, and no secret is ever printed.

**Run `check` on the copy where it will live.** A backup nobody has restored is not a backup, it is
a file you hope is a backup: `check` decrypts it, derives the public key from the secret inside, and
confirms it matches. It writes nothing. On a new machine, `restore` writes the key back.

## Knowing it is alive

    node balance.mjs                       # what it holds, what it earned, how long the gas lasts
    journalctl -u prize-draw-crank -n 20 --no-pager

Set `HEARTBEAT_URL` and the bot pings it every 15 seconds, but only while every raffle's last pass
**finished, and got an answer to every read and send it made**. So an outage reaches you from
something that did not die with the machine. That covers a dead machine or network, and also a node
that has stopped answering or a raffle whose loop is stuck. It proves the bot is alive and reading
the chain, not that a particular round settled. `--once` pings only after a clean pass, and exits 1
otherwise.

## If a crank is down

Nothing here is privileged, so **anyone can finish the job by hand**, including you, from any
machine with a funded account. A dead crank delays a draw and cannot change a winner or strand the
money.

1. Where does the round stand? `(<ns>.prize-draw.draw-status "<raffle>" <round>)` over `/local`
   gives its `drand-round`, `beacon-at` (when drand publishes it) and `escape-from`.
2. Once `beacon-at` has passed, fetch the beacon:
   `https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/public/<drand-round>`
   and take its `signature`.
3. `(<ns>.prize-draw.preview "<raffle>" <round> "<signature>")` over `/local` shows who wins; then
   `(<ns>.prize-draw.draw "<raffle>" <round> "<your account>" "<signature>")`, and the drawer's
   share is yours.
4. Only if nobody has drawn it and the chain's time is past `escape-from` (90 days after the beacon
   was due) → `(<ns>.prize-draw.escape "<raffle>" <round>)`, then `claim-escape` per buyer, which
   refunds every ticket plus its share of the bonus.

Running a second crank on a different machine is the real fix, and it is why this repository is
public.

## Licence

Apache 2.0 — see `LICENSE` and `NOTICE`.
