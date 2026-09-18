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

## Running it

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

Add `--once` for a single pass. Generate a key with:

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
| `POLL_MS` / `MAX_SLEEP_MS` | the tight interval near an instant, and the cap on a long sleep |

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

## Licence

Apache 2.0 — see `LICENSE` and `NOTICE`.
