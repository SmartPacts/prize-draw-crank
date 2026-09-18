# prize-draw-crank

A bot that settles Prize Draw rounds on Kadena: at a round's advertised draw instant it opens the
draw, and the moment a candidate block is on record it sends the draw. If a round can never be
drawn it triggers the refund and pushes every buyer's money back.

**It holds no privilege, and that is the point.** Every call it makes — `open-draw`, `draw`,
`escape`, `claim-escape` — is permissionless: anybody can make them, and the contract gives the
sender no say in the outcome. The winner is a pure function of the round's key and the hash of a
block that nobody picked. A crank pays gas and gets the drawer's share of the round's fee, if the
raffle sets one.

**So run one.** More independent cranks means a draw cannot be delayed by one operator's bot dying,
and none of them can steer a result. This repository exists so that anyone can.

## How it decides when to act

It follows no blocks and polls nothing in a loop. A round's three instants — sales open, sales
close, the draw — are frozen into it by its first ticket, so the bot reads them and **sleeps until
the next moment that could need it**, waking to a tight poll only when that moment is close or a
candidate window is open. Watching four raffles, ten minutes of selling costs two wake-ups, and a
draw still goes out within about half a minute of its instant.

Two things it waits for, and nothing else:

- **a clock instant** it already knows — the draw moment, which it reads from the chain;
- **a candidate block being recorded**, which can only happen inside a window it can see coming.

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
    DRAW_ATTEST=off \
    node crank.mjs

Add `--once` for a single pass. If the contract is not deployed on that chain it stops at
`cannot read <namespace>.prize-draw` — it reads the deployed module to learn which block record
decides a round, and will not guess it. Generate a key with:

    node crank-keygen.mjs /etc/prize-draw/crank-key.json

which writes it at mode 0600 in a 0700 directory, refuses to overwrite an existing file, and prints
only the public key and the account. **Fund that account** on the raffle's chain — a few KDA lasts
months; opening a draw costs about 193 gas and a draw about 1,200.

### Settings

| variable | meaning |
|---|---|
| `DRAW_MAINNET` | must be `armed` to touch mainnet at all |
| `DEVNET_NETWORK_ID` / `DEVNET_HOST` / `CHAIN_ID` | the network, a node, and the chain the contract lives on |
| `DRAW_NS` | the contract's namespace; on mainnet it must be a principal namespace |
| `DRAW_ACCOUNTS` / `DRAW_BOT` | a JSON file of `{ "<name>": { account, publicKey, secretKey } }`, and which entry to sign with. **Must live outside this checkout.** |
| `DRAW_ATTEST` | `off` on mainnet by default: recording blocks is the block-history feeders' job, and the crank's is only to settle rounds |
| `DRAW_PAYEE` | **where your earnings go.** Any ordinary account — point it at a cold wallet and the hot key here only ever holds gas. Defaults to the bot's own account |
| `HEARTBEAT_URL` | a ping URL that alerts when the pings STOP. Without one, nothing tells you this bot has died |
| `POLL_MS` / `MAX_SLEEP_MS` | the tight interval near an instant, and the cap on a long sleep |

**Set these in `/etc/prize-draw/crank.env`, not in the unit file** — an update replaces the unit and
never touches that file. `crank.env.example` is a commented copy to start from.

**The mainnet interlocks are deliberate.** Against `mainnet01` the bot refuses to start unless every
one of them is set on purpose: armed, a real node, a principal namespace, and a key file outside the
checkout. None of them has a default that a devnet session could leave behind.

## Running it as a service

`prize-draw-crank.service` is a systemd unit with those interlocks pinned, an unprivileged user, a
read-only file system and a memory cap. Installing it does not start it — enabling it is what starts
sending transactions:

    systemctl enable --now prize-draw-crank
    journalctl -u prize-draw-crank -f

What to watch for: a round that stays unsettled past its draw instant. Anyone can open and settle it
by hand, so a dead crank delays a draw — it does not cancel one.

## What it cannot do

It cannot choose a winner, change a raffle, or move money anywhere the contract would not send it
anyway. It never holds the contract's admin or operator authority. The worst a stolen crank key
costs is the gas in its own account and a drawer's share of a fee.

It reads which block record the contract uses **from the deployed contract itself**, so it cannot
attest to a different record than the one a round settles from.

## Your earnings

Settling a round pays the drawer's share of that raffle's fee to an account **the draw names**, and
the contract takes any ordinary account. So set `DRAW_PAYEE` to somewhere you control and this
machine never holds what it earns — the key here stays a gas key, and the worst a stolen one costs
is the gas in it.

🔴 **The payee must already exist on the raffle's chain.** Payouts use a plain transfer, which does
not create an account, so an unfunded one would abort every draw. The bot checks at startup and
refuses to run rather than find out mid-round.

## Back up the key

The key is generated here and never leaves, which is what keeps it safe — and also what makes this
machine a single point of failure. There is no seed phrase to fall back on: a dead disk takes the
balance and everything earned with it.

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

Set `HEARTBEAT_URL` and the bot pings it after every pass in which it read the chain, so an outage
reaches you from something that did not die with the machine. It proves the bot is alive and reading
the chain — not that a particular round settled.

## If a crank is down

Nothing here is privileged, so **anyone can finish the job by hand**, including you, from any
machine with a funded account. A dead crank delays a draw; it cannot cancel one, change a winner, or
strand the money.

1. What state is the round in? `(<ns>.prize-draw.draw-status "<raffle>" <round>)` over `/local`.
2. Past its draw instant and not open → `(<ns>.prize-draw.open-draw "<raffle>" <round>)`.
3. A candidate recorded → `(<ns>.prize-draw.draw "<raffle>" <round> "<your account>")`, and the
   drawer's share is yours.
4. No candidate in the whole window, or nobody opened it within a day →
   `(<ns>.prize-draw.escape "<raffle>" <round>)`, then `claim-escape` per buyer, which refunds
   every ticket plus its share of the bonus.

Running a second crank on a different machine is the real fix, and it is why this repository is
public.

## Licence

Apache 2.0 — see `LICENSE` and `NOTICE`.
