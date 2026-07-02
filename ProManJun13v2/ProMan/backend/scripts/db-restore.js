// ── Restore an encrypted DB backup from S3 ───────────────────────────────────
// Reverses db-backup.js: download → openssl decrypt → pg_restore. Used for
// disaster recovery AND for periodic restore-tests (an untested backup is not a
// backup). Restoring into a live DB is destructive, so a target DB must be named
// explicitly with --into; without it, the script only decrypts to a local file.
//
//   node scripts/db-restore.js --latest --into proman_restore_test
//   node scripts/db-restore.js --key db-backups/proman_2026-06-30-....dump.enc --into scratch_db
//   node scripts/db-restore.js --latest            # just decrypt to ./restore.dump, no DB write
//
// Create the scratch DB first, e.g.:  createdb -U postgres proman_restore_test
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BACKUP_BUCKET;
const REGION = process.env.AWS_REGION;
const PASSPHRASE = process.env.BACKUP_ENCRYPTION_KEY;
const PG_RESTORE = process.env.PG_RESTORE_PATH || 'pg_restore';
const OPENSSL = process.env.OPENSSL_PATH || 'openssl';

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const useLatest = args.includes('--latest');
let key = getArg('--key');
const intoDb = getArg('--into');

function fail(m) { console.error('❌ ' + m); process.exit(1); }
if (!BUCKET) fail('S3_BACKUP_BUCKET not set');
if (!PASSPHRASE) fail('BACKUP_ENCRYPTION_KEY not set');
if (!key && !useLatest) fail('Pass --latest or --key <s3key>');

const s3 = new S3Client({ region: REGION });

async function findLatest() {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'db-backups/' }));
  const items = (r.Contents || []).filter(o => o.Key.endsWith('.dump.enc'));
  if (!items.length) fail('No backups found in the bucket.');
  items.sort((a, b) => b.LastModified - a.LastModified);
  return items[0].Key;
}

function pipeRestore(encFile, dumpFile) {
  return new Promise((resolve, reject) => {
    const dec = spawn(OPENSSL, ['enc', '-d', '-aes-256-cbc', '-pbkdf2',
      '-pass', 'env:BACKUP_ENCRYPTION_KEY', '-in', encFile, '-out', dumpFile],
      { env: { ...process.env } });
    let err = '';
    dec.stderr.on('data', d => (err += d));
    dec.on('error', e => reject(new Error(`openssl not available: ${e.message}`)));
    dec.on('close', c => c === 0 ? resolve() : reject(new Error(`decrypt failed (${c}): ${err.trim()} — wrong BACKUP_ENCRYPTION_KEY?`)));
  });
}

function pgRestore(dumpFile, db) {
  return new Promise((resolve, reject) => {
    const r = spawn(PG_RESTORE, ['--clean', '--if-exists', '--no-owner',
      '-h', process.env.DB_HOST || 'localhost', '-p', String(process.env.DB_PORT || 5432),
      '-U', process.env.DB_USER || 'postgres', '-d', db, dumpFile],
      { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' } });
    let err = '';
    r.stderr.on('data', d => (err += d));
    r.on('error', e => reject(new Error(`pg_restore not available: ${e.message}`)));
    // pg_restore may exit non-zero on harmless warnings; surface them but treat 0 as success.
    r.on('close', c => c === 0 ? resolve() : reject(new Error(`pg_restore exited ${c}: ${err.trim()}`)));
  });
}

(async () => {
  try {
    if (useLatest) { key = await findLatest(); console.log('Latest backup:', key); }
    const encFile = path.join(os.tmpdir(), path.basename(key));
    const dumpFile = intoDb ? path.join(os.tmpdir(), 'restore.dump') : path.join(process.cwd(), 'restore.dump');

    console.log('[1] downloading', key, '...');
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    await new Promise((res, rej) => {
      const w = fs.createWriteStream(encFile);
      obj.Body.pipe(w); obj.Body.on('error', rej); w.on('finish', res); w.on('error', rej);
    });
    console.log('    ✅ downloaded', (fs.statSync(encFile).size / 1024 / 1024).toFixed(2), 'MB');

    console.log('[2] decrypting...');
    await pipeRestore(encFile, dumpFile);
    console.log('    ✅ decrypted →', dumpFile);

    if (intoDb) {
      console.log(`[3] restoring into database "${intoDb}" (must already exist)...`);
      await pgRestore(dumpFile, intoDb);
      console.log('    ✅ restore complete');
      fs.unlinkSync(dumpFile);
    } else {
      console.log('\nNo --into given, so nothing was written to a database.');
      console.log('Decrypted dump saved at:', dumpFile);
      console.log('To restore it yourself:  pg_restore --clean --if-exists -U postgres -d <db> "' + dumpFile + '"');
    }
    fs.unlinkSync(encFile);
    console.log('\n🎉 Done.');
    process.exit(0);
  } catch (e) { fail(e.message); }
})();
