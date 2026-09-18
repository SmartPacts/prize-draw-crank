// keygen.mjs — create the crank's signing key ON THE MACHINE THAT WILL RUN IT, and refuse to
// overwrite one that already exists.
//
// Same shape as block-history's feeder keygen, for the same reasons: overwriting a funded key
// file loses control of whatever that account holds, permanently, so this never does it. The
// existence check is backed by an exclusive-create write ('wx'), which also fails if a file
// appears between the check and the write. The file is 0600 inside a 0700 directory. Only the
// PUBLIC key and the account are printed; the secret never leaves the file, and never appears in
// a log, a terminal scrollback or a message to anyone.
//
//   node site/crank-keygen.mjs /opt/prize-draw/crank-key.json
//
// It lives beside crank.mjs because it shares the crank's dependencies: run it from there.
//
// The file it writes is the persona shape `crank.mjs` already reads, so the service runs with
//   DRAW_ACCOUNTS=/opt/prize-draw/crank-key.json  DRAW_BOT=crank
//
// FUND IT AFTERWARDS. The account printed here holds nothing when it is created. Send it a small
// amount of KDA on the raffle's chain once the machine is set up — a few KDA covers months of
// opening draws and settling them. Nothing else about this key is privileged: the crank holds no
// authority over any raffle, and every call it makes is one anybody could make.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { genKeyPair } from '@kadena/cryptography-utils';

const target = process.argv[2];
if (!target) {
  console.error('usage: node crank-keygen.mjs <path/to/crank-key.json>');
  process.exit(2);
}
const path = resolve(target);
if (existsSync(path)) {
  console.error(`REFUSING: ${path} already exists. Overwriting a key file loses control of the account it funds.`);
  console.error('Move it aside yourself if you are certain it holds nothing, then run this again.');
  process.exit(1);
}
const kp = genKeyPair();
if (!kp.secretKey || !/^[0-9a-f]{64}$/.test(kp.publicKey)) {
  console.error('key generation returned an unexpected shape; nothing was written');
  process.exit(1);
}
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(
  path,
  JSON.stringify({ crank: { account: `k:${kp.publicKey}`, publicKey: kp.publicKey, secretKey: kp.secretKey } }, null, 2) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(`key file   : ${path} (mode 0600)`);
console.log(`public key : ${kp.publicKey}`);
console.log(`account    : k:${kp.publicKey}`);
console.log('');
console.log('FUND THAT ACCOUNT on the raffle chain, then enable the service. Until it holds KDA the');
console.log('crank can read the chain but cannot pay for a single transaction.');
