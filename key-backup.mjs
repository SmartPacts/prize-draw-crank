// key-backup.mjs — an encrypted, password-protected copy of this machine's signing key, and the
// drill that proves the copy works.
//
// WHY. The key is generated on this machine and never leaves it, which is what keeps it safe — and
// also what makes the machine a single point of failure. A dead disk takes the account's balance
// and everything it has earned with it, permanently: there is no seed phrase, no recovery, nothing
// to ask anyone for. This makes one file you can keep somewhere else.
//
//   node key-backup.mjs save    /etc/prize-draw/crank-key.json  crank-key.backup
//   node key-backup.mjs check   crank-key.backup
//   node key-backup.mjs restore crank-key.backup  /etc/prize-draw/crank-key.json
//
// `check` is the point. A backup nobody has restored is not a backup — it is a file you HOPE is a
// backup. `check` decrypts the blob in memory, derives the public key from the secret inside it,
// and confirms it matches the public key the blob names. It writes nothing and prints no secret,
// so you can run it any time, anywhere, including on the machine you are about to rebuild.
//
// WHAT IT NEVER DOES. It never prints a secret key, never takes the passphrase from the command
// line (arguments are visible to every process on the machine, and land in your shell history),
// and never writes a blob it has not just decrypted and compared. If the passphrase is lost the
// blob is gone — that is the trade, and it is the right way round: a backup anyone can read is
// worse than no backup, because it turns one stolen file into a stolen account.
//
// The crypto is Node's own, no dependencies: scrypt (N=2^16, r=8, p=1 — about 64 MB and a second
// of work per guess, which is what makes a human passphrase survive an offline attacker) and
// AES-256-GCM. The public key is stored in the clear and bound into the ciphertext as additional
// authenticated data, so you can tell two blobs apart without decrypting either, and neither can
// be passed off as the other.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { restoreKeyPairFromSecretKey } from '@kadena/cryptography-utils';

const KDF = { name: 'scrypt', N: 65536, r: 8, p: 1, keylen: 32, maxmem: 160 * 1024 * 1024 };
const die = (m) => { console.error(m); process.exit(1); };

// The passphrase is read from the terminal with echo off, and ONLY from a terminal: no argument,
// no environment variable, no pipe. Each of those would leave it somewhere it outlives this run —
// a shell history, a process list, a log. Raw mode is what suppresses the echo; `pending` keeps
// whatever arrived after the newline, so asking twice in a row cannot lose the second answer.
let pending = '';
function passphrase(prompt) {
  if (!process.stdin.isTTY) die('this must be run from a terminal: the passphrase is never taken from an argument, a pipe or the environment');
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = '';
    const finish = () => {
      process.stdin.setRawMode(false); process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(buf);
    };
    const eat = (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (c === '\n' || c === '\r' || c === '\u0004') { pending = chunk.slice(i + 1); finish(); return true; }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }        // Ctrl-C
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
      return false;
    };
    const onData = (chunk) => eat(String(chunk));
    const carried = pending; pending = '';
    if (carried && eat(carried)) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

// Both bots write the same two fields; the crank nests them under a persona name. Find them
// wherever they are rather than assuming one shape, and refuse anything else.
function findKey(obj) {
  if (obj && typeof obj === 'object') {
    if (typeof obj.publicKey === 'string' && typeof obj.secretKey === 'string') return obj;
    for (const v of Object.values(obj)) { const hit = findKey(v); if (hit) return hit; }
  }
  return null;
}
const readKeyFile = (p) => {
  if (!existsSync(p)) die(`no key file at ${p}`);
  const k = findKey(JSON.parse(readFileSync(p, 'utf8')));
  if (!k) die(`${p} holds no { publicKey, secretKey } pair`);
  if (!/^[0-9a-f]{64}$/.test(k.publicKey)) die(`${p}: public key is not 64 hex characters`);
  return k;
};
// The one check that makes a restore trustworthy: the secret in hand really does produce the
// public key we expect. Everything else is bookkeeping.
const derives = (secretKey, publicKey) => {
  try { return restoreKeyPairFromSecretKey(secretKey).publicKey === publicKey; }
  catch { return false; }
};

const [verb, a, b] = process.argv.slice(2);

if (verb === 'save') {
  if (!a) die('usage: node key-backup.mjs save <key-file> [out-file]');
  const out = b ?? `${a.split('/').pop()}.backup`;
  if (existsSync(out)) die(`REFUSING: ${out} already exists. Move it aside if you mean to replace it.`);
  const key = readKeyFile(a);
  if (!derives(key.secretKey, key.publicKey)) die(`${a}: the secret key does not produce its own public key — refusing to back up a file that is already wrong`);

  const p1 = await passphrase('passphrase (nothing is echoed): ');
  if (p1.length < 12) die('use at least 12 characters: this file is the account, and an offline attacker gets unlimited guesses');
  const p2 = await passphrase('again: ');
  if (p1 !== p2) die('the two passphrases differ; nothing was written');

  const salt = randomBytes(32), iv = randomBytes(12);
  const dk = scryptSync(p1, salt, KDF.keylen, KDF);
  const aad = Buffer.from(key.publicKey, 'utf8');
  const c = createCipheriv('aes-256-gcm', dk, iv);
  c.setAAD(aad);
  // The WHOLE FILE, verbatim — not just the key pair inside it. The crank reads its key from a
  // named persona (`{"crank": {...}}`) and the feeder reads a bare pair; restoring the inner
  // object would produce a file the bot cannot use, and the failure would only show up on the
  // machine where it is needed. A restore must reproduce what was saved, byte for byte.
  const ct = Buffer.concat([c.update(readFileSync(a, 'utf8'), 'utf8'), c.final()]);
  const blob = {
    format: 'kadena-bot-key-backup/1',
    publicKey: key.publicKey, account: `k:${key.publicKey}`,
    kdf: { ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  };

  // Never hand over a blob that has not just been proven to open. This is the same check `check`
  // runs, executed here so a bad write can never reach the place you keep it.
  const d = createDecipheriv('aes-256-gcm', dk, iv);
  d.setAAD(aad); d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const back = findKey(JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')));
  if (!back || back.secretKey !== key.secretKey || !derives(back.secretKey, key.publicKey)) die('the blob did not decrypt back to the same key; nothing was written');

  writeFileSync(out, JSON.stringify(blob, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`wrote      ${out} (mode 0600)`);
  console.log(`for        ${blob.account}`);
  console.log(`verified   it decrypts back to this key, and the secret inside derives that public key`);
  console.log('');
  console.log('Copy it OFF this machine — a backup on the disk it protects is not one — and keep the');
  console.log('passphrase somewhere else again. Then run `check` on the copy where it will live.');

} else if (verb === 'check' || verb === 'restore') {
  if (!a) die(`usage: node key-backup.mjs ${verb} <backup-file>${verb === 'restore' ? ' <key-file>' : ''}`);
  if (!existsSync(a)) die(`no backup at ${a}`);
  const blob = JSON.parse(readFileSync(a, 'utf8'));
  if (blob.format !== 'kadena-bot-key-backup/1') die(`${a}: not a key backup this tool wrote (format ${blob.format})`);
  console.log(`backup for ${blob.account ?? `k:${blob.publicKey}`}`);
  if (verb === 'restore' && !b) die('usage: node key-backup.mjs restore <backup-file> <key-file>');
  if (verb === 'restore' && existsSync(b)) die(`REFUSING: ${b} already exists. A running bot may be using it; move it aside yourself.`);

  const dk = scryptSync(await passphrase('passphrase: '), Buffer.from(blob.kdf.salt, 'base64'), blob.kdf.keylen ?? 32, { ...blob.kdf, salt: undefined, maxmem: KDF.maxmem });
  let plain;
  try {
    const d = createDecipheriv('aes-256-gcm', dk, Buffer.from(blob.iv, 'base64'));
    d.setAAD(Buffer.from(blob.publicKey, 'utf8'));
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    plain = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    die('WRONG PASSPHRASE, or this file has been altered.\n'
      + 'Those are the only two causes: the ciphertext carries an authentication tag, so a blob\n'
      + 'that has been changed by even one byte fails here exactly as a bad passphrase does.');
  }
  const key = findKey(JSON.parse(plain));
  if (!key || !derives(key.secretKey, blob.publicKey)) die('decrypted, but the secret inside does not produce this backup\'s public key — do not trust this file');

  if (verb === 'check') {
    console.log('OK         it opens, and the secret inside derives exactly that public key');
    console.log('           (nothing was written, and no secret was printed)');
  } else {
    writeFileSync(b, plain, { mode: 0o600, flag: 'wx' });
    console.log(`restored   ${b} (mode 0600) — chown it to the service user, then start the bot`);
  }

} else {
  console.error('usage:');
  console.error('  node key-backup.mjs save    <key-file> [out-file]   encrypt a copy, verified before it is written');
  console.error('  node key-backup.mjs check   <backup-file>           prove it opens — run this on the copy you keep');
  console.error('  node key-backup.mjs restore <backup-file> <key-file>  write the key back on a new machine');
  process.exit(2);
}
