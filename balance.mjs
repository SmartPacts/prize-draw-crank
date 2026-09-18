// balance.mjs — what this crank holds, what it has earned, and how long its gas lasts.
//
//     node balance.mjs                      # uses the same settings the service runs with
//     node balance.mjs k:<some other account>
//
// Read-only: it sends nothing and signs nothing, so it is safe to run at any time, including
// while the service is running. It reads the PUBLIC half of the key file only.
//
// Two accounts matter and they are deliberately different: the crank's own account pays gas, and
// the payee account receives what settling rounds earns. Keep the first small and the second
// somewhere you control — that is the whole point of DRAW_PAYEE.
import { readFileSync, existsSync } from 'node:fs';
import { createClient, Pact } from '@kadena/client';

const HOST = (process.env.DEVNET_HOST ?? 'https://chainweb.eckowallet.com').replace(/\/+$/, '');
const NETWORK = process.env.DEVNET_NETWORK_ID ?? 'mainnet01';
const CH = process.env.CHAIN_ID ?? '2';
const ACCTS = process.env.DRAW_ACCOUNTS ?? '/etc/prize-draw/crank-key.json';
const WHO = process.env.DRAW_BOT ?? 'crank';

// Measured on devnet: opening a draw costs ~191 gas and settling one ~980, at 1e-8 KDA per unit.
const PER_ROUND = 1171 * 1e-8;

function account(file, who) {
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const e = j[who] ?? (j.publicKey ? j : Object.values(j).find((v) => v && v.publicKey));
  return e?.account ?? (e?.publicKey ? `k:${e.publicKey}` : null);
}

const client = createClient(`${HOST}/chainweb/0.0/${NETWORK}/chain/${CH}/pact`);
async function balance(acct) {
  const tx = Pact.builder.execution(`(try "absent" (format "{}" [(coin.get-balance "${acct}")]))`)
    .setMeta({ chainId: CH, gasLimit: 1000, senderAccount: '' }).setNetworkId(NETWORK).createTransaction();
  const r = await client.local(tx, { preflight: false, signatureVerification: false });
  if (r.result.status !== 'success') throw new Error(JSON.stringify(r.result.error).slice(0, 160));
  return String(r.result.data).replace(/"/g, '');
}

const asked = process.argv[2];
const self = asked ?? account(ACCTS, WHO);
if (!self) {
  console.error(`no key file at ${ACCTS} (and no account given). Pass one: node balance.mjs k:…`);
  process.exit(2);
}
const payee = asked ? null : (process.env.DRAW_PAYEE ?? null);

console.log(`${NETWORK} chain ${CH}  via ${HOST}`);
const gas = await balance(self);
const n = Number(gas);
console.log(`  gas account  ${self}`);
console.log(`    ${gas} KDA${Number.isFinite(n) ? `  — about ${Math.floor(n / PER_ROUND).toLocaleString()} more rounds at measured cost` : ''}`);
if (payee && payee !== self) {
  console.log(`  earnings go to ${payee}`);
  console.log(`    ${await balance(payee)} KDA`);
} else {
  console.log('  earnings stay on the gas account (DRAW_PAYEE is not set)');
}
if (n === 0 || gas === 'absent') {
  console.log('\n  This account cannot pay for a transaction. The crank can read the chain but will');
  console.log('  settle nothing until it is funded.');
}
